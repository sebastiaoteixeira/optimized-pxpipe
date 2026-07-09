---
type: Finding
title: Detector recall lags keepText recall
description: Stage A shows syntax sees only high-entropy exact values.
tags: [evaluation, stage-a]
timestamp: 2026-07-09T20:40:00Z
---

# Stage A.1 — accuracy on the 46-block corpus

| Axis | precision | recall | f1 |
|------|-----------|--------|----|
| detector vs `exact` | 0.955 | 0.700 | 0.808 |
| keepSharp vs `keepText` | 0.955 | 0.875 | 0.913 |

- **Detector misses 9 exact values** — every low-entropy one: short-SHA, `1.2.3`,
  phone, colors, ports, `npm start`, code.
- **keepSharp recall (0.875) beats detector recall (0.700)** because colors,
  ports and code are `keepText:false`; the guard correctly does *not* pin them
  (true negatives), so its policy job is easier than raw detection.
- **3 keepText false negatives** remain — `1.2.3`, phone `555-0142`, short-SHA
  `commit #a3f2c9` — critical values silently dropped to image. These need a
  context/format signal, not more regex.
- **1 false positive** on both axes: a rare long dictionary word tripping the
  entropy fallback.

# Stage A.2 — retained savings

On a dense synthetic request (8 tool_result blocks, ~78k chars), guard ON pins
4 secret-bearing blocks as text and images the rest: **retains 52% of the
guard-OFF savings** while protecting every detected block.

# Interpretation

The 0.700→0.875 gap is the concrete argument for the
[detector + policy split](/decisions/detector-policy-split.md): syntax
approximates policy passably only because most misses happen to be low-stakes,
but it still corrupts three unrecoverable values. Live verbatim-recall numbers
(guard OFF vs ON against claude-fable-5) are Stage B, pending an API key.
