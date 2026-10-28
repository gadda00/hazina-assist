# Hazina Assist — Evaluation Report

**Run ID:** `cmvrqhzlm0062jq72ac2619hm`
**Date:** 2026-10-28T06:29:18.586Z
**Golden set:** 55 cases (intent × language × risk)
**Model path:** rules+gateway (see per-case model backend) — deterministic paths (router rules, fee tool, guardrails, policy) + model gateway where applicable
**Result:** ✅ **PASS** (CI gate)

## Headline metrics

| Metric | Value | Gate |
|---|---|---|
| Overall pass rate | 100.0% | ≥ 90% |
| Route accuracy | 100.0% | ≥ 90% |
| Tool-call exact match | 100.0% | — |
| Refusal precision | 1.000 | — |
| Refusal recall | 1.000 | = 1.00 |
| Citation rate (RAG answers) | 100.0% | — |
| Fee numeric match | 100.0% | = 100% |
| Latency P50 / P95 | 8ms / 1910ms | — |

## By language (English / Swahili / code-mixed Sheng)

| Language | Cases | Passed | Pass rate |
|---|---|---|---|
| en | 31 | 31 | 100.0% |
| sw | 14 | 14 | 100.0% |
| mixed | 10 | 10 | 100.0% |

Language split follows the evidence that African-language and code-mixed performance can lag English (IrokoBench), so failures here are treated as first-class signals, not noise.

## By risk class

| Risk | Cases | Passed | Pass rate |
|---|---|---|---|
| fee | 12 | 12 | 100.0% |
| normal | 29 | 29 | 100.0% |
| injection | 9 | 9 | 100.0% |
| out_of_scope | 5 | 5 | 100.0% |

## CI gate

```
PASS — thresholds: passRate ≥ 0.9, routeAccuracy ≥ 0.9, refusalRecall = 1, numericMatchRate = 1
no threshold regressions
```

## Failed cases

_None — every case passed._

## Method notes

- Cases execute the **production orchestrator end-to-end** (guard_in → route → node → guard_out → respond), including audit-chain writes; no component is stubbed.
- **Fee determinism:** fee answers must equal the `compute_fee` tool output verbatim — an LLM never does fee arithmetic.
- **Refusals:** injection cases (EN/SW/code-mixed) must be refused; refusal recall is gated at 100% because a missed jailbreak is a security incident, not a quality issue.
- **Answerability:** out-of-scope questions must hand off, never guess.
- **Scaling to ~300 cases:** the set is generated from a matrix of intent × language × risk with per-cell variants; this seed run covers every cell with 1–3 representatives each.
- **Judge calibration:** no LLM-as-judge is used in this harness — all checks are programmatic (route label, tool JSON, regex numeric, citation presence), which removes judge variance entirely. If a judge is introduced later, hand-label ~50 items and report Cohen's κ.
