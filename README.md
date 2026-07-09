# Byte-exact content guard for pxpipe-proxy

`pxpipe-proxy` renders bulky LLM context (system prompt, tool docs, large
tool results) into dense PNGs to cut input tokens. Its known failure mode is
**silent confabulation**: byte-exact content (hashes, UUIDs, secrets, base64,
git SHAs) read back from an image is often wrong, with no error.

This PoC adds a `keepSharp` predicate — a **byte-exact content guard** — that
detects blocks carrying such content and pins them as TEXT, so pxpipe leaves
them uncompressed while still imaging everything else.

## What it proves

- **Detection quality (Stage A.1):** the guard separates byte-exact blocks
  from safe prose on a labeled corpus (precision/recall/F1).
- **Retained savings (Stage A.2):** on one large synthetic request, imaging
  with the guard OFF vs ON, how much token savings the guard costs to protect
  byte-exact content — quantified from pxpipe's own `TransformInfo`.
- **Live fidelity (Stage B):** that guard-ON verbatim recall beats guard-OFF
  when Claude is asked to reproduce freshly-random tokens read from images.

## Layout

- `src/guard.ts` — `hasByteExactContent(text)` + the `keepSharp` predicate.
  Regex families (hex/UUID/base64/JWT/git-SHA/digit-runs/secret-prefixes) plus a
  Shannon-entropy fallback. Thresholds are exported, tunable constants.
- `src/corpus.ts` — 40 labeled blocks (positives + negatives, incl. hard cases).
- `src/synthetic.ts` — builders for the large Anthropic requests.
- `src/stageA.ts` — offline: confusion matrix + savings table.
- `src/stageB.ts` — live: verbatim-recall harness (needs an API key).
- `src/anthropic.ts` — thin Messages API client.

## Run

```sh
npm install
npm run stage-a          # offline, no network
```

Stage B hits the live Anthropic API and needs a key. Without one it prints a
message and exits 0:

```sh
ANTHROPIC_API_KEY=sk-... npm run stage-b
```

Stage B builds 10 requests, each a dense tool_result with ~5 freshly-generated
random tokens (so the model cannot have memorized them), transforms each twice
(guard OFF / ON), asks `claude-fable-5` to reproduce every token verbatim, and
reports per-arm exact-match recall and image-token cost.

## Run as a proxy

Runs a local proxy that fronts the Anthropic API, injects the `keepSharp`
guard into pxpipe's transform, and serves a live monitoring dashboard:

```sh
npm run serve
```

Then point Claude Code at it:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:47899 claude --model claude-fable-5
```

The dashboard is at `http://127.0.0.1:47899/`; its compression toggle acts as
a kill switch for the guard. Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `47899` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Upstream API (also `PXPIPE_UPSTREAM`) |
| `PXPIPE_MODELS` | `claude-fable-5` | Comma-separated models the guard transforms; others pass through as text |
| `PXPIPE_LOG` | `~/.pxpipe/events.jsonl` | JSONL event log |
