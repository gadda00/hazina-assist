# ADR-006 — Audit trail as an append-only hash chain

**Status:** Accepted · **Date:** 2026-10-27

## Context
Bank audit logs must be tamper-evident. Plain append-only tables rely on access control alone; a privileged UPDATE is invisible. The 2026 CBK instruments and DPA integrity principles both reward provable history.

## Decision
Every event stores `{payload (canonical, PII-redacted), prev_hash, hash}` where `hash = SHA-256(prev_hash + payload)`. Appends are serialised (transaction; SQLite's single writer / Postgres advisory lock). `GET /api/audit` **recomputes the entire chain on every read** and reports the first broken index. A `verifyChain` command is demoed in the UI (green/red banner).

## Consequences
- Tampering is detectable within one page load; unit tests prove a single edited byte breaks the chain at the right index.
- The exact string stored is the exact string hashed (canonical key order) — the roundtrip bug this prevented was real and caught during the build.
- Trade-off: chain verification is O(n); at demo scale it is instant, at bank scale it becomes a periodic job + Merkle checkpoints (documented as the scale path).
