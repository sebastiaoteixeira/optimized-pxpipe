---
type: Design Decision
title: Split the guard into a detector and a policy layer
description: One keepSharp predicate cannot serve both detection and the risk decision.
tags: [guard, architecture]
timestamp: 2026-07-09T20:10:00Z
---

# Context

v0 is a single syntactic predicate ([guard](/components/guard.md)) used directly
as `keepSharp`. It approximates the [keepText policy](/decisions/exact-vs-keeptext.md)
but structurally cannot detect low-entropy exact values, and cannot use context
to resolve ambiguous tokens (`commit #a3f2c9` vs `color: #a3f2c9`).

# Decision

Two layers instead of one predicate:

```
detector:  is this exact?          (property — inclusive, conservative)
policy:    given exact, keep text? (P_misread × stakes × recoverability)
```

- **Detector** flags all machine-precise values (colors, versions, short SHAs
  included), broader than syntax alone — needs a context/format signal, not just
  regex + entropy.
- **Policy** decides which exact values to pin, scoring glyph-confusability at
  render density against stakes and recoverability. Colors read fine → image;
  40-char SHAs read terribly → pin.

# Status

Proposed. v0 ships the detector-as-policy shortcut. The
[detector/policy gap](/findings/detector-policy-gap.md) (recall 0.700 vs 0.875)
is the evidence motivating the split; the context/format-aware detector is v1.

# Deployment note

The guard is deployed behind Claude Code as a live proxy via pxpipe's
`createProxy({ ...keepSharp })`; the same predicate flows through the proxy's
`TransformOptions`. Validating the guard as a library (Stage A/B) transfers
directly to the proxy.
