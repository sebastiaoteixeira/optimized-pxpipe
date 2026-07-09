import { transformAnthropicMessages } from "pxpipe-proxy";
import type { PxpipeTransformResult } from "pxpipe-proxy";
import { CORPUS } from "./corpus.js";
import { hasByteExactContent, keepSharp } from "./guard.js";
import { buildStageARequest, encodeRequest } from "./synthetic.js";

const MODEL = "claude-fable-5";
const PIXELS_PER_TOKEN = 750;
const CHARS_PER_TOKEN = 3.1;

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---- Stage A.1: accuracy over the labeled corpus, on both axes --------------
/** Score a boolean predictor against a boolean label over the corpus. */
const confusion = (
  predict: (text: string) => boolean,
  label: (b: (typeof CORPUS)[number]) => boolean,
) => {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  const mistakes: string[] = [];
  for (const b of CORPUS) {
    const p = predict(b.text);
    const y = label(b);
    if (p && y) tp++;
    else if (p && !y) {
      fp++;
      mistakes.push(`FALSE POSITIVE: ${b.text.slice(0, 68)}`);
    } else if (!p && !y) tn++;
    else {
      fn++;
      mistakes.push(`FALSE NEGATIVE: ${b.text.slice(0, 68)}`);
    }
  }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  return { tp, fp, tn, fn, precision, recall, f1, mistakes };
};

const reportMatrix = (
  title: string,
  m: ReturnType<typeof confusion>,
) => {
  console.log(title);
  console.log("             predicted+   predicted-");
  console.log(`actual+        TP=${m.tp}         FN=${m.fn}`);
  console.log(`actual-        FP=${m.fp}         TN=${m.tn}`);
  console.log(
    `precision=${m.precision.toFixed(3)}  recall=${m.recall.toFixed(3)}  f1=${m.f1.toFixed(3)}`,
  );
  if (m.mistakes.length) {
    console.log("misclassified:");
    for (const s of m.mistakes) console.log("  " + s);
  }
  console.log("");
};

const evaluateCorpus = () => {
  console.log("=== Stage A.1 — accuracy on labeled corpus ===\n");
  console.log(`Blocks: ${CORPUS.length}\n`);
  // Detector axis: does the syntax detector recognize machine-precise values?
  reportMatrix(
    "-- detector vs `exact` (is the value machine-precise?) --",
    confusion(hasByteExactContent, (b) => b.exact),
  );
  // Policy axis: does keepSharp pin exactly the blocks that must stay text?
  reportMatrix(
    "-- keepSharp vs `keepText` (should the guard pin it?) --",
    confusion((t) => keepSharp({ kind: "tool_result", text: t }), (b) => b.keepText),
  );
};

// ---- Stage A.2: retained savings on a large synthetic request ---------------
const imageTokens = (r: PxpipeTransformResult) =>
  (r.info.imagePixels ?? 0) / PIXELS_PER_TOKEN;

const runStageA2 = async () => {
  const req = buildStageARequest(MODEL);
  const body = encodeRequest(req);
  const compressibleChars = req.messages[0].content
    ? JSON.stringify(req.messages[0].content).length
    : 0;
  const baselineTextTokens = compressibleChars / CHARS_PER_TOKEN;

  const off = await transformAnthropicMessages({
    body,
    model: MODEL,
    options: { keepSharp: () => false },
  });
  const on = await transformAnthropicMessages({
    body,
    model: MODEL,
    options: { keepSharp },
  });

  const summarize = (label: string, r: PxpipeTransformResult) => {
    const imgTok = imageTokens(r);
    const remainingTextTokens =
      (compressibleChars - r.info.compressedChars) / CHARS_PER_TOKEN;
    const sent = imgTok + remainingTextTokens;
    return {
      label,
      applied: r.applied,
      reason: r.reason,
      imageCount: r.info.imageCount,
      imagePixels: r.info.imagePixels ?? 0,
      imageTokens: imgTok,
      keptSharp: r.info.keptSharpBlocks ?? 0,
      compressedChars: r.info.compressedChars,
      passthrough: r.info.passthroughReasons,
      sentTokens: sent,
      savings: baselineTextTokens - sent,
    };
  };

  const rOff = summarize("guard OFF", off);
  const rOn = summarize("guard ON", on);

  console.log("=== Stage A.2 — retained savings on large synthetic request ===\n");
  console.log(
    `synthetic request: ${req.messages[0].content && Array.isArray(req.messages[0].content) ? req.messages[0].content.length - 1 : 0} tool_result blocks, ` +
      `${fmt(compressibleChars)} compressible chars`,
  );
  console.log(
    `baseline (all as text @ ${CHARS_PER_TOKEN} cpt): ${fmt(baselineTextTokens)} tokens\n`,
  );

  const col = (v: string | number, w: number) => String(v).padStart(w);
  console.log(
    `${"arm".padEnd(12)}${col("applied", 9)}${col("reason", 16)}${col("imgs", 6)}${col("imgTok", 9)}${col("keptSharp", 11)}${col("sentTok", 10)}${col("savings", 10)}`,
  );
  for (const r of [rOff, rOn]) {
    console.log(
      `${r.label.padEnd(12)}${col(String(r.applied), 9)}${col(r.reason, 16)}${col(r.imageCount, 6)}${col(fmt(r.imageTokens), 9)}${col(r.keptSharp, 11)}${col(fmt(r.sentTokens), 10)}${col(fmt(r.savings), 10)}`,
    );
  }

  const guardCost = rOn.sentTokens - rOff.sentTokens;
  console.log("");
  console.log(
    `guard cost (tokens the guard gives up vs OFF): ${fmt(guardCost)} tokens`,
  );
  console.log(
    `guard retains ${((rOn.savings / rOff.savings) * 100).toFixed(1)}% of OFF's savings ` +
      `while pinning ${rOn.keptSharp} byte-exact block(s) as text.`,
  );
  console.log("\npassthrough reasons:");
  console.log(`  OFF: ${JSON.stringify(rOff.passthrough ?? {})}`);
  console.log(`  ON : ${JSON.stringify(rOn.passthrough ?? {})}`);
};

const main = async () => {
  evaluateCorpus();
  await runStageA2();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
