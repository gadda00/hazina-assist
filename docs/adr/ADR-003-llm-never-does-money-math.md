# ADR-003 — The LLM never does money math

**Status:** Accepted · **Date:** 2026-10-27

## Context
Fee questions ("how much to send 15k to M-Pesa?") are the most-asked questions in a Kenyan bank chat. Embedding-based RAG over a tariff PDF returns prose; the model then "reads" a band and states a number. That number can be wrong by an order of magnitude and the citation still looks convincing.

## Decision
Tariff rows are extracted at ingestion into structured data (channel, band_min, band_max, fee_type, min/max, effective_date). Fee questions are detected (EN/SW/Sheng) and answered by a deterministic `compute_fee(channel, amount)` **tool**; the model's only role is to present the tool's output. The eval gate requires the number printed in the answer to **equal the tool output verbatim** (100% threshold, CI-blocking).

## Consequences
- Fees are provably correct and effective-dated; audits show the exact matched tariff row.
- The same discipline extends to affordability (deterministic amortisation) and policy limits — all arithmetic lives in `@hazina/kit`.
- Trade-off: every new fee question phrasing needs the intent detector to catch it; the golden set grows with real traffic (documented in the eval report's scaling note).
