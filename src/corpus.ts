export interface CorpusBlock {
  readonly text: string;
  /** Property: the block carries a machine-precise token whose exact characters
   *  are load-bearing — a single wrong byte changes the meaning (hashes, ids,
   *  versions, colors, commands, code). Independent of how risky it is to image. */
  readonly exact: boolean;
  /** Policy: the guard should pin this as text rather than image it. True when a
   *  misread would be unrecoverable AND consequential AND the token reads poorly at
   *  render density. Colors/ports/commands are `exact` yet safe to image, so `false`. */
  readonly keepText: boolean;
}

/** Ground truth for Stage A. Two axes: `exact` scores the detector (is the value
 *  machine-precise?), `keepText` scores the keepSharp guard (should we pin it?).
 *  The gap between them is the whole point — a syntax-only guard approximates
 *  `keepText` but cannot see low-entropy exact values (versions, short SHAs) nor
 *  should it pin every exact value (colors read fine and don't matter). */
export const CORPUS: readonly CorpusBlock[] = [
  // ---- exact + keepText: unrecoverable, consequential, must stay text --------
  {
    exact: true,
    keepText: true,
    text: `{"user_id":"a3f9c1e2-7b4d-4c8a-9f21-0e5d6a7b8c9d","balance":42099}`,
  },
  {
    exact: true,
    keepText: true,
    text: `commit 9f2a1c4e8b7d6053a1e2f3c4b5a69788d0e1f2a3\nAuthor: Jane Doe`,
  },
  {
    exact: true,
    keepText: true,
    text: `2026-07-09T12:31:07Z INFO request id=f47ac10b58cc4372a5670e02b2c3d479 handled`,
  },
  {
    exact: true,
    keepText: true,
    text: `export AWS_ACCESS_KEY_ID=AKIAEXAMPLEFAKE00\nexport REGION=us-east-1`,
  },
  {
    exact: true,
    keepText: true,
    text: `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dQw4w9WgXcQabc123`,
  },
  {
    exact: true,
    keepText: true,
    text: `checksum (sha256): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
  },
  {
    exact: true,
    keepText: true,
    text: `OPENAI_API_KEY=sk-EXAMPLEnotarealkey000000 blob follows`,
  },
  {
    exact: true,
    keepText: true,
    text: `github token: ghp_EXAMPLEtokennotreal000000000`,
  },
  {
    exact: true,
    keepText: true,
    text: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ`,
  },
  {
    exact: true,
    keepText: true,
    text: `order 4111111111111111 processed for invoice #INV-2026`,
  },
  {
    exact: true,
    keepText: true,
    text: `slack webhook token xoxb-EXAMPLE-FAKE-slack-token-value`,
  },
  {
    exact: true,
    keepText: true,
    text: `md5=d41d8cd98f00b204e9800998ecf8427e path=/var/log/app.log`,
  },
  {
    exact: true,
    keepText: true,
    text: `{"txHash":"0x8f7e6d5c4b3a29180716253443526170a1b2c3d4","block":19283746}`,
  },
  {
    exact: true,
    keepText: true,
    text: `session cookie: sessionid=3f8b9d2e7a1c4056b8e9f0a1c2d3e4f5g6h7 expires soon`,
  },
  {
    exact: true,
    keepText: true,
    text: `The deployment ref is release-7c3e9a1b and the config hash abcdef0123456789.`,
  },
  {
    exact: true,
    keepText: true,
    text: `phone verification code 8827461930 dispatched to the device`,
  },
  {
    exact: true,
    keepText: true,
    text: `- id: 550e8400-e29b-41d4-a716-446655440000\n  status: pending`,
  },
  {
    exact: true,
    keepText: true,
    text: `docker pull registry.io/app@sha256:7d5e2f1a9b8c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c`,
  },
  {
    exact: true,
    keepText: true,
    text: `A perfectly ordinary sentence, but it hides a key: rk-EXAMPLEfakelive0000.`,
  },
  {
    exact: true,
    keepText: true,
    text: `nonce=b64:QmFzZTY0RW5jb2RlZFNlY3JldFZhbHVlSGVyZQ== signed=true`,
  },
  // Short git SHA: same 6-hex token as the CSS color below, but here it is
  // unrecoverable and load-bearing. Context (`commit`) flips keepText, not syntax.
  {
    exact: true,
    keepText: true,
    text: `regression reverted in commit #a3f2c9 last night by the on-call engineer`,
  },
  // Low-entropy but critical exact values the syntax guard is blind to: no long
  // hex/digit run, no high-entropy token. A misread version installs the wrong
  // release; a misread API date breaks every call; a wrong number reaches nobody.
  {
    exact: true,
    keepText: true,
    text: `We upgraded the parser to version 1.2.3 which fixed the newline handling.`,
  },
  {
    exact: true,
    keepText: true,
    text: `Request header anthropic-version: 2023-06-01 is required on every call.`,
  },
  {
    exact: true,
    keepText: true,
    text: `Call the vendor back at 555-0142 to confirm the shipment window.`,
  },

  // ---- exact but keepText:false: precise yet safe to image -------------------
  // Colors, ports, commands, code: exact values whose misread is cosmetic,
  // self-evident on failure, or re-derivable (agents re-read code before editing).
  {
    exact: true,
    keepText: false,
    text: `Set the primary color to #fff and the border to #ccc for a clean look.`,
  },
  {
    exact: true,
    keepText: false,
    text: `.btn { color: #a3f2c9; border: 1px solid #445; } /* accent buttons */`,
  },
  {
    exact: true,
    keepText: false,
    text: `The theme's accent is #1a2b3c on dark backgrounds and #f0f0f0 on light.`,
  },
  {
    exact: true,
    keepText: false,
    text: `Bind the dev server to port 8080 and the proxy to port 47821 locally.`,
  },
  {
    exact: true,
    keepText: false,
    text: `Installation succeeded. Run npm start to launch the development server.`,
  },
  {
    exact: true,
    keepText: false,
    text: `function add(a, b) { return a + b; } // simple integer addition helper`,
  },

  // ---- not exact: paraphraseable prose, safe to image ------------------------
  {
    exact: false,
    keepText: false,
    text: `The quick brown fox jumps over the lazy dog while the sun sets slowly.`,
  },
  {
    exact: false,
    keepText: false,
    text: `// This function normalizes whitespace before tokenizing the input string.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Meeting moved to 3pm on Tuesday; please bring the quarterly projections.`,
  },
  {
    exact: false,
    keepText: false,
    text: `## Getting Started\n\nClone the repo, install deps, and run the test suite.`,
  },
  {
    exact: false,
    keepText: false,
    text: `The antidisestablishmentarianism debate resurfaced in the seminar again.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Error: file not found. Check the path and try the command once more.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Our roadmap for Q3 focuses on reliability, latency, and developer experience.`,
  },
  {
    exact: false,
    keepText: false,
    text: `The recipe calls for 2 cups of flour, 3 eggs, and a pinch of salt.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Supercalifragilisticexpialidocious is a delightfully long English word.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Please review the pull request and leave comments on the design section.`,
  },
  {
    exact: false,
    keepText: false,
    text: `The server responded with status OK and rendered the homepage template.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Chapter four discusses how the protagonist confronts her deepest fears.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Toggle the feature flag in settings to enable the experimental dark mode.`,
  },
  {
    exact: false,
    keepText: false,
    text: `The garden bloomed with tulips, daffodils, and a stubborn patch of weeds.`,
  },
  {
    exact: false,
    keepText: false,
    text: `Remember to hydrate, stretch, and take short breaks during long sessions.`,
  },
  {
    exact: false,
    keepText: false,
    text: `The committee will reconvene next month to finalize the annual budget.`,
  },
];
