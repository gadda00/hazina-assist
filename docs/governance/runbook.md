# Runbook — Hazina Assist

Operating procedures for the demo system, written the way an on-call engineer needs them: symptom → diagnosis → action. Every action that touches production data must appear on the audit chain; if it doesn't, it didn't happen.

## Health & first diagnosis

| Check | How |
|---|---|
| Liveness | `GET /api/health` → status, dependencies (database, modelGateway, categoriser) |
| Metrics | `GET /api/metrics` (Prometheus text) or the Monitoring tab |
| Chain integrity | `GET /api/audit` → `verification.ok` must be `true` |
| Last eval gate | `GET /api/eval` → `passed` |

## Incidents

### 1. Audit chain reports broken at index N
- **Meaning:** event N (or an earlier one) was modified or deleted outside the append path.
- **Action:** snapshot the DB immediately; diff `payload` of event N against change logs; treat as a **security incident** (tamper or operational error). Do NOT "fix" rows in place — the visible break is the evidence. Restore from the last known-good backup and investigate write access.
- **Prevention:** DB access is restricted to the app account; no manual UPDATE grants on `audit_log`.

### 2. Injection wave (guardrail trip rate spikes)
- **Symptom:** `hazina_guardrail_trips_total{kind="injection"}` jumps; refusals climb.
- **Action:** pull the flagged inputs from the audit chain (`guard_in` events carry `injection_signals`); classify novel patterns; add failing patterns as new rules + golden-set cases; ship behind the eval gate (refusal recall must stay 1.0).
- **Comms:** no customer action needed — refusals are the safe path.

### 3. External model down / degraded
- **Symptom:** gateway circuit opens (`modelGateway: circuit_open (fallback active)` in health); answers come from the deterministic composer with slightly terser wording; latency P50 drops.
- **Action:** none required for availability — all four journeys run on fallback. Verify fee answers still cite the tariff tool (they do — that path never used the model). If a provider outage persists > 1 h, consider switching the gateway to the self-hosted model endpoint (config, no code).

### 4. Categoriser service unreachable
- **Symptom:** health shows `local-fallback`; mini-statements still render with `fallback-rules` labels.
- **Action:** restart the service (`deploy/docker-compose.yml` or Helm). Check contract tests before rolling a new version: any label change is a **contract break** and requires the app-side enum update + eval re-run.

### 5. Transfer stuck in `pending_approval`
- **Action:** check the approval queue for an open task; if the customer abandoned, the intent expires naturally (15-min TTL) — the execute node will refuse it (`expired`) if approved late. No stuck money is possible: nothing moved.

### 6. Officer approved twice / double-click
- **Action:** none — the execute node is idempotent by message reference; a replayed approval gets `task_already_decided`, and a replayed core call returns the original result. Verified by tests.

### 7. P95 latency above SLO (3 s)
- **Diagnosis:** Monitoring tab → per-node trace latencies; typically the external model leg.
- **Action:** confirm circuit breaker is healthy; consider lowering the tie-breaker usage (more rules, fewer LLM route calls); scale horizontally — nodes are stateless.

### 8. Eval gate fails on a PR
- **Action:** read `docs/eval/eval-report.md` failed-cases section. Safety regressions (refusal recall < 1.0, fee numeric < 100%) are **never** waived. Quality regressions (route accuracy) may only be waived by the system owner with a linked ticket and a follow-up case added to the golden set.

## Change management

| Change | Required before merge |
|---|---|
| Prompt template | Version bump in git; eval re-run; faithfulness/citation metrics green |
| New tool | Scope definition + zod schema + registry entry + golden-set cases for its intents |
| Categoriser label | Contract bump on BOTH sides + app enum update + contract tests + eval |
| Guardrail rule | Unit tests for true-positive AND benign-negative; golden-set injection cell |
| Tariff data | New dated rows (never edit effective rows in place) — effective-dated pricing is the audit trail |
| Limits (caps/cooling-off) | Policy unit tests updated; values documented in the use-case card |

## Backup / restore

- SQLite demo: copy `db/` (stop writes first). Postgres: nightly base + WAL; restore drill quarterly, then **run chain verification** on the restored copy (`GET /api/audit`) — a restore that breaks the chain is a failed drill.
