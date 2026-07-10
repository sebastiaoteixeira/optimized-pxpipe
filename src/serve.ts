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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const MAX = 1024 * 1024;
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    bytes += b.byteLength;
    if (bytes > MAX) throw new Error("request body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
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
      const webRes = await handle(toWebRequest(req));
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
