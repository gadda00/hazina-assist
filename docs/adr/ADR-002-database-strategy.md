# ADR-002 — SQLite for the demo, Postgres for production, one schema

**Status:** Accepted · **Date:** 2026-10-27

## Context
The system needs relational state (sessions, accounts, intents, approvals, audit) and must run (a) zero-config in a serverless demo and (b) on managed Postgres in a bank's environment. Two schemas would drift.

## Decision
One Prisma schema. SQLite locally/serverless (single file, ships in the repo); Postgres in docker-compose/Helm with the same models. Retrieval-specific production features (tsvector, pgvector) are additive: the ranking contract (hybrid channels + RRF + rerank + answerability gate) is implemented once in `@hazina/kit` and is backend-agnostic.

## Consequences
- The demo deploys anywhere (including Vercel) with no database service; `DATABASE_URL` is the only switch.
- SQLite's single-writer semantics serialise audit appends trivially; on Postgres the same code runs inside a transaction and an advisory lock replaces the implicit queue (ADR-006 documents the equivalence).
- Trade-off: SQLite lacks native vector search — the dense channel is a lexical-overlap proxy in the demo. The production upgrade path (pgvector behind the same `denseScores` interface) is a contained change.
