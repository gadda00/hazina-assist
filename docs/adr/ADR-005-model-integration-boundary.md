# ADR-005 — Data Science models integrate via versioned contracts, never shared code

**Status:** Accepted · **Date:** 2026-10-27

## Context
The job ad's sharpest line: *integrate models built by Data Scientists, with a clear separation between integration and model development*. The failure mode it guards against is the app team importing model internals (or the DS team shipping code into the app) until ownership blurs and neither side can change safely.

## Decision
The transaction categoriser is a **separate service** (`services/categoriser/`, own repo in production) exposing a versioned OpenAPI contract. The app:
- consumes it only through `POST /v1/categorise`,
- validates every response against the label **enum at runtime** (an out-of-contract label is treated as a service failure, not rendered),
- records the model version per enrichment on the audit chain,
- runs **contract tests** on both sides (app: `tests/categoriser-contract.test.ts`; service: `test_main.py` pins the schema and the 14-label enum),
- keeps a contract-compatible local fallback so the app is deployable independently.

Adding a label is a deliberate breaking change: bump the service version, update the app enum, re-run both suites and the eval gate.

## Consequences
- Ownership is crisp: DS ships models + cards + contract; the app ships integration.
- Model-version provenance is auditable end-to-end.
- Trade-off: a fallback classifier duplicates a fraction of logic — bounded to a keyword map over the same labels, tested to the same contract.
