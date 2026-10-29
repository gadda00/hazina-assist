# Hazina Assist

**A safety-oriented synthetic banking demo that maps to every duty in the job ad — controls, integration and operation, not a tutorial chatbot.**

**Try it live: the deployed app is the real implementation — [`hazina-assist-pfb8.vercel.app`](https://hazina-assist-pfb8.vercel.app)** (chat in English/Swahili/Sheng, stage a transfer through OTP, approve it in the ops console, watch the audit chain verify). Static showcase: [`gadda00.github.io/hazina-assist`](https://gadda00.github.io/hazina-assist/) · Source: [`github.com/gadda00/hazina-assist`](https://github.com/gadda00/hazina-assist). Deploy your own instance with one click — see [`DEPLOY.md`](DEPLOY.md).

One end-to-end system with four customer-facing capabilities, an operations console, guardrails at every layer, a hash-chained audit trail, human-in-the-loop for every consequential action, and an evaluation gate that fails the PR when quality regresses. Alongside the code sits a governance pack mapped to CBK's draft risk-management instruments and the Data Protection Act 2019.

> **Demo data is 100% synthetic.** Customers, accounts, tariff rows and payslips are generated for the demo. Nothing here touches a real bank.

---

## Why this build

| Context | What this project does about it |
|---|---|
| CBK's 2025 survey: ~half of institutions adopted AI, 59% of those had **no AI policy** | A governance pack ships with the code: use-case cards, threat model, DPIA template, CBK control mapping |
| CBK revised draft risk-management instruments (Sep 2026): model risk, data governance, third parties | Controls mapped to those exact headings — see `docs/governance/cbk-mapping.md` |
| CBK Governor: models must be **transparent, explainable, under human oversight**; credit responsibility stays with banks | Every answer carries citations; every consequential action carries a human approver; the loan flow **recommends, never decides** |
| DPA 2019 **s.35**: no decisions based *solely* on automated processing | IDP produces recommendation packs for a credit officer; transfers need OTP + officer approval |
| DPA 2019 **s.48**: safeguards before personal data leaves Kenya | PII is pseudonymised before any external model call; the gateway is switchable to a self-hosted model |
| OWASP LLM Top 10 (2025): prompt injection is #1; excessive agency & system-prompt leakage listed | Explicit state machine, least-privilege tools, injection heuristics (EN/SW/code-mixed), untrusted-content delimiting |

---

## The four capabilities

1. **Policy & tariff Q&A (RAG)** — answers from a structured tariff guide + product FAQs, with `doc_id/page/effective_date` citations. Fee questions are answered by a **deterministic `compute_fee` tool** — an LLM never does fee arithmetic. An answerability gate hands off instead of guessing when retrieval confidence is low.
2. **Account assistant (tool calling)** — balance and mini-statement through typed, scoped, read-only tools. The model only ever sees **opaque handles** (`acct_7f3a`); the server resolves them to the authenticated customer's accounts and fails if they aren't theirs.
3. **Loan pre-qualification pack (IDP)** — payslip in (synthetic clean/scanned samples provided), structured extraction out with **per-field confidence and source evidence**, deterministic validation (KRA PIN format, net ≤ gross, deduction reconciliation, Employment Act one-third rule), deterministic affordability, and a recommendation pack for a **human credit officer**.
4. **Ops console** — approval queue (HITL), payslip pack review with evidence highlights, hash-chained **audit viewer with live chain verification**, evaluation dashboard, and live monitoring (Prometheus-format `/api/metrics`).

---

## Architecture

```
 Web chat (Next.js 16)              Ops console (same app, officer view)
        │                                    │
        └────────────► API routes (Next.js server) ◄────────────┘
                              │
                Orchestrator — explicit state machine
   guard_in → [otp short-circuit] → route → rag | account_tools | transfer_flow | idp_flow
            → policy_check → HITL interrupt → execute → guard_out → respond
                              │
   ┌──────────────┬──────────┴─────────┬─────────────────────┬──────────────────┐
   Model Gateway  Tool Layer           Retrieval             Audit & Telemetry
   pseudonymise   typed + scoped       BM25 + dense proxy    hash-chained log
   → external     (opaque handles,     fused (RRF) +         (SHA-256, verified
   LLM w/ circuit read-only, signed    reranker + answer-    on read), metrics
   breaker +      intents for writes)  ability gate          endpoint, per-node
   deterministic                                            trace in the UI
   fallback
                              │
            "Data Science" service: transaction categoriser
            (services/categoriser — FastAPI + sklearn, own
             OpenAPI contract + model card + contract tests;
             app consumes via contract only, with a
             contract-compatible local fallback)
```

**The separation the ad stresses** — the categoriser is a separate service with its own OpenAPI contract, model card and tests (`services/categoriser/`). The app integrates it through the contract and validates every response against the label enum at runtime; it never imports model code. Contract tests on both sides (`tests/categoriser-contract.test.ts`, `services/categoriser/test_main.py`).

Reusable building blocks live in **`packages/hazina-kit`** (signing, PII, injection rules, hash-chain, policy, eval metrics, retrieval) — pure TypeScript, liftable into any Node service.

---

## The money-movement guarantee

The model **proposes**; deterministic code and humans **decide**:

```
user: "Send 2000 to Jane on M-Pesa"
  → guard_in (PII scan, injection heuristics, language ID)
  → route: transfer
  → propose: structured TransferIntent (amount, channel, destination)
  → policy_check: per-txn cap 70k · daily cap 200k · new-beneficiary 30-min cooling-off
  → step-up OTP (mock SMS — issued and verified OUTSIDE the LLM context)
  → sign: HMAC-SHA256 over {sid, intent, exp, nonce} — 15-min TTL
  → HITL: approval task in the ops console
  → officer approves → execute node:
        verify signature (constant-time) + expiry + single-use nonce
        → core API call with idempotency key (replays return the original result)
  → audit: every node appends a redacted, hash-chained event
```

## Quickstart

```bash
bun install
bun run db:push          # create SQLite schema (prisma CLI reads .env)
bun run seed             # synthetic customers, accounts, tariff guide, KB
bun run dev              # http://localhost:3000

# quality gates
bun test                 # 61 unit + contract + safety tests
bun run eval             # golden set through the REAL orchestrator → docs/eval/eval-report.md
bun run lint
bun run typecheck        # tsc --noEmit — a HARD gate, zero known errors

# optional: the DS categoriser service
cd services/categoriser && pip install -r requirements.txt
uvicorn main:app --port 8001
# then: CATEGORISER_URL=http://localhost:8001 bun run dev
```

Demo login: pick **Amina Wanjiru** (established beneficiary Jane → transfers flow to OTP + approval) or **Brian Otieno** — or the clearly-labelled **Demo officer console** entry (Officer Njeri) for the HITL side. Customers and officers get separate server-side sessions; the role split is enforced on every endpoint, not just in the UI.

### 3-minute demo script

Screenshots of every step live in `docs/screenshots/`.

1. **Fee determinism + citations** — chat: *"nikituma 15k kwa mpesa kutoka coop, charges ni how much?"* → computed fee (KES 23), tariff citation with effective date, `compute_fee` tool call visible in the trace panel. *(fee-answer.png)*
2. **Guardrails** — quick prompt *"Injection probe"* → refused at `guard_in` (score, signals); the audit chain records the refusal. Then *"Out of scope"* (weather) → answerability gate → handoff, never a guess.
3. **Transfer end-to-end** — *"Send 2000 to Jane on M-Pesa 0733445566"* → OTP card (code shown only in DEMO_MODE, default on) → enter code → pending approval → sign out → **Demo officer console** entry → **Approval queue** → approve → txn reference + fee returned; the customer transcript gets the completion receipt; audit tab shows `intent_signed → hitl_raised → transfer_executed`, chain verified green. Double-clicking approve replays the ORIGINAL receipt — never a second debit. *(console-approvals.png, console-approved.png, console-audit.png)*
4. **IDP** — *"I want to apply for a loan"* → payslip samples (clean/scanned) → extraction with confidence bars + evidence spans → validation rules → affordability computation → **Loan packs** tab → officer decides. *(console-loanpack.png)*
5. **Evals** — Ops console → Evaluations: last golden-set run, per-language (EN/SW/Sheng) breakdown, CI gate status. *(console-evals.png)*

---

## Repository layout

```
├── src/
│   ├── app/                    # Next.js app: page (chat + console), API routes
│   ├── components/hazina/      # chat view + ops console UI
│   ├── lib/                    # orchestrator, gateway, tools, banking mock, RAG, IDP, audit
│   └── eval/                   # golden set + harness (bun run eval)
├── packages/hazina-kit/        # reusable guardrails/signing/audit/eval primitives
├── services/categoriser/       # Data Science model service (FastAPI + sklearn)
├── prisma/                     # schema + synthetic seed
├── tests/                      # unit + contract tests
├── docs/
│   ├── governance/             # use-case cards, threat model, DPIA, CBK mapping, runbook
│   ├── adr/                    # architecture decision records
│   └── eval/eval-report.md     # generated one-page eval report
└── deploy/                     # docker-compose (app + categoriser + Prometheus + Grafana), Helm chart
```

## JD-to-evidence map

| Ad requirement | Where it lives | Proof for the reviewer |
|---|---|---|
| RAG, assistants, agents, tool-calling, IDP | RAG node, tool registry, orchestrator graph, payslip pipeline | Live demo (script above); eval report 100% on 55-case golden set |
| Secure design to approved architecture | Guardrails at input/context/tools/output; ADRs; threat model | `docs/governance/threat-model.md`, `docs/adr/` |
| Integrate DS models, keep separation | Categoriser service + contract tests + model card | `services/categoriser/`, `tests/categoriser-contract.test.ts` |
| Prompt engineering, evaluation, guardrails, HITL, fallback, audit, explainability | Prompt contracts in `rag.ts`; eval gate; guard_in/guard_out; approval queue; circuit-breaker fallback; hash chain; trace panel | `docs/eval/eval-report.md`, audit tab (verify chain), trace panel |
| Clean, tested code, peer review | 46 tests + CI (lint, typecheck, tests, eval gate, security scans) | `.github/workflows/ci.yml` |
| Monitoring and cost | `/api/metrics` (Prometheus format), cost per call in traces, Compose + Grafana | Monitoring tab; `deploy/` |
| Documentation, reusable components | This README, governance pack, `packages/hazina-kit` | `packages/hazina-kit/README.md` ("a new squad starts in one hour") |

## Governance pack (the differentiator)

- `docs/governance/use-case-cards.md` — one card per capability: purpose, risk tier, data, limitations, oversight, evaluation, fallback
- `docs/governance/threat-model.md` — STRIDE + OWASP LLM Top 10 mapped to implemented controls
- `docs/governance/cbk-mapping.md` — controls vs CBK draft instrument headings (model risk, data governance, third parties) + DPA 2019
- `docs/governance/dpia-template.md` — DPIA template pre-filled for the four use-cases
- `docs/governance/runbook.md` — what to do when things go wrong
- `docs/adr/` — seven ADRs recording the architectural bets and their trade-offs

## Deployment

- **Live app (Vercel):** one-click — `vercel.com/new/clone?repository-url=https://github.com/gadda00/hazina-assist` — zero config, zero env vars. The whole API ships as a **single serverless function** (`src/app/api/[[...path]]/route.ts` → `src/server/api/*.ts`) so the demo SQLite DB stays one shared `/tmp` copy instead of forking per-route lambdas. The Vercel posture is regression-tested locally by `scripts/run-vercel-sim.sh` (15 checks incl. the full HITL transfer flow). Full guide: **[`DEPLOY.md`](DEPLOY.md)**.
- **Local:** runs on SQLite (zero-config) — see Quickstart.
- **Production posture:** docker-compose (`deploy/docker-compose.yml`) with Postgres, the categoriser service, Prometheus scraping `/api/metrics` and Grafana; Helm chart for k8s (`deploy/helm/`). Set `HAZINA_INTENT_SECRET` and `DATABASE_URL` in the environment — never in code.

### Ship it: GitHub, Pages and Vercel in three steps

```bash
# 1. Push (creates the repo, enables GitHub Pages from main /docs,
#    sets topics — token used via HTTP headers only, never stored):
GH_TOKEN=<classic PAT: repo + workflow scopes> \
  ./scripts/push-to-github.sh <github-username>
```

2. **GitHub Pages** goes live at `https://<user>.github.io/hazina-assist/` within ~a minute — a static showcase of the build (capabilities, guarantee chain, eval results) served from `docs/`, linking to the live app.
3. **Vercel:** *Add New → Project* → import `hazina-assist` → *Deploy* (or the one-click clone URL above). No env vars needed for the demo: the build provisions the SQLite DB (`scripts/vercel-build.sh`), the bundle carries it (`outputFileTracingIncludes`), and the single API function clones it to a writable `/tmp` copy at cold start (`src/lib/db.ts`). For production, set `HAZINA_INTENT_SECRET` + a Postgres `DATABASE_URL` in project settings.

> **Honest note on the demo DB:** writes (chat history, audit events, staged transfers) live for the life of a lambda instance and reset to seed state when it recycles. That is a deliberate demo trade-off — the persistence contract (Prisma models, audit chain, idempotency) is unchanged; point `DATABASE_URL` at Postgres and everything works without code changes.

## Honest scope notes

- **Demo auth model**: sessions are server-side DB records with a random 192-bit bearer token (only its SHA-256 hash is stored); customers and officers get separate role-scoped sessions, every endpoint resolves the session from the token and rejects cross-session reads (403) and customer→officer mutations (403). It is deliberately simple, visible demo IAM — not production IAM: no OIDC, no MFA, no rotation.
- **OTP is a mock SMS channel**: crypto-random 6-digit codes, bound to the staged intent, single-active (reissue invalidates), 5-minute expiry, 3-attempt lockout. The code renders in the UI only while `DEMO_MODE` is on (default on — set `DEMO_MODE=false` to simulate a real channel).
- **Money is integer-cents**: every KES computation (fees, debits, balance checks, daily totals) goes through `src/lib/money.ts`; no bare float arithmetic on amounts anywhere in the transfer path.
- **Approvals are idempotent**: the decision is claimed atomically (`updateMany where status:"open"`), the debit and its idempotency key are written in ONE transaction, and replaying a decided approval returns the original receipt (`replayed: true`) — a double-click can never double-debit.
- The mock core banking mirrors Co-opConnect shapes (message references, idempotency, statement/transfer services) with synthetic data; a thin adapter to their sandbox would slot in behind the same interface.
- The reranker is a calibrated lexical proxy for a cross-encoder; the ranking contract (RRF fusion, answerability gate at 0.42) is identical to the production design.
- The golden set ships 55 cases covering every intent × language × risk cell; the scaling path to ~300 is documented in the eval report.
- No LLM-as-judge is used in the harness — all checks are programmatic, so there is no judge variance to calibrate. If a judge is introduced, the method note specifies hand-labelling ~50 items and reporting Cohen's κ.
- Security scans in CI (semgrep, bandit, trivy, pip/bun audit) are **informational** for this demo; lint, typecheck, tests, the eval gate and the production build are the enforced gates.
