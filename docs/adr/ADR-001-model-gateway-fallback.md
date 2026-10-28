# ADR-001 — Model gateway with deterministic fallback, not a hard model dependency

**Status:** Accepted · **Date:** 2026-10-27

## Context
The assistant must work as a customer-facing service. External LLM APIs fail (429s observed in practice during this build), cost money, and create data-egress obligations. A chat product that hard-depends on an external endpoint has an availability ceiling it does not control.

## Decision
All model access goes through a gateway layer (`src/lib/gateway.ts`) that:
1. **Pseudonymises** every non-system message before egress (reversible vault server-side) and re-hydrates the response — the DPA s.48 safeguard is structural, not procedural.
2. Keeps a **circuit breaker** (3 consecutive failures → open 60 s).
3. Falls back to **deterministic composers** per journey (tariff-cited answers, templated account replies, rule-based extraction) so all four capabilities survive total model loss.
4. Records model id, backend, latency, estimated tokens and cost per call into the trace/audit chain.

## Consequences
- Availability is owned by us; the demo degrades gracefully and says so honestly (fallback is visible in the trace, not hidden).
- Fee answers were already deterministic (ADR-003), so the highest-stakes journey never touched the model in the first place.
- Trade-off: fallback prose is terser than a large model's. Acceptable — banking copy is a compliance artefact, not literature.
- Switching to a self-hosted vLLM endpoint is a config change because the app only knows the gateway interface.
