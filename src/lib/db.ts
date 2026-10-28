import { PrismaClient } from '@prisma/client'
import path from 'node:path'
import fs from 'node:fs'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Resolve the SQLite datasource URL at RUNTIME (not generate time):
 * local dev, `bun run dev`, and the Next standalone server all have
 * different working directories — the demo DB lives at <cwd>/db/custom.db.
 * Non-file URLs (Postgres in production) pass through untouched.
 */
function resolveDatasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? ''
  if (!raw.startsWith('file:')) return undefined
  const p = raw.slice('file:'.length)
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
  if (fs.existsSync(abs)) return `file:${abs}`
  const cwdCandidate = path.resolve(process.cwd(), 'db', 'custom.db')
  if (fs.existsSync(cwdCandidate)) return `file:${cwdCandidate}`
  return undefined // let Prisma fall back to the schema-relative default
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: resolveDatasourceUrl()
      ? { db: { url: resolveDatasourceUrl()! } }
      : undefined,
    log: process.env.PRISMA_DEBUG === '1' ? ['query'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db