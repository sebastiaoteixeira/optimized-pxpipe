export interface CorpusBlock {
  readonly text: string;
  readonly byteExact: boolean;
}

/** Labeled blocks for Stage A. Positives carry byte-exact content that would be
 *  silently confabulated if OCR'd; negatives are safe to compress. Includes hard
 *  cases (version strings, hex colors, random-looking English) on both sides. */
export const CORPUS: readonly CorpusBlock[] = [
  // ---- positives -----------------------------------------------------------
  {
    byteExact: true,
    text: `{"user_id":"a3f9c1e2-7b4d-4c8a-9f21-0e5d6a7b8c9d","balance":42099}`,
  },
  {
    byteExact: true,
    text: `commit 9f2a1c4e8b7d6053a1e2f3c4b5a69788d0e1f2a3\nAuthor: Jane Doe`,
  },
  {
    byteExact: true,
    text: `2026-07-09T12:31:07Z INFO request id=f47ac10b58cc4372a5670e02b2c3d479 handled`,
  },
  {
    byteExact: true,
    text: `export AWS_ACCESS_KEY_ID=AKIAEXAMPLEFAKE00\nexport REGION=us-east-1`,
  },
  {
    byteExact: true,
    text: `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dQw4w9WgXcQabc123`,
  },
  {
    byteExact: true,
    text: `checksum (sha256): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
  },
  {
    byteExact: true,
    text: `OPENAI_API_KEY=sk-EXAMPLEnotarealkey000000 blob follows`,
  },
  {
    byteExact: true,
    text: `github token: ghp_EXAMPLEtokennotreal000000000`,
  },
  {
    byteExact: true,
    text: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ`,
  },
  {
    byteExact: true,
    text: `order 4111111111111111 processed for invoice #INV-2026`,
  },
  {
    byteExact: true,
    text: `slack webhook token xoxb-EXAMPLE-FAKE-slack-token-value`,
  },
  {
    byteExact: true,
    text: `md5=d41d8cd98f00b204e9800998ecf8427e path=/var/log/app.log`,
  },
  {
    byteExact: true,
    text: `{"txHash":"0x8f7e6d5c4b3a29180716253443526170a1b2c3d4","block":19283746}`,
  },
  {
    byteExact: true,
    text: `session cookie: sessionid=3f8b9d2e7a1c4056b8e9f0a1c2d3e4f5g6h7 expires soon`,
  },
  {
    byteExact: true,
    text: `The deployment ref is release-7c3e9a1b and the config hash abcdef0123456789.`,
  },
  {
    byteExact: true,
    text: `phone verification code 8827461930 dispatched to the device`,
  },
  {
    byteExact: true,
    text: `- id: 550e8400-e29b-41d4-a716-446655440000\n  status: pending`,
  },
  {
    byteExact: true,
    text: `docker pull registry.io/app@sha256:7d5e2f1a9b8c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c`,
  },
  {
    byteExact: true,
    text: `A perfectly ordinary sentence, but it hides a key: rk-EXAMPLEfakelive0000.`,
  },
  {
    byteExact: true,
    text: `nonce=b64:QmFzZTY0RW5jb2RlZFNlY3JldFZhbHVlSGVyZQ== signed=true`,
  },
  // Same 6-hex token as the CSS color below, but a git short-SHA: unrecoverable
  // and load-bearing. Syntax alone cannot tell it from a color — only `commit`
  // vs `color:` context can. This is the false-negative the syntax-only v0 takes.
  {
    byteExact: true,
    text: `regression reverted in commit #a3f2c9 last night by the on-call engineer`,
  },

  // ---- negatives -----------------------------------------------------------
  {
    byteExact: false,
    text: `The quick brown fox jumps over the lazy dog while the sun sets slowly.`,
  },
  {
    byteExact: false,
    text: `We upgraded the parser to version 1.2.3 which fixed the newline handling.`,
  },
  {
    byteExact: false,
    text: `Set the primary color to #fff and the border to #ccc for a clean look.`,
  },
  // Byte-identical token to the short-SHA positive above, but a CSS color:
  // recoverable and cosmetic, safe to image. The verdict flips on context only.
  {
    byteExact: false,
    text: `.btn { color: #a3f2c9; border: 1px solid #445; } /* accent buttons */`,
  },
  {
    byteExact: false,
    text: `// This function normalizes whitespace before tokenizing the input string.`,
  },
  {
    byteExact: false,
    text: `Installation succeeded. Run npm start to launch the development server.`,
  },
  {
    byteExact: false,
    text: `Meeting moved to 3pm on Tuesday; please bring the quarterly projections.`,
  },
  {
    byteExact: false,
    text: `## Getting Started\n\nClone the repo, install deps, and run the test suite.`,
  },
  {
    byteExact: false,
    text: `The antidisestablishmentarianism debate resurfaced in the seminar again.`,
  },
  {
    byteExact: false,
    text: `Error: file not found. Check the path and try the command once more.`,
  },
  {
    byteExact: false,
    text: `Our roadmap for Q3 focuses on reliability, latency, and developer experience.`,
  },
  {
    byteExact: false,
    text: `function add(a, b) { return a + b; } // simple integer addition helper`,
  },
  {
    byteExact: false,
    text: `The recipe calls for 2 cups of flour, 3 eggs, and a pinch of salt.`,
  },
  {
    byteExact: false,
    text: `Supercalifragilisticexpialidocious is a delightfully long English word.`,
  },
  {
    byteExact: false,
    text: `Please review the pull request and leave comments on the design section.`,
  },
  {
    byteExact: false,
    text: `The server responded with status OK and rendered the homepage template.`,
  },
  {
    byteExact: false,
    text: `Chapter four discusses how the protagonist confronts her deepest fears.`,
  },
  {
    byteExact: false,
    text: `Toggle the feature flag in settings to enable the experimental dark mode.`,
  },
  {
    byteExact: false,
    text: `The garden bloomed with tulips, daffodils, and a stubborn patch of weeds.`,
  },
  {
    byteExact: false,
    text: `Remember to hydrate, stretch, and take short breaks during long sessions.`,
  },
  {
    byteExact: false,
    text: `The committee will reconvene next month to finalize the annual budget.`,
  },
];
