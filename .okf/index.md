---
okf_version: "0.1"
---

# optimized-pxpipe — byte-exact content guard

Knowledge bundle for a guard that stops the pxpipe image-compression proxy from
silently corrupting verbatim-critical content. pxpipe renders bulky context into
PNGs to save input tokens; vision reads are lossy, so exact values (hashes, ids,
secrets) can come back as plausible confabulations. This bundle records the
design decisions, components, and measured findings.

# Decisions

* [Exact vs keepText](/decisions/exact-vs-keeptext.md) - byte-exactness is a property; keeping-as-text is a separate risk policy.
* [Detector + policy split](/decisions/detector-policy-split.md) - two layers instead of one keepSharp predicate.

# Components

* [Guard](/components/guard.md) - the keepSharp predicate (regex families + Shannon-entropy fallback).
* [Corpus](/components/corpus.md) - two-axis labeled dataset (`exact`, `keepText`) for Stage A.

# Findings

* [Detector/policy gap](/findings/detector-policy-gap.md) - detector recall 0.700 vs keepText recall 0.875 on the corpus.
