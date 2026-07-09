import { randomBytes, randomUUID } from "node:crypto";
import { transformAnthropicMessages } from "pxpipe-proxy";
import { postMessages, responseText } from "./anthropic.js";
import { makeToolResultText, makeSystemSlab } from "./synthetic.js";
import { keepSharp } from "./guard.js";

const MODEL = "claude-fable-5";
const N_REQUESTS = 5;
const BLOCK_COUNT = 8; // half carry embedded tokens, half are pure prose
const TOKENS_PER_SECRET_BLOCK = 2;
const CHARS_PER_BLOCK = 9000;
const CHARS_PER_TOKEN = 3.1;
const PIXELS_PER_TOKEN = 750;

/** Fresh, unmemorizable, guard-detectable tokens: UUID, 40-hex, sk-hex. */
const freshToken = (): string => {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) return randomUUID();
  if (kind === 1) return randomBytes(20).toString("hex");
  return "sk-" + randomBytes(18).toString("hex");
};

interface Probe {
  tokens: string[];
  body: Uint8Array;
  imageTokens: number;
  imagedSourceChars: number;
  keptSharp: number;
}

/** A representative request: BLOCK_COUNT tool_results, even-indexed ones carry
 *  embedded MARKER tokens (the guard should pin these), odd ones are pure prose
 *  (imaged in both arms). Mirrors real traffic where only some blocks are exact. */
const buildProbe = async (guardOn: boolean): Promise<Probe> => {
  const tokens: string[] = [];
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, b) => {
    const lines = makeToolResultText(CHARS_PER_BLOCK, false).split("\n");
    if (b % 2 === 0) {
      for (let k = 0; k < TOKENS_PER_SECRET_BLOCK; k++) {
        const tok = freshToken();
        const i = tokens.push(tok) - 1;
        const at = Math.floor(((k + 1) / (TOKENS_PER_SECRET_BLOCK + 1)) * lines.length);
        lines.splice(at, 0, `MARKER_${i}: ${tok}`);
      }
    }
    return {
      type: "tool_result",
      tool_use_id: `toolu_${b}`,
      content: [{ type: "text", text: lines.join("\n") }],
    };
  });

  const req = {
    model: MODEL,
    max_tokens: 2048,
    system: makeSystemSlab(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "The tool outputs below contain lines 'MARKER_i: <token>'. " +
              "Reproduce EACH token verbatim, one per line as 'MARKER_i: <token>'. " +
              "Copy exactly; do not guess if unsure.",
          },
          ...blocks,
        ],
      },
    ],
  };

  const { body, info } = await transformAnthropicMessages({
    body: new TextEncoder().encode(JSON.stringify(req)),
    model: MODEL,
    options: { keepSharp: guardOn ? keepSharp : () => false },
  });
  return {
    tokens,
    body,
    imageTokens: (info.imagePixels ?? 0) / PIXELS_PER_TOKEN,
    imagedSourceChars: info.compressedChars,
    keptSharp: info.keptSharpBlocks ?? 0,
  };
};

type Verdict = "exact" | "confabulated" | "missing";

/** Classify recall of one token: exact copy, a wrong value (silent loss), or
 *  absent/abstained (honest loss). */
const classify = (answer: string, i: number, tok: string): Verdict => {
  if (answer.includes(tok)) return "exact";
  const m = answer.match(new RegExp(`MARKER_${i}\\s*[:=]?\\s*(\\S+)`));
  return m && m[1] && m[1] !== tok ? "confabulated" : "missing";
};

interface ArmResult {
  exact: number;
  confabulated: number;
  missing: number;
  total: number;
  imageTokens: number;
  savedTokens: number;
  keptSharp: number;
}

const runArm = async (guardOn: boolean, apiKey: string): Promise<ArmResult> => {
  const r: ArmResult = {
    exact: 0,
    confabulated: 0,
    missing: 0,
    total: 0,
    imageTokens: 0,
    savedTokens: 0,
    keptSharp: 0,
  };
  for (let n = 0; n < N_REQUESTS; n++) {
    const probe = await buildProbe(guardOn);
    const answer = responseText(await postMessages(probe.body, apiKey));
    probe.tokens.forEach((tok, i) => {
      r.total++;
      r[classify(answer, i, tok)]++;
    });
    r.imageTokens += probe.imageTokens;
    r.savedTokens += probe.imagedSourceChars / CHARS_PER_TOKEN - probe.imageTokens;
    r.keptSharp += probe.keptSharp;
  }
  return r;
};

const main = async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "ANTHROPIC_API_KEY is not set. Stage B needs a live API key.\n" +
        "Set it and re-run: ANTHROPIC_API_KEY=sk-... npm run stage-b",
    );
    process.exit(0);
  }

  console.log(
    `=== Stage B — base pxpipe vs guard: tokens saved vs data loss ===\n` +
      `${N_REQUESTS} requests x ${BLOCK_COUNT} blocks, model ${MODEL}\n`,
  );
  const off = await runArm(false, apiKey);
  const on = await runArm(true, apiKey);

  const pct = (n: number, d: number) => ((100 * n) / (d || 1)).toFixed(1) + "%";
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const c = (v: string | number, w: number) => String(v).padStart(w);

  console.log(
    `${"arm".padEnd(14)}${c("savedTok", 10)}${c("keptSharp", 11)}` +
      `${c("exact", 8)}${c("confab", 8)}${c("missing", 9)}${c("dataLoss", 10)}`,
  );
  const row = (label: string, r: ArmResult) =>
    console.log(
      `${label.padEnd(14)}${c(fmt(r.savedTokens), 10)}${c(r.keptSharp, 11)}` +
        `${c(pct(r.exact, r.total), 8)}${c(pct(r.confabulated, r.total), 8)}` +
        `${c(pct(r.missing, r.total), 9)}${c(pct(r.confabulated + r.missing, r.total), 10)}`,
    );
  row("base pxpipe", off);
  row("+ guard", on);

  console.log(
    `\nguard recovers ${pct(on.exact - off.exact, off.total)} more verbatim tokens ` +
      `and eliminates ${off.confabulated} silent confabulation(s),\n` +
      `at a cost of ${fmt(off.savedTokens - on.savedTokens)} tokens of saving ` +
      `(${pct(on.savedTokens, off.savedTokens)} of base pxpipe's savings retained).`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
