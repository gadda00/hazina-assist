import { PrismaClient } from '@prisma/client'
import path from 'node:path'
import fs from 'node:fs'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Diagnostics captured while resolving/creating the client. Surfaced by
 * GET /api/health so a broken serverless deployment reports WHAT failed
 * instead of an anonymous HTTP 500.
 */
export const dbDiagnostics: {
  resolvedUrl: string | null
  searchedPaths: string[]
  initError: string | null
  engineCandidates: string[]
} = { resolvedUrl: null, searchedPaths: [], initError: null, engineCandidates: [] }

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
 * URL FORM: absolute `file:/…` URLs passed via the `datasources` option are
 * the one reliable form across bun and node — relative URLs resolve against
 * the GENERATED CLIENT directory (node_modules/.prisma/client), silently
 * creating an empty DB elsewhere. Never pass a relative URL here.
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? ''
  // Non-file URLs (Postgres etc.) pass through untouched.
  if (raw && !raw.startsWith('file:')) return raw

  // SQLite demo default when DATABASE_URL is unset (zero-config Vercel import).
  const rel = raw ? raw.slice('file:'.length) : './db/custom.db'

  // An explicitly-set RELATIVE file: URL (e.g. "file:./db/custom.db") must be
  // normalised to absolute-from-cwd BEFORE reaching the `datasources` option —
  // the option resolves relatives against the generated-client dir (see note).
  if (raw && !path.isAbsolute(rel)) {
    return `file:${path.resolve(process.cwd(), rel)}`
  }
  // An explicitly-set ABSOLUTE file: URL is the operator's choice — passthrough.
  if (raw) return raw

  const candidates = [
    path.resolve(process.cwd(), 'db', 'custom.db'),
    // Fallback for builds where a relative DATABASE_URL made the prisma CLI
    // seed against the schema dir (prisma/db/custom.db) — that file is traced
    // into the bundle by ./prisma/** too, so it is a valid runtime source.
    path.resolve(process.cwd(), 'prisma', 'db', 'custom.db'),
    // Common serverless function roots (Vercel lambdas) — cwd is usually
    // /var/task already, but tracing can place the project one level deeper.
    '/var/task/db/custom.db',
    '/var/task/app/db/custom.db',
  ]
  dbDiagnostics.searchedPaths = candidates

  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue
    dbDiagnostics.resolvedUrl = abs
    // ABSOLUTE file: URLs through the `datasources` option are the only form
    // reliable across runtimes: relative URLs resolve against the GENERATED
    // CLIENT directory (node_modules/.prisma/client), not cwd — verified by
    // tests/safety.test.ts and the Vercel simulation suite.
    return `file:${writableCopy(abs)}`
  }
  // Nothing found: absolute /tmp fallback — queries surface "table does not
  // exist" rather than an opaque constructor crash, and GET /api/health
  // reports the searched locations (never a relative URL — see note above).
  dbDiagnostics.resolvedUrl = null
  return 'file:/tmp/hazina-demo.db'
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

function createClient(): PrismaClient {
  const resolved = resolveDatasourceUrl()
  // `resolved` is always a string (never undefined): the PrismaClient
  // constructor cannot throw "URL must be a non-empty string" when
  // DATABASE_URL is unset — which would crash the whole function at
  // import time and 500 EVERY endpoint with an empty body.
  const url = resolved ?? 'file:/tmp/hazina-demo.db'
  dbDiagnostics.engineCandidates = [
    path.join(process.cwd(), 'node_modules/.prisma/client'),
    path.join(process.cwd(), 'node_modules/@prisma/client'),
  ].filter((p) => fs.existsSync(p))
  try {
    // `datasourceUrl` (the modern option) — the legacy nested `datasources`
    // form is silently dropped in some bundler contexts (Turbopack dev),
    // which makes the client fall back to schema-relative resolution and
    // open an EMPTY database elsewhere.
    return new PrismaClient({ datasourceUrl: url })
  } catch (e) {
    dbDiagnostics.initError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    // A client that throws a descriptive error on first use instead of
    // crashing the module graph. Health reports initError; other endpoints
    // fail loudly but with the consistent error envelope.
    const msg = `database init failed: ${dbDiagnostics.initError}`
    const stub = () => {
      throw new Error(msg)
    }
    return new Proxy({} as unknown as PrismaClient, {
      get: () => stub,
    })
  }
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
