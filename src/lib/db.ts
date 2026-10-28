import { PrismaClient } from '@prisma/client'
import path from 'node:path'
import fs from 'node:fs'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Resolve the SQLite datasource URL at RUNTIME (not generate time):
 * local dev, `bun run dev`, and serverless deploys all have different
 * working directories — the demo DB lives at <repo>/db/custom.db.
 *
 * Serverless nuance (Vercel): the traced bundle is READ-ONLY, so the demo
 * DB is cloned to /tmp once per lambda instance before first use. Writes
 * live for the life of that instance (demo posture — see README); a real
 * deployment points DATABASE_URL at Postgres, which passes through untouched.
 *
 * If DATABASE_URL is unset entirely, the SQLite demo default applies, which
 * keeps a fresh Vercel import zero-config (no dashboard env vars required).
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? ''
  // Non-file URLs (Postgres etc.) pass through untouched.
  if (raw && !raw.startsWith('file:')) return undefined

  // SQLite demo default when DATABASE_URL is unset (zero-config Vercel import).
  const rel = raw ? raw.slice('file:'.length) : './db/custom.db'

  const candidates = [
    path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel),
    path.resolve(process.cwd(), 'db', 'custom.db'),
  ]

  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue
    return `file:${writableCopy(abs)}`
  }
  return undefined // let Prisma fall back to the schema-relative default
}

/**
 * On read-only serverless filesystems (Vercel lambdas), clone the demo DB to
 * /tmp once per instance so chat/audit/transfer writes succeed. Reads of the
 * original would work without this — writes would fail with SQLITE_READONLY.
 */
function writableCopy(abs: string): string {
  if (!process.env.VERCEL || abs.startsWith('/tmp')) return abs
  const tmp = '/tmp/hazina-demo.db'
  try {
    if (!fs.existsSync(tmp)) fs.copyFileSync(abs, tmp)
    return tmp
  } catch {
    return abs // read-only original: reads work, writes will surface an error
  }
}

const resolved = resolveDatasourceUrl()

export const db =
  globalForPrisma.prisma ??
  new PrismaClient(
    resolved ? { datasources: { db: { url: resolved } } } : undefined
  )

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
