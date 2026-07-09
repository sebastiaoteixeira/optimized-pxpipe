---
type: Component
title: keepSharp guard (v0)
description: Syntactic byte-exact detector used as the keepSharp predicate.
resource: https://github.com/sebastiaoteixeira/optimized-pxpipe/blob/main/src/guard.ts
tags: [guard, detector]
timestamp: 2026-07-09T20:20:00Z
---

# Behavior

`hasByteExactContent(text)` returns true when the block carries a
byte-exact-critical token; `keepSharp(block)` wraps it for pxpipe. Block-level:
any matching token pins the whole block as text.

# Signals

- **Regex families**: git SHA-1 (40 hex), hex runs ≥8, UUID, base64 ≥20 (must
  carry a digit/symbol), JWT (three long segments), digit runs ≥10, API-key
  prefixes (`sk-`/`pk-`/`rk-`), GitHub tokens (`ghp_…`), AWS (`AKIA…`), Slack
  (`xox[baprs]-…`).
- **Shannon-entropy fallback**: tokens ≥ `ENTROPY_MIN_TOKEN_LEN` (12) with
  entropy ≥ `ENTROPY_BITS_THRESHOLD` (3.5 bits/char).

# Known limitations

- Blind to low-entropy exact values: short SHAs (<8 hex), versions (`1.2.3`),
  hyphenated phones, API-date versions. These are [keepText](/decisions/exact-vs-keeptext.md)
  yet invisible to syntax.
- Over-trips on rare long dictionary words (entropy false positive, e.g.
  "Supercalifragilistic…").
- No context signal, so cannot distinguish `commit #a3f2c9` from
  `color: #a3f2c9` — the core case for the [detector/policy split](/decisions/detector-policy-split.md).

# Measured on the corpus

See [detector/policy gap](/findings/detector-policy-gap.md).
