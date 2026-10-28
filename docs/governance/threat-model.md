# Threat Model — Hazina Assist

Method: **STRIDE** per component + **OWASP Top 10 for LLM Applications (2025)** mapped to implemented controls. Each control lists where it lives in code — a reviewer can verify every row.

## System boundary

```
[Customer browser] → [Next.js API routes] → [Orchestrator] → { Model Gateway ⇄ external LLM
                                                              Tool layer → mock core banking
                                                              Retrieval → KB/tariff DB
                                                              Categoriser service (contract) }
[Officer browser] → [Ops console APIs] → approval/execute/audit
```

Trust boundaries crossed: browser→API (auth), orchestrator→external model (data egress), orchestrator→core banking (money), API→DB (integrity of audit).

## STRIDE

| # | Threat | Component | Control (implementation) |
|---|---|---|---|
| S1 | Impersonation of customer | API routes | Session identity is server-side; login mints the session; tool layer resolves opaque handles against the session's customer and **fails if not theirs** (`src/lib/tools.ts` `resolveHandle`) |
| S2 | Officer actions attributed falsely | Ops console | Approver name recorded on every decision event in the hash chain (`hitl_rejected` / `transfer_executed` carry `approver:<name>`) |
| T1 | Tampering with audit history | Audit log | Append-only hash chain: each event hashes `prev_hash + canonical payload`; `GET /api/audit` recomputes the full chain on every read and reports the first broken index (`@hazina/kit` `verifyChain`; unit test `tampering breaks the chain`) |
| T2 | Tampering with a staged transfer | Transfer intent | HMAC-SHA256 over `{sid, intent, exp, nonce}`; execute node verifies in constant time + TTL + single-use nonce (`packages/hazina-kit/src/signing.ts`; unit tests for wrong-secret, session-mismatch, expiry, replay) |
| T3 | Prompt content tampering (injection) | Orchestrator | `guard_in` heuristics (EN/SW/code-mixed) refuse flagged input before any model call; untrusted retrieved text is delimited and tag-filtered (`wrapUntrusted`) |
| R1 | Repudiation of a money movement | Transfers | Full chain: `message_received → guard_in → route → policy_check → otp_issued → intent_signed → hitl_raised → transfer_executed` with actor, args, txnRef, idempotency key |
| I1 | Data egress via external model | Model gateway | PII pseudonymised (reversible, vault server-side) before egress; re-hydrated after (`src/lib/gateway.ts`, `@hazina/kit` `pseudonymise/rehydrate`); DPA s.48 story |
| I2 | PII in logs | Audit + console | Audit payloads redacted at string-value level (`redactPayload`); console masks destinations/accounts; OTP codes never logged |
| I3 | Cross-customer data access | Tool layer | Handle resolution scoped to session customer (S1); statement tools take only the customer's own handles |
| D1 | Denial of wallet (unbounded consumption) | Model gateway | Circuit breaker (3 failures → 60 s open); deterministic fallback keeps journeys alive; per-message length cap (2000 chars) at `guard_in` |
| E1 | Elevation of agency — model calls a write tool | Tool registry | Tools are read-only except through the signed-intent path; scopes checked per call; the model has no execute privilege by construction (`REGISTRY`, `callTool`) |
| E2 | Elevation via console | Approvals | Execute node re-verifies signature/expiry/nonce **after** officer approval — console compromise cannot replay an expired or used intent; idempotency key prevents double-spend |

## OWASP LLM Top 10 (2025) mapping

| OWASP | Implemented control |
|---|---|
| **LLM01 Prompt Injection** | `guard_in` refuse-first posture (any flagged score ≥ 0.5 → refusal, never "sanitise and continue"); code-mixed attack patterns (EN/SW/Sheng) in the rule set; golden set injection cells gated at 100% refusal recall; untrusted retrieved/doc content wrapped in delimiters and tag-filtered, never placed in the system role |
| **LLM02 Sensitive Information Disclosure** | PII detection + redaction in audit; pseudonymisation before egress; output guard scans answers for PII leaks (`guardOut`); system prompt never contains data |
| **LLM03 Supply Chain** | SBOM (syft) + Trivy + pip-audit + gitleaks in CI; kit and categoriser pinned and contract-tested; no model weights downloaded at runtime |
| **LLM04 Data & Model Poisoning** | KB corpus is versioned in git with effective dates; tariff rows extracted from the dated guide document — no crowd-sourced ingestion path exists |
| **LLM05 Improper Output Handling** | Tool args parsed against zod schemas (never `eval`/ad-hoc); LLM output treated as untrusted text — groundedness check + advice filter before display; fee numbers never sourced from the model |
| **LLM06 Excessive Agency** | Explicit state machine, not a free-roaming agent; read-only tool default; writes require signed intent + OTP + human approval; per-session scope list |
| **LLM07 System Prompt Leakage** | Extraction patterns refused at input; system role contains no secrets and no customer data; leakage is a low-impact event by construction |
| **LLM08 Vector & Embedding Weaknesses** | Answerability gate (rerank score < 0.42 → handoff) defeats poisoned-irrelevant chunks; hybrid ranking with RRF reduces single-channel manipulation; citations make provenance visible |
| **LLM09 Misinformation** | Deterministic fee tool; groundedness gate on answers; "I won't guess" handoff copy; citations on every claim |
| **LLM10 Unbounded Consumption** | Length caps, circuit breaker, fallback composer, cost tracked per call (USD) and aggregated in `/api/metrics` for alerting |

## Residual risks (documented, not hidden)

1. **Heuristic injection detection** can be evaded by novel phrasings — mitigation: refusal posture is conservative (any flag refuses), the eval set grows with each red-team session, and the classifier is swappable for a trained model behind the same interface.
2. **Mock OTP channel** displays the dev code in the UI — production replaces one function (`issueOtp`) with an SMS gateway; the verification path is already rate-limited (3 attempts, 5-min expiry).
3. **SQLite** is single-writer (chain serialisation is trivially safe); production Postgres uses the same transactional pattern with an advisory lock (ADR-006).
4. **Officer identity** is a name field in the demo; production binds it to OIDC roles.
