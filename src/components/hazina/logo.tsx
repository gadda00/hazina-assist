"use client";

/**
 * Hazina Assist brand mark — "The Vault" edition.
 *
 * "Hazina" is Swahili for *treasure*: the mark is a shield (bank-grade
 * safety, the guardrails story) holding a faceted gem (the customer's
 * money / the treasure). Jade shield + gold gem on the deep vault
 * palette; a slow light sheen sweeps the gem every few seconds.
 *
 * Pure inline SVG — no image fetch, crisp at any size (16px favicon
 * neighbourhood up to the login hero), and inherits currentColor for the
 * wordmark variant.
 */

const SHIELD_ID = "hz-shield";
const GEM_ID = "hz-gem";
const GEM_CLIP_ID = "hz-gem-clip";

export function HazinaMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Hazina Assist" data-testid="hazina-logo">
      <defs>
        <linearGradient id={SHIELD_ID} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#43bd8c" />
          <stop offset="0.45" stopColor="#1d9a6b" />
          <stop offset="1" stopColor="#0b4d38" />
        </linearGradient>
        <linearGradient id={GEM_ID} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#f6e3ac" />
          <stop offset="0.5" stopColor="#e8c468" />
          <stop offset="1" stopColor="#b07f2e" />
        </linearGradient>
        <linearGradient id="hz-sheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={GEM_CLIP_ID}>
          <path d="M24.5 26 L28.5 19.5 H35.5 L39.5 26 L32 38.5 Z" />
        </clipPath>
      </defs>
      {/* shield — jade with engraved gold rim */}
      <path
        d="M32 5 L48 11.5 V29 C48 40 41 47.4 32 52 C23 47.4 16 40 16 29 V11.5 Z"
        fill={`url(#${SHIELD_ID})`}
        stroke="#e8c468"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {/* inner engraved line */}
      <path
        d="M32 8.5 L45.5 14 V28.8 C45.5 38.2 39.6 44.8 32 49 C24.4 44.8 18.5 38.2 18.5 28.8 V14 Z"
        fill="none"
        stroke="#f6e3ac"
        strokeOpacity="0.35"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* gem — kite cut */}
      <path
        d="M24.5 26 L28.5 19.5 H35.5 L39.5 26 L32 38.5 Z"
        fill={`url(#${GEM_ID})`}
        stroke="#7a5a1e"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      {/* facets */}
      <path
        d="M24.5 26 H39.5 M28.5 19.5 L32 38.5 L35.5 19.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.55"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {/* table sparkle */}
      <path
        d="M29.5 22.5 L32 20 L34.5 22.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.9"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* slow sheen sweep across the gem */}
      <g clipPath={`url(#${GEM_CLIP_ID})`}>
        <rect
          className="gem-sheen-bar"
          x="18"
          y="16"
          width="10"
          height="26"
          fill="url(#hz-sheen)"
        />
      </g>
    </svg>
  );
}

/** Mark + wordmark lockup used on the login screen and larger surfaces. */
export function HazinaLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3.5">
      <div className="shrink-0 rounded-2xl bg-vault-950/40 border border-gold-500/25 p-2 shadow-[0_8px_24px_-8px_oklch(0.10_0.012_170/0.9),inset_0_1px_0_oklch(0.92_0.07_98/0.12)]">
        <HazinaMark className={compact ? "h-7 w-7" : "h-11 w-11"} />
      </div>
      <div className="min-w-0">
        <div className={`font-display font-semibold tracking-tight leading-tight text-vault-50 ${compact ? "text-lg" : "text-[1.7rem]"}`}>
          Hazina <span className="italic font-normal text-gold-300">Assist</span>
        </div>
        {!compact && (
          <div className="text-vault-300/90 text-[13px] mt-1 tracking-wide">
            Safety-oriented synthetic banking demo
          </div>
        )}
      </div>
    </div>
  );
}
