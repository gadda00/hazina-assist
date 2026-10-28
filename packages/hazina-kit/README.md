# @hazina/kit — the reusable bank-grade LLM kit

**How a new squad starts in one hour.** Everything a team needs to stand up a governed LLM feature: guardrails, signed-action intents, PII pseudonymisation, a hash-chained audit logger, deterministic policy, evaluation metrics and hybrid retrieval — pure TypeScript, zero framework dependencies (only `node:crypto`), liftable into any Node/Bun service.

## Install

```bash
# from this monorepo (publish to your registry in production)
bun add @hazina/kit        # or: npm i @hazina/kit
```

## The one-hour path

```ts
import {
  // 1. guard the input (5 min)
  detectInjection,            // OWASP LLM01 — EN/SW/code-mixed rules, refuse-first
  detectPii, pseudonymise,    // Kenyan recognisers + reversible tokenisation
  detectLanguage,             // en / sw / mixed
  // 2. sign your writes (10 min)
  signIntent, verifyIntent,   // HMAC-SHA256 {sid,intent,exp,nonce}, constant-time
  // 3. deterministic policy (10 min)
  checkTransferPolicy, computeAffordability,
  // 4. hash-chained audit (10 min)
  eventHash, GENESIS_HASH, verifyChain, canonicalEvent,
  // 5. retrieval with an answerability gate (15 min)
  bm25Scores, denseScores, rrfFuse, rerank,
  // 6. evaluate and gate CI (10 min)
  summarise, gate, DEFAULT_GATE,
  // 7. output guards
  guardOut, groundedness, redactPii, wrapUntrusted,
} from "@hazina/kit";
```

### Minute 0–15: guard input, sign writes

```ts
// refuse injections before ANY model call
const inj = detectInjection(userText);
if (inj.flagged) return refuse(inj.signals);

// pseudonymise before external egress (DPA s.48 safeguard)
const { text, mappings } = pseudonymise(userText);

// writes: the model proposes; the server signs; the executor verifies
const tok = signIntent(secret, sessionId, { amount: 2000, to: "acct_9c1e" }, 900);
// later:
const ok = (await verifyIntent(secret, tok, sessionId, { isNonceUsed })).ok;
```

### Minute 15–30: audit chain

```ts
// appends (serialise writes; see ADR-006 for the Postgres advisory-lock pattern)
const hash = eventHash(prevHash, event);
await db.insert({ payload: canonicalEvent(event), prevHash, hash });

// verify — recompute the whole chain, report the first broken index
const { ok, brokenAt } = verifyChain(rows.map(r => ({
  payload: r.payload, prevHash: r.prevHash, hash: r.hash,
})));
```

### Minute 30–60: retrieval + eval gate

```ts
const fused = rrfFuse(bm25Scores(q, docs), denseScores(q, docs)).slice(0, 6);
const scores = rerank(q, candidates);            // 0..1
if ((scores.get(top.id) ?? 0) < 0.42) {          // answerability gate
  return handOffWithSummary();                   // never guess
}

// CI: golden set through your real pipeline, then
const summary = summarise(results);
const { passed, failures } = gate(summary);      // thresholds that block the PR
if (!passed) process.exit(1);
```

## What each module gives you

| Module | What it does | Key guarantee |
|---|---|---|
| `signing` | Signed action intents | Model can propose; only the server's HMAC + TTL + single-use nonce executes |
| `pii` | Kenyan recognisers (KRA PIN, phones, IDs, accounts, email) with context gates | Overlap-deduped detection; reversible pseudonymisation with server-side vault |
| `injection` | Refuse-first heuristics incl. Swahili/Sheng patterns | Any flag ≥ 0.5 refuses — no "sanitise and continue" |
| `guards` | Groundedness, PII-leak scan, advice filter, language match; hash-chain + language ID | Answers provably grounded; audit recomputable |
| `policy` | Transfer caps/cooling-off; affordability arithmetic | Enforcement in code, not prompts (LLM never does money math) |
| `eval` | Case/summary types, metrics (route accuracy, refusal P/R, numeric match…), CI gate | 100%-refusal-recall and 100%-numeric-match gates by default |
| `retrieval` | BM25 + dense proxy, RRF fusion, stopword-safe reranker | Answerability gate that out-of-scope questions cannot pass |

## Design rules baked in

1. **Deterministic over probabilistic wherever money or rights are involved** — policy, fees, affordability, signatures are arithmetic and HMACs, never model output.
2. **Refuse-first on injection** — a flagged message is refused, not cleaned and continued.
3. **The stored string IS the hashed string** — canonical serialisation everywhere, so verification is exact.
4. **Fail loud** — chain breaks surface in the UI; contract violations surface as service failures.

## Versioning

`0.1.x` — the initial kit extracted from Hazina Assist. Semver: adding a recogniser or injection rule is a minor bump; changing signature/canonical formats or gate defaults is a major bump (those change verification outcomes).
