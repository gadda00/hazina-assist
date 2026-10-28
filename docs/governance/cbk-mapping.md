# CBK Draft Instruments & DPA 2019 — Control Mapping

CBK released revised draft risk-management instruments on 10 September 2026 covering **model risk, data governance, third parties and digital financial services** (comments due 7 November 2026). This table maps each heading to implemented, demonstrable controls — the point is not compliance theatre but showing the control set already speaks the regulator's language.

| Instrument heading | Control in Hazina Assist | Where to see it |
|---|---|---|
| **Model risk management** — inventory, validation, documentation | Model inventory with tiers and owners (use-case cards); categoriser carries a versioned model card; external-model id + version recorded per call on the audit chain; eval report is the standing validation artefact | `docs/governance/use-case-cards.md`, `services/categoriser/MODEL_CARD.md`, `docs/eval/eval-report.md` |
| **Model risk — human oversight** (Governor: explainability, oversight; credit responsibility stays with the bank) | HITL approval on every transfer; credit officer decides every loan pack (recommend-only); explainability trace per message (route, guard verdicts, tools, latency); "why I escalated" is a UI feature | Ops console, trace panel |
| **Model risk — performance monitoring & drift** | Golden set + CI gate on every PR; per-language metrics tracked (EN/SW/Sheng); monitoring tab with latency P50/P95, guardrail trip rate, escalation rate; alert thresholds documented | `.github/workflows/ci.yml`, Monitoring tab, runbook |
| **Data governance — lawful basis, minimisation** | PII minimisation at input (detection + notice), pseudonymisation at egress, redaction at rest (audit); only data needed for the requested journey is touched | `@hazina/kit` pii module, gateway |
| **Data governance — DPA s.35 (no solely-automated significant decisions)** | The IDP flow ends at a recommendation pack; approval/decline is a human click; transfers require a human approver — both recorded on the chain with the officer's name | Loan packs tab, approval queue |
| **Data governance — DPA s.48 (cross-border safeguards)** | PII pseudonymised before any external model call (reversible vault stays in-country); gateway is switchable to a self-hosted model (vLLM) without app changes; egress events are auditable | `src/lib/gateway.ts` |
| **Data governance — retention & integrity** | Audit log is append-only and hash-chained; `verify_chain` recomputes on read; deletion of app data does not silently rewrite history (chain breaks visibly) | `/api/audit`, unit tests |
| **Third-party risk — outsourced model services** | Model gateway isolates the external provider (routing, fallback, breaker); per-call model id + cost on the chain; contract-tested categoriser service with model card and explicit out-of-scope uses; no vendor lock-in in the journey logic | Gateway, categoriser contract tests |
| **Third-party risk — exit & concentration** | Deterministic fallbacks keep all four journeys alive with the external model fully down (demonstrated in the demo); categoriser has a local fallback with the same contract | Circuit breaker, fallback composer |
| **Digital financial services — transaction integrity** | Idempotency-by-message-reference on core calls; signed intents (HMAC, TTL, single-use nonce); OTP step-up; deterministic caps; replay protection verified in tests | `banking.ts`, `signing.ts`, unit tests |
| **Digital financial services — customer protection** | Fee disclosure from the dated tariff guide (never model-estimated); answerability gate refuses to guess; conservative refusal posture on injection; language matching (EN/SW/Sheng) | RAG node, guardrails |

**DPA 2019 specific provisions**

| Provision | Implementation |
|---|---|
| s.35 — decisions based solely on automated processing | No significant decision is automated: loans → officer decides; transfers → officer approves; the assistant's outputs are recommendations/answers |
| Regulation 22 (2021 regs) — automated individual decision-making | Same as above; the audit chain proves the human decision point (`hitl_raised` → `transfer_executed`/`hitl_rejected` with approver) |
| s.48 — transfer outside Kenya subject to proof of safeguards | Pseudonymisation proxy before egress + self-hosted-model switch + auditable egress events |
| ODPC guidance on cross-border transfers | The gateway documents the safeguard set (tokenisation, contract-tested downstream, auditability) a DPIA can cite |

**Known gaps (honest):** the demo runs without a real DPIA sign-off process, officer RBAC is a name field, and the SMS OTP channel is mocked. The DPIA template (`dpia-template.md`) and runbook (`runbook.md`) exist so an institution can operationalise these without inventing structure.
