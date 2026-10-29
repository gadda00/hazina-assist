#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Vercel build entrypoint (referenced from vercel.json).
#
# Vercel runs this instead of `next build` directly so the demo SQLite DB is
# provisioned at BUILD time (schema push + synthetic seed). The DB file is
# then traced into the serverless bundle via next.config.ts
# (outputFileTracingIncludes) and cloned to /tmp at runtime (src/lib/db.ts).
#
# Zero dashboard env vars required for the demo: DATABASE_URL defaults to
# file:./db/custom.db when unset. Set HAZINA_INTENT_SECRET (HMAC intent
# signing) and a Postgres DATABASE_URL in the Vercel project settings for
# anything beyond the demo posture.
# ---------------------------------------------------------------------------
set -euo pipefail

# ABSOLUTE path: the prisma CLI resolves relative file: URLs against the
# SCHEMA directory (prisma/), which would seed prisma/db/custom.db while the
# runtime resolver looks for db/custom.db — the two must agree.
export DATABASE_URL="${DATABASE_URL:-file:$(pwd)/db/custom.db}"

echo "◆ prisma db push (provisioning demo schema at $DATABASE_URL)"
bun run db:push

echo "◆ seeding synthetic demo data (customers, tariffs, KB, beneficiaries)"
bun run seed

echo "◆ next build"
bun run build
