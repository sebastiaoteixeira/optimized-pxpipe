import { CORPUS } from "./corpus.js";
import { hasByteExactContent } from "./guard.js";

const PROSE = CORPUS.filter(
  (b) => !b.byteExact && !hasByteExactContent(b.text),
).map((b) => b.text);
const SECRETS = CORPUS.filter((b) => b.byteExact).map((b) => b.text);

/** Token-dense long-line content (log/JSON shaped) so imaging is profitable —
 *  pxpipe passes short-line prose through as `not_profitable`. When `withSecrets`,
 *  byte-exact tokens are interleaved inline, mimicking real structured tool output. */
export const makeToolResultText = (chars: number, withSecrets: boolean): string => {
  const lines: string[] = [];
  let i = 0;
  while (lines.join("\n").length < chars) {
    const prose = `${PROSE[i % PROSE.length]} ${PROSE[(i + 1) % PROSE.length]}`;
    lines.push(`{"seq":${i},"level":"info","msg":"${prose}"}`);
    if (withSecrets && i % 4 === 0) lines.push(SECRETS[i % SECRETS.length]);
    i++;
  }
  return lines.join("\n");
};

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
}

/** Static system slab of pure prose — needed to clear pxpipe's slab gate
 *  (minCompressChars) so the tool_result compression path runs at all. */
export const makeSystemSlab = (chars = 3000): string =>
  makeToolResultText(chars, false);

/** One large request whose tool_result blocks interleave prose with byte-exact
 *  tokens. Half the blocks carry secrets (guard should pin them), half are pure prose. */
export const buildStageARequest = (
  model: string,
  blockCount = 8,
  charsPerBlock = 9000,
): AnthropicRequest => {
  const toolResults = Array.from({ length: blockCount }, (_, i) => ({
    type: "tool_result",
    tool_use_id: `toolu_${i.toString().padStart(4, "0")}`,
    content: [
      { type: "text", text: makeToolResultText(charsPerBlock, i % 2 === 0) },
    ],
  }));

  return {
    model,
    max_tokens: 256,
    system: makeSystemSlab(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize the tool outputs below." },
          ...toolResults,
        ],
      },
    ],
  };
};

export const encodeRequest = (req: AnthropicRequest): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(req));
