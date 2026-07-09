import type { KeepSharpBlock } from "pxpipe-proxy";

/** Minimum token length before the entropy fallback considers a token. */
export const ENTROPY_MIN_TOKEN_LEN = 12;

/** Shannon entropy (bits/char) above which a long token is treated as byte-exact. */
export const ENTROPY_BITS_THRESHOLD = 3.5;

/** Regex families for content that must survive byte-exact. */
export const BYTE_EXACT_PATTERNS: readonly RegExp[] = [
  /\b[0-9a-f]{40}\b/, // git SHA-1 (40 hex)
  /\b[0-9a-fA-F]{8,}\b/, // hex runs >= 8 (covers md5/sha256/hex ids)
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/, // UUID
  /\b(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{20,}={0,2}\b/, // base64 runs >= 20 (must carry a digit/symbol, not a plain word)
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT (three long base64url segments)
  /\b\d{10,}\b/, // long digit runs >= 10
  /\b\d+\.\d+\.\d+\b/, // semantic version (x.y.z) — low-entropy but load-bearing
  /\b\d{3}(?:[-.\s]\d{2,4}){1,3}\b/, // grouped/formatted numbers (phone, contact ids)
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}\b/, // API key prefixes (OpenAI/Stripe style)
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, // GitHub tokens
  /\bAKIA[0-9A-Z]{12,}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
];

const shannonEntropy = (token: string): number => {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

const hasHighEntropyToken = (text: string): boolean =>
  text
    .split(/[^A-Za-z0-9+/=_-]+/)
    .some(
      (t) =>
        t.length >= ENTROPY_MIN_TOKEN_LEN &&
        // Opaque tokens carry a non-letter (digit/symbol); plain words don't.
        // This keeps the fallback off long natural-language words.
        /[^A-Za-z]/.test(t) &&
        shannonEntropy(t) >= ENTROPY_BITS_THRESHOLD,
    );

/** Pure detector: does `text` contain any byte-exact-critical token? */
export const hasByteExactContent = (text: string): boolean =>
  BYTE_EXACT_PATTERNS.some((re) => re.test(text)) || hasHighEntropyToken(text);

/** keepSharp predicate: pin any block whose text carries byte-exact content. */
export const keepSharp = (block: KeepSharpBlock): boolean =>
  hasByteExactContent(block.text);
