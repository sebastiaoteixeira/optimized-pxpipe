---
type: Dataset
title: Two-axis labeled corpus
description: 46 blocks labeled on exact (property) and keepText (policy) for Stage A.
resource: https://github.com/sebastiaoteixeira/optimized-pxpipe/blob/main/src/corpus.ts
tags: [dataset, evaluation]
timestamp: 2026-07-09T20:30:00Z
---

# Schema

| Field | Type | Meaning |
|-------|------|---------|
| `text` | string | The block content. |
| `exact` | boolean | Machine-precise value (one wrong byte = wrong). Scores the detector. |
| `keepText` | boolean | Guard should pin as text. Scores keepSharp. |

Both fields follow [exact vs keepText](/decisions/exact-vs-keeptext.md).

# Composition (46 blocks)

- **exact + keepText (24)**: hashes, UUIDs, secrets, base64, credit-card, phone,
  session ids — plus low-entropy critical values (`version 1.2.3`,
  `anthropic-version 2023-06-01`, phone `555-0142`, short-SHA `commit #a3f2c9`).
- **exact + not keepText (6)**: colors (`#fff`, `#a3f2c9`, `#1a2b3c`), ports,
  `npm start`, trivial code — precise but safe to image.
- **not exact (16)**: paraphraseable prose.

# Adversarial design

The corpus deliberately includes byte-identical tokens with opposite `keepText`
(`commit #a3f2c9` vs `color: #a3f2c9`) and low-entropy critical values invisible
to syntax, so Stage A surfaces the [detector/policy gap](/findings/detector-policy-gap.md)
rather than hiding it.

# Note

Secret-shaped fixtures are fabricated, obviously-fake strings that match the
guard's regexes without matching real provider token formats (so GitHub push
protection accepts them). Allowlisted in `.talismanrc`.
