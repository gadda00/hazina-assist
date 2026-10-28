# AI Use-Case Cards

One card per capability, per CBK's model-risk expectations: purpose, risk tier, data, limitations, human oversight, evaluation and fallback. These cards are the accountability unit — a reviewer should be able to audit any capability against its card in five minutes.

---

## Card 1 — Policy & Tariff Q&A (RAG)

| Field | Value |
|---|---|
| **Purpose** | Answer customer questions about fees, tariffs, product rules and requirements from the bank's published documents, with citations. |
| **Risk tier** | Low (informational; no state changes) |
| **Data in** | Customer message (may contain PII — pseudonymised before external model calls); public tariff guide + product FAQ corpus. |
| **Data out** | Answer + citations (doc_id, page, effective_date). No personal data returned beyond what the customer themselves typed. |
| **Model role** | Composes grounded prose from retrieved chunks. **Never computes fees** — `compute_fee` is a deterministic tool; **never decides** anything. |
| **Limitations** | Corpus covers the seeded tariff guide + FAQs; questions outside the corpus hit the answerability gate and hand off. Code-mixed Sheng retrieval is weaker than English (tracked per-language in the eval report). |
| **Human oversight** | Answerability gate → handoff with conversation summary; thumbs feedback planned. |
| **Evaluation** | Golden set: route accuracy, citation rate, fee numeric match (must equal tool output, gated at 100%), groundedness score, handoff correctness. CI gate blocks regressions. |
| **Fallback** | External model unavailable → deterministic composer over the same retrieved chunks (same citations, same fee tool). Retrieval empty → handoff. |

## Card 2 — Account Assistant (tool calling)

| Field | Value |
|---|---|
| **Purpose** | Show balance and mini-statements for the authenticated customer's own accounts. |
| **Risk tier** | Low-Medium (read-only, but touches account data) |
| **Data in** | Customer message + server-side session identity. |
| **Data out** | Balance / last-N transactions (masked account numbers, categorised narratives). |
| **Model role** | Chooses which read-only tool to call with which opaque handle. **Identity never enters the prompt**: the model sees `acct_7f3a`, the server resolves it and fails if it isn't the customer's. |
| **Limitations** | Read-only surface by design; no account mutations exist in the tool registry. |
| **Human oversight** | Not required per-read (read-only, own data); all reads are audit-chained. |
| **Evaluation** | Tool-call exact match (name + arguments) on the golden set; scope enforcement unit-tested. |
| **Fallback** | Rules-based intent matching works without any model; the LLM is only a tie-breaker. |

## Card 3 — Transfers (propose, never move)

| Field | Value |
|---|---|
| **Purpose** | Stage money movement (M-Pesa, internal, PesaLink) from proposal to execution. |
| **Risk tier** | **High** (consequential action) |
| **Data in** | Customer message; server-side identity; beneficiary registry. |
| **Data out** | Signed intent, approval task, executed transaction. |
| **Model role** | Extracts a structured `TransferIntent` proposal (amount, channel, destination, beneficiary). **The model cannot execute anything.** |
| **Deterministic controls** | Per-transaction cap KES 70,000; daily cap KES 200,000; new-beneficiary 30-minute cooling-off; insufficient-funds check; HMAC-signed intents (15-min TTL, single-use nonce, constant-time comparison); step-up OTP issued/verified outside the LLM context; execution via idempotency key. |
| **Human oversight** | **Mandatory**: every transfer requires (1) customer OTP and (2) officer approval in the HITL queue before the execute node runs. |
| **Limitations** | Mock OTP channel (dev code shown in UI for demo); production wires an SMS gateway. Caps are demo values, configurable in `@hazina/kit/policy`. |
| **Evaluation** | Route accuracy; policy-block cases (over-cap, new beneficiary) in the golden set; signature/expiry/nonce replay covered by unit tests; idempotency covered by replay test. |
| **Fallback** | Any control failure → intent rejected + audited; circuit-breaker on extraction → rule-based extraction only. |

## Card 4 — Loan Pre-Qualification (IDP)

| Field | Value |
|---|---|
| **Purpose** | Turn a payslip into a structured pre-qualification pack that helps a credit officer decide faster. |
| **Risk tier** | **High** (feeds a credit decision) |
| **Data in** | Uploaded payslip (synthetic samples in demo); requested amount/tenor. |
| **Data out** | Extracted fields (value + confidence + evidence span), validation results, deterministic affordability, summary — for the officer. |
| **Model role** | Summarises the pack. **Extraction is rule/schema-driven; affordability is arithmetic; the system never approves or declines** (DPA 2019 s.35 posture). |
| **Deterministic controls** | KRA PIN pattern; net ≤ gross; deductions reconcile within 0.5%; Employment Act s.19 one-third rule; confidence floor 0.70 → below flags review; affordability = instalment ≤ 50% of disposable + DTI ≤ 50%. |
| **Human oversight** | **Mandatory**: pack lands in the Loan Packs tab; a credit officer clicks approve/decline with their name recorded on the chain. |
| **Limitations** | Text-layer extraction (Docling/Tesseract/OCR adapter is the production path — the pipeline contract is unchanged: classify → extract-with-evidence → validate → afford → recommend). |
| **Evaluation** | Field-level extraction tests (clean + OCR-noise variants); validation rule tests; affordability boundary tests. |
| **Fallback** | Low-confidence fields or failed rules → pack flagged for review rather than dropped; officer always in the loop. |

---

## Model inventory (for CBK model-risk register)

| Model | Version | Owner | Tier | Card |
|---|---|---|---|---|
| External LLM via gateway (chat/extract/summarise) | recorded per call in audit chain | Platform team | Medium | Cards 1–4 (role column) |
| Transaction categoriser | categoriser-0.2.0 | Data Science | Low (display-only) | `services/categoriser/MODEL_CARD.md` |
| Router rules + reranker proxy | deterministic, versioned in git | App team | Low | Cards 1, 2 |
