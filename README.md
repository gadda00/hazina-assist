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
# 0. local env (the prisma CLI reads DATABASE_URL from it)
cp .env.example .env          # then set the ABSOLUTE sqlite path inside

bun install
bun run db:push          # create SQLite schema (non-destructive; force variant exists for resets)
bun run seed             # synthetic customers, accounts, tariff guide, KB
bun run dev              # http://localhost:3000

# quality gates
bun test                 # 75 unit + contract + safety + race tests
bun run eval             # deterministic golden-set gate → docs/eval/eval-report.md
bun run lint
bun run typecheck        # tsc --noEmit — a HARD gate, zero known errors

# optional: the DS categoriser service
cd services/categoriser && pip install -r requirements.txt
uvicorn main:app --port 8001
# then: CATEGORISER_URL=http://localhost:8001 bun run dev
```

> If the login screen says **“Demo directory is empty”**, the database was
> re-provisioned without seed data — run `bun run seed` and reload.

Demo login: pick **Amina Wanjiru** (established beneficiary Jane → transfers flow to OTP + approval) or **Brian Otieno** — or the clearly-labelled **Demo officer console** entry (Officer Njeri) for the HITL side. Customers and officers get separate server-side sessions; the role split is enforced on every endpoint, not just in the UI. New: a third entry — **Guided tour** — walks a first-time visitor through the whole control journey in 8 steps (tariff question → citation → safe refusal → transfer → OTP → officer approval → audit verification), with each step stating what it shows *and what it does not prove*.

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
| Clean, tested code, peer review | 75 tests + CI (lint, typecheck, tests, eval gate, helm render, security scans) | `.github/workflows/ci.yml` |
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

**Demo / production boundary (explicit):** the app boots in `DEPLOYMENT_MODE=demo` by default — synthetic data, the demo identity picker, OTP code revealed in the UI, and a development signing-secret fallback. `DEPLOYMENT_MODE=operational` **fails closed at startup** (`src/instrumentation.ts` → `src/lib/deployment.ts`) unless a real ≥32-char `HAZINA_INTENT_SECRET`, `DEMO_MODE=false`, and an OTP delivery provider are configured; and because this build ships demo IAM only (no OIDC), login is refused outright in operational mode until a real IdP is integrated. Unit tests pin the fail-closed behaviour (`tests/deployment.test.ts`).

- **Live app (Vercel):** one-click — `vercel.com/new/clone?repository-url=https://github.com/gadda00/hazina-assist` — zero config, zero env vars. The whole API ships as a **single serverless function** (`src/app/api/[[...path]]/route.ts` → `src/server/api/*.ts`) so the demo SQLite DB stays one shared `/tmp` copy instead of forking per-route lambdas. The Vercel posture is regression-tested locally by `scripts/run-vercel-sim.sh` (15 checks incl. the full HITL transfer flow). Full guide: **[`DEPLOY.md`](DEPLOY.md)**.
- **Local:** runs on SQLite (zero-config) — see Quickstart.
- **Self-hosted demo stack:** docker-compose (`deploy/docker-compose.yml`) with the categoriser service, Prometheus (authenticated scrape — see below) and Grafana; Helm chart for k8s (`deploy/helm/`, `helm lint` + `helm template` are enforced in CI). Set `HAZINA_INTENT_SECRET` and `HAZINA_METRICS_TOKEN` in the environment — never in code.
- **Database: SQLite only in this build.** The Prisma schema pins the SQLite provider; a `postgresql://` `DATABASE_URL` is **not** usable without a Postgres schema/client/migration path, which is explicit roadmap work (see DEPLOY.md). Do not label a deployment “production-shaped” on the current database path.
- **Monitoring:** `/api/metrics` is never public. Prometheus authenticates with a dedicated scrape token (`HAZINA_METRICS_TOKEN` → Bearer credential in `deploy/prometheus.yml`; rotate both sides together); the ops console uses officer sessions. Metrics are audit-derived over the newest ≤5,000-event window and reset with the demo DB — documented in the endpoint itself.

### Ship it: GitHub, Pages and Vercel in three steps

```bash
# 1. Push (creates the repo, enables GitHub Pages from main /docs,
#    sets topics — token used via HTTP headers only, never stored):
GH_TOKEN=<classic PAT: repo + workflow scopes> \
  ./scripts/push-to-github.sh <github-username>
```

