import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createProxy } from "pxpipe-proxy/proxy";
import { setAllowedModelBases } from "pxpipe-proxy";
import {
  DashboardState,
  dashboardPath,
  type DashboardRoute,
} from "../node_modules/pxpipe-proxy/dist/dashboard.js";
import { toTrackEvent } from "../node_modules/pxpipe-proxy/dist/core/tracker.js";
import { keepSharp } from "./guard.js";
import { rescaleStatsUsd, rescaleStatsObject } from "./pricing.js";

/** Most-recently-seen upstream model id. Drives the dashboard's dollar-figure
 *  pricing (see rescaleStatsUsd). Level 1 assumes a session is effectively
 *  single-model, so last-seen is sufficient; falsy ids never regress it.
 *  Seeded from the persisted log at startup (see lastLoggedModel) so the
 *  full-history aggregate isn't mispriced at the flat fallback after a
 *  restart, then updated live by onRequest. */
let activeModel: string | null = null;

const port = Number(process.env.PORT ?? 47899);
const host = process.env.HOST ?? "127.0.0.1";
const anthropicUpstream =
  process.env.ANTHROPIC_UPSTREAM ??
  process.env.PXPIPE_UPSTREAM ??
  "https://api.anthropic.com";
const eventsFile =
  process.env.PXPIPE_LOG ?? path.join(os.homedir(), ".pxpipe", "events.jsonl");

// pxpipe only transforms allowlisted models; everything else passes through as
// text. Claude Code must run on a model listed here for the guard to fire.
const models = (process.env.PXPIPE_MODELS ?? "claude-fable-5")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
setAllowedModelBases(models);

/** Minimal fd-based JSONL appender for the tracker sink. */
class FileTracker {
  private fd: number | null = null;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): boolean {
    if (this.fd != null) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.fd = fs.openSync(this.filePath, "a");
      return true;
    } catch (err) {
      console.error(`[guard] tracker disabled: ${(err as Error).message}`);
      return false;
    }
  }

  emit(ev: unknown): void {
    if (!this.ensureOpen()) return;
    fs.writeSync(this.fd!, JSON.stringify(ev) + "\n");
  }

  close(): void {
    if (this.fd == null) return;
    try {
      fs.fsyncSync(this.fd);
    } catch {
      /* best effort */
    }
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

function toWebRequest(req: IncomingMessage): Request {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const url = `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? new ReadableStream({
        start(controller) {
          req.on("data", (chunk) => controller.enqueue(chunk));
          req.on("end", () => controller.close());
          req.on("error", (e) => controller.error(e));
        },
      })
    : undefined;
  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? "half" : undefined,
  });
}

function isConnectionAbort(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const name = e?.name ?? "";
  const code = e?.code ?? e?.cause?.code ?? "";
  const message = e?.message ?? "";
  const causeMessage = e?.cause?.message ?? "";
  return (
    name === "AbortError" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    message === "client response closed" ||
    message === "terminated" ||
    message.includes("aborted") ||
    causeMessage.includes("other side closed")
  );
}

async function waitForDrain(out: ServerResponse): Promise<void> {
  const event = await Promise.race([
    once(out, "drain").then(() => "drain"),
    once(out, "close").then(() => "close"),
  ]);
  if (event === "close") throw new Error("client response closed");
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  let finished = false;
  const cancelBody = () => {
    if (!finished) void reader.cancel().catch(() => undefined);
  };
  out.once("close", cancelBody);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !out.write(value)) await waitForDrain(out);
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (isConnectionAbort(err) || out.destroyed || out.writableEnded) {
      if (!out.destroyed && !out.writableEnded)
        out.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  } finally {
    finished = true;
    out.off("close", cancelBody);
    reader.releaseLock();
  }
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<string> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    bytes += b.byteLength;
    if (bytes > maxBytes) throw new Error("request body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- Auto-mode classifier bypass ----------------------------------------------
// Claude Code's "auto" permission mode runs a command-safety classifier as a
// separate Messages call that expects a terse `</block>`-terminated XML verdict.
// If pxpipe images that request, the weak, tiny-budget classifier reads pixels
// instead of text, overruns its `max_tokens` before closing the tag, and Claude
// Code fails CLOSED ("Auto mode could not evaluate this action"). The fix is to
// send classifier/auxiliary calls AROUND pxpipe's imaging — straight to the
// upstream API as plain text — and to retry transient upstream errors, since
// those also make the classifier fail closed.

/** Transient upstream statuses worth retrying. Auth (401) and client/4xx are
 *  excluded — retrying won't change their outcome. */
const RETRYABLE_UPSTREAM = new Set([429, 502, 503, 529]);
const AUX_RETRY_MAX = 3;
/** Generous cap for buffering a /v1/messages body to inspect it. A classifier
 *  call can carry a full transcript (~100 KB+), so this must exceed the main
 *  loop's request size; it only guards against pathological bodies. */
const FORWARD_BUFFER_LIMIT = 8 * 1024 * 1024;

/** Detect a retry-safe auxiliary Messages call. Primary target is Claude Code's
 *  auto-mode command-safety classifier, whose wire fingerprint is first-party
 *  (from the CC 2.1.x binary): a `</block>` stop sequence on the XML stage,
 *  and/or the distinctive permissions-rules system prompt (`skipSystemPromptPrefix`,
 *  `<permissions_template>`, `soft_deny`/`hard_deny`). Falls back to the generic
 *  "tool-less, tiny output" shape for the fast stage and short title/topic
 *  helpers. All of these fail CLOSED on a non-200 and are idempotent, so they
 *  are safe to retry. */
function isRetriableAuxiliary(body: string): boolean {
  try {
    const j = JSON.parse(body) as {
      tools?: unknown;
      max_tokens?: unknown;
      stop_sequences?: unknown;
      system?: unknown;
    };
    const stops = Array.isArray(j.stop_sequences) ? j.stop_sequences : [];
    if (stops.includes("</block>")) return true;

    const sys =
      typeof j.system === "string"
        ? j.system
        : Array.isArray(j.system)
          ? j.system
              .map((b) =>
                b && typeof b === "object" ? ((b as { text?: string }).text ?? "") : "",
              )
              .join(" ")
          : "";
    if (/permissions_template|soft_deny|hard_deny/.test(sys)) return true;

    const noTools = !Array.isArray(j.tools) || j.tools.length === 0;
    const tinyOutput = typeof j.max_tokens === "number" && j.max_tokens <= 512;
    return noTools && tinyOutput;
  } catch {
    return false;
  }
}

/** Rebuild a web Request from a buffered body so the call can be retried (a
 *  streamed IncomingMessage body can only be read once). Content-Length is
 *  dropped so undici recomputes it from the buffer. */
function webRequestFromBody(req: IncomingMessage, body: string): Request {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const url = `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || k.toLowerCase() === "content-length") continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }
  return new Request(url, { method: req.method ?? "POST", headers, body });
}

