import { randomBytes, randomUUID } from "node:crypto";
import { transformAnthropicMessages } from "pxpipe-proxy";
import { postMessages, responseText } from "./anthropic.js";
import { makeToolResultText, makeSystemSlab } from "./synthetic.js";
import { keepSharp } from "./guard.js";

const MODEL = "claude-fable-5";
const N_REQUESTS = 10;
const TOKENS_PER_REQUEST = 5;
const CHARS_PER_BLOCK = 9000;
const PIXELS_PER_TOKEN = 750;

const freshToken = (): string => {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) return randomUUID();
  if (kind === 1) return randomBytes(20).toString("hex");
  return "sk-" + randomBytes(16).toString("base64url");
};

interface Probe {
  tokens: string[];
  body: Uint8Array;
  imageTokens: number;
}

const buildProbe = async (guardOn: boolean): Promise<Probe> => {
  const tokens = Array.from({ length: TOKENS_PER_REQUEST }, freshToken);
  const prose = makeToolResultText(CHARS_PER_BLOCK, false);
  const lines = prose.split("\n");
  tokens.forEach((tok, i) => {
    const at = Math.floor(((i + 1) / (tokens.length + 1)) * lines.length);
    lines.splice(at, 0, `MARKER_${i}: ${tok}`);
  });
  const embedded = lines.join("\n");

  const req = {
    model: MODEL,
    max_tokens: 1024,
    system: makeSystemSlab(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "The tool output below contains lines of the form 'MARKER_i: <token>'. " +
              "Reproduce EACH token verbatim, one per line, as 'MARKER_i: <token>'. Copy exactly.",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_probe",
            content: [{ type: "text", text: embedded }],
          },
        ],
      },
    ],
  };

  const { body, info } = await transformAnthropicMessages({
    body: new TextEncoder().encode(JSON.stringify(req)),
    model: MODEL,
    options: { keepSharp: guardOn ? keepSharp : () => false },
  });
  return { tokens, body, imageTokens: (info.imagePixels ?? 0) / PIXELS_PER_TOKEN };
};

const scoreRecall = (answer: string, tokens: string[]): number =>
  tokens.filter((t) => answer.includes(t)).length;

const runArm = async (guardOn: boolean, apiKey: string) => {
  let matched = 0;
  let total = 0;
  let imageTokens = 0;
  for (let i = 0; i < N_REQUESTS; i++) {
    const { tokens, body, imageTokens: it } = await buildProbe(guardOn);
    imageTokens += it;
    const answer = responseText(await postMessages(body, apiKey));
    matched += scoreRecall(answer, tokens);
    total += tokens.length;
  }
  return { recall: matched / total, matched, total, imageTokens };
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

  console.log(`=== Stage B — live verbatim recall (${N_REQUESTS} requests) ===\n`);
  const off = await runArm(false, apiKey);
  const on = await runArm(true, apiKey);

  const pct = (n: number) => (n * 100).toFixed(1) + "%";
  console.log(
    `guard OFF: verbatim recall ${pct(off.recall)} (${off.matched}/${off.total}), ` +
      `image tokens ${off.imageTokens.toFixed(0)}`,
  );
  console.log(
    `guard ON : verbatim recall ${pct(on.recall)} (${on.matched}/${on.total}), ` +
      `image tokens ${on.imageTokens.toFixed(0)}`,
  );
  console.log(
    `\nrecall recovered by the guard: +${pct(on.recall - off.recall)} at a cost of ` +
      `${(off.imageTokens - on.imageTokens).toFixed(0)} fewer imaged tokens.`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
