---
type: Design Decision
title: Byte-exactness is a property; keep-as-text is a policy
description: Two orthogonal questions the guard must not conflate.
tags: [guard, semantics, labeling]
timestamp: 2026-07-09T20:00:00Z
---

# Context

The guard's first framing was a single question: "is this block byte-exact?"
That collapses two independent things and led to mislabeling color codes as
"not byte-exact" — which is false. `#a3f2c9` → `#a3f2c8` is a different color;
one wrong byte changes the meaning.

# Decision

Separate the two axes explicitly.

| Axis | Question | Nature | Examples that are `true` |
|------|----------|--------|--------------------------|
| `exact` | Do the exact characters carry meaning (one wrong byte = wrong)? | Property of the content | hashes, UUIDs, secrets, versions, colors, ports, commands, code |
| `keepText` | Should the guard pin it as text instead of imaging it? | Risk policy | unrecoverable AND consequential AND reads poorly at render density |

`keepText` ⊆ `exact`: everything worth pinning is exact, but not every exact
value is worth pinning. Colors and ports are `exact:true, keepText:false` — a
misread is cosmetic or self-evident on failure, and they read easily.

# Consequences

- Colors, versions, `npm start`, code are relabeled `exact:true` in the
  [corpus](/components/corpus.md); the `keepText` field carries the risk call.
- "when in doubt, keep it text" is the safe default for a corruption guard.
- The same token can flip `keepText` on context alone: `commit #a3f2c9`
  (keepText) vs `color: #a3f2c9` (image) — a purely syntactic guard cannot
  tell them apart. See [detector + policy split](/decisions/detector-policy-split.md).