/** Forward a call straight to the upstream API, bypassing pxpipe entirely so it
 *  is NEVER imaged — the whole point for the classifier, whose terse XML output
 *  imaging corrupts. Auth and other headers pass through untouched;
 *  content-length/host/connection are dropped so fetch recomputes them. */
async function forwardDirect(
  req: IncomingMessage,
  body: string,
): Promise<Response> {
  const url = anthropicUpstream.replace(/\/+$/, "") + (req.url ?? "/");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (v == null || lk === "content-length" || lk === "host" || lk === "connection")
      continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }
  try {
    const res = await fetch(url, { method: req.method ?? "POST", headers, body });
    // undici transparently DECOMPRESSES the response body but leaves the
    // `content-encoding` and (compressed) `content-length` headers in place.
    // Forwarding those verbatim with the already-decoded body makes the client
    // double-decode → corruption. Drop them so the passthrough is faithful; the
    // body is re-streamed and Node sets framing itself.
    const outHeaders = new Headers(res.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    console.error(`[guard]   direct fetch threw: ${(err as Error).message}`);
    return new Response("upstream fetch failed", { status: 502 });
  }
}

/** Forward to upstream. Auto-mode classifier / short auxiliary Messages calls
 *  are detected and sent AROUND pxpipe's imaging (which corrupts their terse
 *  XML output → auto mode fails closed), retrying transient errors. Everything
 *  else goes through the normal imaging pipeline. Detection needs the body, and
 *  a classifier call can carry a full transcript, so /v1/messages POSTs are
 *  buffered; an oversize/unreadable body (pathological) is reported rather than
 *  half-streamed. */
