# ADR-004 — Writes require signed intents, OTP step-up and human approval

**Status:** Accepted · **Date:** 2026-10-27

## Context
OWASP LLM06 (excessive agency): an assistant that can call a transfer API is one prompt-injection away from moving money. Even with tools "read-only by default", the write path needs an architecture where the model is structurally incapable of executing.

## Decision
Four gates, in order, none skippable:
1. **Deterministic policy** — caps, cooling-off, funds check (LLM never sees this logic).
2. **OTP step-up** issued and verified entirely outside the LLM context.
3. **HMAC-signed intent** — `{sid, intent, exp, nonce}` signed server-side; execution verifies signature (constant-time), TTL and single-use nonce.
4. **HITL approval** — an officer's click, recorded on the audit chain, before the execute node runs; the core API call carries an idempotency key so replays return the original result instead of double-spending.

## Consequences
- The model can only ever *propose*; compromise of the model yields zero money movement.
- The approve-then-replay window is closed twice (nonce + idempotency).
- Trade-off: more round-trips for the customer. In banking, that is the correct trade.
