# ADR-007 — Orchestration as an explicit state machine, not a free-roaming agent

**Status:** Accepted · **Date:** 2026-10-27

## Context
ReAct-style agents decide their own next action. That is the right shape for research tools and the wrong shape for regulated banking: unpredictable paths, unbounded tool loops, and no place to hang deterministic policy.

## Decision
The orchestrator (`src/lib/orchestrator.ts`) is an explicit graph with fixed node order: `guard_in → [otp short-circuit] → route → {rag | account_tools | transfer | idp} → policy_check → hitl → execute → guard_out → respond`. Routing is deterministic rules first (bilingual), with a constrained LLM tie-breaker that can only choose between two pre-computed labels — the LLM can never invent a route. Every node emits a trace event (rendered in the UI) and an audit event (hash-chained).

## Consequences
- Paths are enumerable; the golden set can cover them; refusal recall can be gated at 100% because refusals happen at a fixed node with deterministic rules.
- Prompt injection at worst produces a *refusal* or a *handoff* — there is no node that turns untrusted text into an action without the four ADR-004 gates.
- Trade-off: adding a new journey means adding a node (small, reviewed change) instead of a paragraph in a prompt. That is the point.
