/**
 * Hazina Assist brand mark.
 *
 * "Hazina" is Swahili for *treasure*: the mark is a shield (bank-grade
 * safety, the guardrails story) holding a faceted gem (the customer's
 * money / the treasure). Emerald + gold match the app palette, so it sits
 * cleanly on the emerald-950 header, the login gradient and white surfaces.
 *
 * Pure inline SVG — no image fetch, crisp at any size (16px favicon
 * neighbourhood up to the login hero), and inherits currentColor for the
 * wordmark variant.
 */

const SHIELD_ID = "hz-shield";
const GEM_ID = "hz-gem";

export function HazinaMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Hazina Assist" data-testid="hazina-logo">
      <defs>
        <linearGradient id={SHIELD_ID} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="0.5" stopColor="#10b981" />
          <stop offset="1" stopColor="#065f46" />
        </linearGradient>
        <linearGradient id={GEM_ID} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.5" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
      </defs>
      {/* shield */}
      <path
        d="M32 5 L48 11.5 V29 C48 40 41 47.4 32 52 C23 47.4 16 40 16 29 V11.5 Z"
        fill={`url(#${SHIELD_ID})`}
        stroke="#fbbf24"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* gem — kite cut */}
      <path
        d="M24.5 26 L28.5 19.5 H35.5 L39.5 26 L32 38.5 Z"
        fill={`url(#${GEM_ID})`}
        stroke="#92400e"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* facets */}
      <path
        d="M24.5 26 H39.5 M28.5 19.5 L32 38.5 L35.5 19.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.55"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* table sparkle */}
      <path
        d="M29.5 22.5 L32 20 L34.5 22.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.9"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark + wordmark lockup used on the login screen and larger surfaces. */
export function HazinaLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="shrink-0 rounded-xl bg-white/10 border border-amber-300/30 p-1.5 shadow-inner">
        <HazinaMark className={compact ? "h-7 w-7" : "h-10 w-10"} />
      </div>
      <div className="min-w-0">
        <div className={`font-semibold tracking-tight leading-tight ${compact ? "text-base" : "text-2xl"}`}>Hazina Assist</div>
        {!compact && (
          <div className="text-emerald-200/80 text-sm mt-0.5">Safety-oriented synthetic banking demo</div>
        )}
      </div>
    </div>
  );
}
