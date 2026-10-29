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

/** "KES 12,345.50" / "12,345.5" — display formatting, single source of truth. */
export function formatKes(kes: number | null | undefined): string {
  const v = kes ?? 0
  const hasFraction = Math.abs(v * 100 - Math.round(v * 100)) > 1e-9 || Math.round(v * 100) % 100 !== 0
  return `KES ${v.toLocaleString("en-KE", { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })}`
}
