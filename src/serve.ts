import { createServer } from "node:http";
import { createProxy } from "pxpipe-proxy/proxy";
import { setAllowedModelBases } from "pxpipe-proxy";
import { keepSharp } from "./guard.js";

const PORT = Number(process.env.PORT ?? 47821);
const HOST = "127.0.0.1";

// pxpipe only transforms allowlisted models; everything else passes through as
// text. Claude Code must run on a model listed here (or in PXPIPE_MODELS) for
// the guard to fire. Default to Fable 5, pxpipe's 100/100 reader.
const models = (process.env.PXPIPE_MODELS ?? "claude-fable-5")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
setAllowedModelBases(models);

const handler = createProxy({
  transform: () => ({ compress: true, keepSharp }),
  onRequest: ({ path, model, status, info }) => {
    if (!path.endsWith("/messages")) return;
    const pinned = info?.keptSharpBlocks ?? 0;
    const imgs = info?.imageCount ?? 0;
    console.log(
      `${status} ${model ?? "?"}  images=${imgs}  keptSharp=${pinned}` +
        (info?.reason ? `  (${info.reason})` : ""),
    );
  },
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    // @ts-expect-error Node requires duplex for streaming request bodies
    duplex: "half",
  });

  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}).listen(PORT, HOST, () => {
  console.log(`byte-exact guard proxy → http://${HOST}:${PORT}`);
  console.log(`imaging models: ${models.join(", ")}`);
  console.log(`point Claude Code at it:`);
  console.log(`  ANTHROPIC_BASE_URL=http://${HOST}:${PORT} claude`);
});
