# DPIA Template — Hazina Assist

Pre-filled for the four use-cases. Structured against ODPC expectations for high-risk processing (DPA 2019 Part III; automated decision-making per s.35 and Regulation 22).

## 1. Identification

| Field | Value |
|---|---|
| Assessment date | 2026-10-28 |
| System | Hazina Assist (bank-grade AI assistant, demo) |
| Owner / DPO sign-off | *(institution to assign)* |
| Use-cases in scope | Cards 1–4 (`use-case-cards.md`) — Q&A, account reads, transfer staging, payslip IDP |
| High-risk factors present | Automated processing feeding credit pre-qualification; large volumes of transaction data; cross-border model calls; novel technology (LLM) |

## 2. Description of processing

| Dimension | Detail |
|---|---|
| Data subjects | Bank customers (authenticated sessions); loan applicants |
| Personal data processed | Chat messages (may contain names, phones, KRA PINs, IDs); account references; transaction narratives; payslip contents (employer, name, KRA PIN, earnings, deductions) |
| Special-category data | None by design; payslip contents are financial-personal, not special category |
| Purposes | (a) answer policy/tariff questions; (b) display own-account data; (c) stage transfers for approval; (d) pre-qualify loans for officer review |
| Lawful basis | Contract performance (customer service on own accounts); legitimate interest + consent for loan pre-qualification; legal obligation none |
| Retention | Chat + audit chain: institution policy (e.g. 7 years for transaction-related records); model prompts/logs: pseudonymised or redacted; vault: session-scoped |
| Recipients | External model provider (pseudonymised text only); categoriser service (narrative text, no identifiers); no other recipients |
| Cross-border transfers | External LLM API may process outside Kenya — safeguard: **pseudonymisation before egress** (reversible tokens stay server-side, in-country); alternative: self-hosted model via the gateway switch |

## 3. Necessity & proportionality

- **Minimisation:** PII detected at input with user notice; tool arguments use opaque handles, never account numbers; audit payloads redacted at the string-value level; only the data needed for the requested journey is retrieved.
- **No silent profiling:** the categoriser labels transactions for display only — no behavioural scoring, no marketing use (model card lists these as out-of-scope).
- **Purpose limitation:** the loan pack is built for the officer's review of that application; it is not reused for pricing or marketing without a fresh DPIA.

## 4. Risk assessment (per use-case)

| Risk | Likelihood | Severity | Mitigation (implemented) | Residual |
|---|---|---|---|---|
| s.35 breach — automated credit decision | Low | High | IDP recommends only; officer decides on-record (chain) | Low |
| PII egress to model provider | Medium | High | Pseudonymisation before egress; vault server-side; audit of egress events | Low |
| Prompt injection → account takeover | Medium | High | Refuse-first guard_in; scoped tools; signed intents + OTP + HITL; eval gate 100% refusal recall | Low-Medium (novel phrasings) |
| Over-charging from wrong fee | Low | Medium | Deterministic compute_fee from dated tariff rows; numeric gate at 100% | Very low |
| Audit tampering | Low | High | Hash chain verified on read; unit-tested tamper detection | Very low |
| Hallucinated policy answer | Medium | Medium | Answerability gate → handoff; groundedness check; citations mandatory | Low |
| Code-mixed users get worse service | Medium | Medium | Per-language eval tracking; Swahili/Sheng templates for deterministic paths | Medium (tracked, improving) |

## 5. Rights of data subjects

| Right | Mechanism |
|---|---|
| Access / portability | Account data + conversation history available to the authenticated user |
| Rectification | Via existing bank channels; chat corrections re-audited (append-only — corrections are new events, history preserved) |
| Erasure | App-data deletion; audit chain is append-only by design — institution policy governs crypto-shredding/rotation; chain visibly breaks if records are removed without re-anchoring (integrity over invisibility) |
| Object to automated decisions | Built-in: no significant decision IS automated (s.35 posture) |
| Complaints | ODPC channel; runbook includes an incident/complaint route with audit extract as evidence |

## 6. Sign-off

| Role | Name | Date |
|---|---|---|
| System owner | | |
| DPO | | |
| Security officer | | |
| Business sponsor | | |

> This template is illustrative for the demo system; an institution's DPO must review and adopt it before any production processing of real customer data.
