# PII Detection — Coverage & Limits (honest specification)

> Deep-review P2-10: privacy claims must match the implemented detector.
> This document states exactly what `packages/hazina-kit/src/pii.ts` detects,
> what it does not, where raw and transformed text live, and what leaves the
> server. Treat every privacy/compliance statement elsewhere in this repo as
> **design intent pending qualified legal/security review** — not as a
 validated control.

## Detected entity types (regex recognisers, Kenya-flavoured)

| Type | Pattern | Base score | Notes |
|---|---|---|---|
| `kra_pin` | `[AP]\d{9}[A-Z]` | 0.95 | KRA PIN format |
| `phone` | `+254[17]xxxxxxxx` / `07xx`/`01xx` 9-digit | 0.90 | Kenyan mobile formats only |
| `national_id` | bare 8-digit number | 0.45 → 0.95 | **context-gated**: needs `id/identity/pin number/national/ktp/kitambulisho/ID No` within 30 chars before — suppresses false positives on amounts and references |
| `account_number` | 10–14 digit number | 0.40 → 0.90 | **context-gated**: needs `account/acct/acc no/a\/c/hesabu` nearby |
| `email` | standard email shape | 0.95 | |
| `name` | — | — | **NO general name recogniser ships.** Names pass through unless they match another type. |

Overlapping matches resolve to the highest-scoring recogniser (a 10-digit
phone read as phone, not account number).

## Known gaps — what WILL escape detection

- **Personal names** ("Jane Muthoni") — no NER model; only structured
  identifiers are caught.
- **Physical addresses**, employer names, dates of birth, family relations,
  IP addresses, device identifiers.
- **International phone formats** (non-Kenyan), non-Kenyan national IDs,
  passport numbers.
- **Mixed-language obfuscation** — a KRA PIN written with spaces
  (`A123 456 789Z`) or a phone in words is not caught.
- Numeric identifiers in **unusual contexts** — the context gates that
  suppress false positives also let true positives through when the
  surrounding text lacks the keyword.

## Where text is stored, and in what form

| Store | Content | Redaction |
|---|---|---|
| `Message.content` (app DB) | **Full raw chat text** | none — operational data store, deleted with the demo DB |
| `AuditEvent.payload` (app DB) | Redacted copies of string values (`[phone]`, `[kra_pin]`…) | yes — `redactPii` on every string field before hashing |
| `PseudonymVault` (app DB) | token → original mapping per session | server-side only; used to re-hydrate model replies |
| Model-gateway request | Pseudonymised text (tokens) when an external model is configured | yes — `pseudonymise` before egress; originals never leave the server |
| Payslip fields (`PayslipPack`) | Extracted employer/employee/PIN values | none — operational data for the officer review flow |

**Egress summary**: with no model credentials (the default demo posture) no
text leaves the process at all — the deterministic fallback answers locally.
With an external model configured, only tokenised text is sent; the vault and
all raw data stay in the app database. Retention = demo DB lifetime; deletion
= deleting/resetting the DB file (demo posture). There is no per-subject
export/erasure API — that is production data-governance work.

## What the guardrails actually claim

1. **Pseudonymisation is risk reduction, not anonymisation** — tokens are
   reversible inside the server, and free-text names/addresses are not
   tokenised at all.
2. **Audit payloads are redacted**, so the tamper-evident chain does not
   become a PII ledger.
3. **DPA 2019 s.48 (cross-border) narrative** in the README/governance pack
   describes the design intent (pseudonymise-before-egress + switchable
   self-hosted model). It is not a validated legal safeguard; qualified
   counsel must review any real-data deployment.

## Roadmap to evidence-grade coverage

- NER-based name/address recogniser (or a structured-collection-first UI
  design that avoids free-text PII entirely — the stronger option).
- Multilingual + obfuscation test corpus (EN/SW/Sheng) as eval cases.
- Per-subject export & erasure endpoints; retention windows; access log for
  the vault.
- Independent privacy review sign-off before any real-data pilot.
