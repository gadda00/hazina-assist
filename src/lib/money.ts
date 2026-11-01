/**
 * Money — strict decimal helper for KES.
 *
 * SQLite columns are Float, so every arithmetic path MUST go through these
 * integer-cents helpers: parse once, compute in cents, format once. No
 * bare `a + b` on KES anywhere in transfer/banking logic.
 */
export function toCents(kes: number): number {
  if (!Number.isFinite(kes)) throw new Error(`invalid amount: ${kes}`)
  return Math.round(kes * 100)
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

/** a + b in KES, computed in cents (no float drift). */
export function addKes(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b))
}

/** a − b in KES, computed in cents. */
export function subKes(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b))
}

/** true when a ≥ b comparing cents exactly. */
export function gteKes(a: number, b: number): boolean {
  return toCents(a) >= toCents(b)
}

/** Round a computed fee to 2dp (tariff percent rows produce fractions). */
export function roundKes(kes: number): number {
  return fromCents(toCents(kes))
}

/** Validate + normalise a customer-supplied KES amount; null when invalid. */
export function parseAmountKes(raw: number | null | undefined): number | null {
  if (raw == null || typeof raw !== "number" || !Number.isFinite(raw)) return null
  if (raw <= 0 || raw > 1_000_000_000) return null
  return roundKes(raw)
}

/**
 * STRICT money-input validation for consequential writes (deep-review P1-5).
 * Unlike parseAmountKes (display-tolerant, rounds sub-cent input), this
 * REJECTS anything the cents domain cannot represent exactly:
 *   - NaN / ±Infinity / negative zero (-0 === 0 but signals a broken sender);
 *   - zero and negative amounts;
 *   - sub-cent precision (10.001 is refused, never silently rounded);
 *   - out-of-range values above the operational limit.
 * Transfers are staged only through this gate — persisted money can always
 * be expressed in exact integer cents.
 */
export function parseAmountStrictKes(raw: number | null | undefined): number | null {
  if (raw == null || typeof raw !== "number") return null
  if (!Number.isFinite(raw)) return null // NaN, +Inf, -Inf
  if (raw === 0 || Object.is(raw, -0)) return null // zero and negative zero
  if (raw < 0) return null
  if (raw > 1_000_000_000) return null
  const cents = Math.round(raw * 100)
  // exact 2dp representation only: 10.001 → cents 1000 ≠ 1000.1 → rejected
  if (Math.abs(cents - raw * 100) > 1e-9) return null
  return cents / 100
}

/** "KES 12,345.50" / "12,345.5" — display formatting, single source of truth. */
export function formatKes(kes: number | null | undefined): string {
  const v = kes ?? 0
  const hasFraction = Math.abs(v * 100 - Math.round(v * 100)) > 1e-9 || Math.round(v * 100) % 100 !== 0
  return `KES ${v.toLocaleString("en-KE", { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })}`
}