async function forwardWithRetry(req: IncomingMessage): Promise<Response> {
  const method = req.method ?? "GET";
  const path = req.url ?? "/";
  if (method !== "POST" || !path.includes("/v1/messages")) {
    return handle(toWebRequest(req));
  }

  let body: string;
  try {
    body = await readRequestBody(req, FORWARD_BUFFER_LIMIT);
  } catch {
    return new Response("request body too large to inspect", { status: 413 });
  }

  if (!isRetriableAuxiliary(body)) {
    return handle(webRequestFromBody(req, body));
  }

  console.log(
    `[guard] auto-mode/aux call → direct passthrough, no imaging (${Math.round(body.length / 1024)}KB)`,
  );
  let res = await forwardDirect(req, body);
  for (
    let attempt = 1;
    attempt <= AUX_RETRY_MAX && RETRYABLE_UPSTREAM.has(res.status);
    attempt++
  ) {
    console.warn(`[guard]   direct ${res.status}; retry ${attempt}/${AUX_RETRY_MAX}`);
    void res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150 * attempt));
    res = await forwardDirect(req, body);
  }
  if (res.status >= 400) {
    const detail = await res
      .clone()
      .text()
      .catch(() => "");
    console.error(`[guard]   direct failed ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res;
}

async function dispatchDashboard(
  dashboard: DashboardState,
  route: DashboardRoute,
  req: IncomingMessage,
  url: URL,
  port: number,
  model: string | null,
): Promise<Response | undefined> {
  const method = req.method ?? "GET";
  switch (route.kind) {
    case "html":
      if (method !== "GET") return undefined;
      return dashboard.serveHtml(port);
    case "stats":
      if (method !== "GET") return undefined;
      // serveStats() computes every $ figure at the dependency's flat rate;
      // rescale them to the model that actually served traffic.
      return rescaleStatsUsd(dashboard.serveStats(), model);
    case "recent":
      if (method !== "GET") return undefined;
      return dashboard.serveRecent();
    case "png": {
      if (method !== "GET") return undefined;
      const idRaw = url.searchParams.get("id");
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.servePng(Number.isFinite(idNum) ? idNum : undefined);
    }
    case "api-image-source": {
      if (method !== "GET") return undefined;
      const idRaw = url.searchParams.get("id");
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.serveImageSource(
        Number.isFinite(idNum) ? idNum : undefined,
      );
    }
    case "api-sessions":
      if (method !== "GET") return undefined;
      return dashboard.serveSessionsJson({
        project: url.searchParams.get("project") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
      });
    case "api-stats":
      if (method !== "GET") return undefined;
      return dashboard.serveApiStats();
    case "current-session":
      if (method !== "GET") return undefined;
      return dashboard.serveCurrentSessionJson();
    case "fragment": {
      if (route.name === "toggle" && method === "POST") {
        let enabled = false;
        try {
          const raw = await readRequestBody(req);
          try {
            enabled = JSON.parse(raw).enabled === true;
          } catch {
            enabled = new URLSearchParams(raw).get("enabled") === "true";
          }
        } catch {
          return new Response("bad request body", { status: 400 });
        }
        dashboard.handleCompressionToggle({ enabled });
        return dashboard.serveFragment("toggle", url, port);
      }
      if (route.name === "models" && method === "POST") {
        let model = "";
        let on = false;
        try {
          const raw = await readRequestBody(req);
          try {
            const j = JSON.parse(raw);
            model = typeof j.model === "string" ? j.model : "";
            on = j.on === true;
          } catch {
            const p = new URLSearchParams(raw);
            model = p.get("model") ?? "";
            on = p.get("on") === "true";
          }
        } catch {
          return new Response("bad request body", { status: 400 });
        }
        if (model) dashboard.handleModelsToggle(model, on);
        return dashboard.serveFragment("models", url, port);
      }
      if (method !== "GET") return undefined;
      return dashboard.serveFragment(route.name, url, port);
    }
    case "api-compression": {
      if (method !== "POST") {
        return new Response(JSON.stringify({ error: "use POST" }), {
          status: 405,
          headers: { "content-type": "application/json" },
        });
      }
      let body: { enabled?: unknown } = {};
      try {
        const raw = await readRequestBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: "bad request body",
            detail: (e as Error).message,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return dashboard.handleCompressionToggle({ enabled: body.enabled });
    }
  }
}

/** Scan the persisted event log for the most recent event carrying a model id.
 *  replay() rebuilds the full-history aggregate that /stats serves but never
 *  runs onRequest, so without this a fresh process would price all of that
 *  history at the flat fallback until the first live request. Best-effort:
 *  returns null if the file is absent/unreadable or has no usable model. */
function lastLoggedModel(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as { model?: unknown };
      if (typeof ev.model === "string" && ev.model.length > 0) return ev.model;
    } catch {
      /* skip malformed line and keep scanning older ones */
    }
  }
  return null;
}

/**
 * Level 1 model-adaptive pricing, applied at the source.
 *
 * The dependency's own HTML fragments (`header`, `session-summary`) read their
 * dollar figures from `this.serveStats().json()` internally (dashboard.js), so
 * rescaling only the HTTP `/stats` Response would leave the rendered dashboard
 * tiles showing the flat Fable-5 rate while the JSON endpoint reads correct —
 * exactly the "still not working" split. We patch `serveStats` on the instance
 * so every consumer, HTTP route and server-rendered HTML alike, sees numbers
 * priced at the model that actually served traffic.
 *
 * Only `.json()` is overridden; `.clone()`, `.text()`, `.body` etc. pass
 * through to the untouched flat-rate Response. That's exactly what the HTTP
 * `/stats` route wants: it re-derives a fully serialised body via
 * `rescaleStatsUsd`, which reads the body through `.clone().json()` and so
 * rescales exactly once. `getModel` is read at call time, so late-arriving
 * `onRequest` events are always reflected.
 */
function installModelAdaptivePricing(
  dash: DashboardState,
  getModel: () => string | null,
): void {
  const orig = dash.serveStats.bind(dash);
  dash.serveStats = function (): Response {
    const res = orig();
    return new Proxy(res, {
      get(target, prop) {
        if (prop === "json") {
          return async () =>
            rescaleStatsObject(
              (await target.json()) as Record<string, unknown>,
              getModel(),
            );
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

const tracker = new FileTracker(eventsFile);
const sidecarDir = path.join(path.dirname(eventsFile), "4xx-bodies");
const dashboard = new DashboardState({ eventsFile, sidecarDir });
await dashboard.replay(eventsFile).catch(() => undefined);
// Seed pricing from persisted history so the aggregate /stats serves isn't
// flat-priced after a restart; live onRequest events take over from here.
activeModel = lastLoggedModel(eventsFile) ?? activeModel;
// Rescale at the source: the dependency's HTML fragments read their dollar
// figures from `this.serveStats().json()` internally, so patching only the
// HTTP /stats Response would leave the rendered tiles flat-priced. See
// installModelAdaptivePricing.
installModelAdaptivePricing(dashboard, () => activeModel);

const config = {
  upstream: anthropicUpstream,
  // The whole point: our byte-exact guard is injected here, and the
  // dashboard kill switch (compression toggle) still gates the pipeline.
  transform: () =>
    dashboard.getCompressionEnabled() ? { keepSharp } : { compress: false },
  onRequest: async (e: import("pxpipe-proxy/proxy").ProxyEvent) => {
    dashboard.update(e);
    // Remember which model served this event so the dashboard prices its
    // dollar figures at that model's rate. Last-seen wins; falsy ids ignored.
    if (typeof e.model === "string" && e.model.length > 0) activeModel = e.model;
    if (e.path.endsWith("/messages")) {
      console.log(
        `${e.status} ${e.model ?? "?"}  images=${e.info?.imageCount ?? 0}` +
          `  keptSharp=${e.info?.keptSharpBlocks ?? 0}` +
          (e.info?.reason ? `  (${e.info.reason})` : ""),
      );
    }
    tracker.emit(toTrackEvent(e));
  },
};

const handle = createProxy(config);

const server = createServer((req, res) => {
  Promise.resolve()
    .then(async () => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const route = dashboardPath(url.pathname);
      if (route) {
        const r = await dispatchDashboard(
          dashboard,
          route,
          req,
          url,
          port,
          activeModel,
        );
        if (r) {
          await writeWebResponse(r, res);
          return;
        }
      }
      const webRes = await forwardWithRetry(req);
      await writeWebResponse(webRes, res);
    })
    .catch((err) => {
      console.error("[guard] handler error:", err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
});

server.listen(port, host, () => {
  console.log(`byte-exact guard proxy + pxpipe dashboard`);
  console.log(`  dashboard  → http://${host}:${port}/`);
  console.log(`  upstream   → ${anthropicUpstream}`);
  console.log(`  events     → ${eventsFile}`);
  console.log(`  imaging    → ${models.join(", ")}`);
  console.log(`point Claude Code at it:`);
  console.log(
    `  ANTHROPIC_BASE_URL=http://${host}:${port} claude`,
  );
});

const shutdown = (sig: string) => {
  console.log(`\n[guard] ${sig} — shutting down`);
  tracker.close();
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 1500).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