2. **GitHub Pages** goes live at `https://<user>.github.io/hazina-assist/` within ~a minute — a static showcase of the build (capabilities, guarantee chain, eval results) served from `docs/`, linking to the live app.
3. **Vercel:** *Add New → Project* → import `hazina-assist` → *Deploy* (or the one-click clone URL above). No env vars needed for the demo: the build provisions the SQLite DB (`scripts/vercel-build.sh`), the bundle carries it (`outputFileTracingIncludes`), and the single API function clones it to a writable `/tmp` copy at cold start (`src/lib/db.ts`). For a self-hosted deployment set `HAZINA_INTENT_SECRET` (+ scrape token) in the environment.

> **Honest note on the demo DB:** writes (chat history, audit events, staged transfers) live for the life of a lambda instance and reset to seed state when it recycles. That is a deliberate demo trade-off — the persistence contract (Prisma models, audit chain, idempotency) is unchanged. A durable database (Postgres) requires a provider-compatible schema/client path that this build does not yet ship — tracked as roadmap work, not a config change.

## Honest scope notes

- **Demo auth model**: sessions are server-side DB records with a random 192-bit bearer token (only its SHA-256 hash is stored); customers and officers get separate role-scoped sessions, every endpoint resolves the session from the token and rejects cross-session reads (403) and customer→officer mutations (403). It is deliberately simple, visible demo IAM — not production IAM: no OIDC, no MFA, no rotation. The demo identity picker is **disabled** in `DEPLOYMENT_MODE=operational` (fail-closed at boot AND at the login endpoint).
- **OTP is a mock SMS channel**: crypto-random 6-digit codes, bound to the staged intent, single-active (reissue invalidates), 5-minute expiry, 3-attempt lockout, and **atomic single-use consumption** (two simultaneous submissions of the same code succeed exactly once — race-tested). The code renders in the UI only while the demo OTP reveal is on (default in demo mode). `DEMO_MODE=false` hides the code but does **not** create a delivery channel — in operational mode the transfer flow refuses to run unless a real provider is configured.
- **Money is integer-cents**: every KES computation (fees, debits, balance checks, daily totals) goes through `src/lib/money.ts`; no bare float arithmetic on amounts anywhere in the transfer path.
- **Transfers are atomic end-to-end**: balance sufficiency, the daily cap and the debit are enforced inside ONE transaction via a conditional `UPDATE … WHERE balance >= total` (row-locked), the idempotency record is written in the same transaction, and a concurrent same-key duplicate fails the unique constraint and rolls back. Race tests cover two intents competing for the last funds, two intents racing the daily cap, and same-key replay (`tests/transfer-race.test.ts`).
- **Approvals are idempotent and attributed to the session**: the decision is claimed atomically (`updateMany where status:"open"`), and the recorded officer identity is **derived from the authenticated session** — a client-supplied name cannot rewrite the audit trail. A deliberate confirmation dialog repeats the exact transaction (source, beneficiary, amount, fee, total debit, irreversibility) before execution.
- The mock core banking mirrors Co-opConnect shapes (message references, idempotency, statement/transfer services) with synthetic data; a thin adapter to their sandbox would slot in behind the same interface.
- The reranker is a calibrated lexical proxy for a cross-encoder; the ranking contract (RRF fusion, answerability gate at 0.42) is identical to the production design.
- **The eval gate is a deterministic CI gate, not a model-quality benchmark**: CI deliberately runs without an external model; the 55-case golden set measures routing, guardrail behaviour, refusal recall, fee numeric correctness and citation presence through the real orchestrator. It does not measure open-ended answer quality of an external LLM, and citation presence does not prove citation-to-claim faithfulness. The scaling path to ~300 cases is documented in the eval report.
- **Audit is tamper-evident, not immutable**: the hash chain is recomputed on read over the newest ≤10,000 events and the UI states the verified coverage exactly. A privileged database writer could still rewrite history and recompute hashes — independent anchoring (signed checkpoints / append-only store) is roadmap work.
- No LLM-as-judge is used in the harness — all checks are programmatic, so there is no judge variance to calibrate. If a judge is introduced, the method note specifies hand-labelling ~50 items and reporting Cohen's κ.
- **Security scans are labelled**: blocking in CI = gitleaks (secrets), bandit, SBOM generation, helm lint/render; advisory (report-only) = semgrep, pip-audit, bun audit, trivy. Enforced quality gates = lint, typecheck, tests, the eval gate, the production build.
