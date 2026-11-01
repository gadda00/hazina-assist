/**
 * Test preload — the test command is SELF-CONTAINED (deep-review P0-2).
 *
 * `bun test ./tests/` works from a CLEAN CHECKOUT with zero manual setup:
 * this preload runs before any test file (and therefore before any transitive
 * `@/lib/db` / `new PrismaClient()` import) and provisions an ISOLATED
 * throwaway SQLite database — schema pushed + demo data seeded — then points
 * DATABASE_URL at it.
 *
 * Isolation rules (no shared mutable test database for parallel runs):
 *   - HAZINA_TEST_DB_URL set  → use it verbatim; the CALLER owns provisioning
 *                               (CI / `bun run verify` use this for a shared,
 *                               job-scoped DB). Parallel jobs pass distinct URLs.
 *   - otherwise               → create `hazina-test-<pid>-<rand>.db` in the OS
 *                               temp dir, provision it, delete it on exit.
 * The ambient DATABASE_URL is deliberately NEVER inherited by tests: a dev's
 * local demo database must not be trashed by a test run.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      `[tests/setup.ts] provisioning step failed (${cmd} ${args.join(" ")}):\n` +
        `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`
    );
  }
}

function provision(dbUrl: string): void {
  const env = { ...process.env, DATABASE_URL: dbUrl };
  // schema first (no destructive flags — creates tables in the throwaway DB)
  run("bun", ["x", "prisma", "db", "push", "--skip-generate"], env);
  // then the demo dataset (same seed the server's auto-heal replays)
  run("bun", ["run", path.join(ROOT, "prisma", "seed.ts")], env);
}

const external = process.env.HAZINA_TEST_DB_URL?.trim();
let dbUrl: string;
let cleanupFile: string | null = null;

if (external) {
  dbUrl = external;
} else {
  const file = path.join(
    os.tmpdir(),
    `hazina-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}.db`
  );
  dbUrl = `file:${file}`;
  cleanupFile = file;
}

// Provision with the PLAIN URL (the Prisma CLI does not parse query
// params on file: URLs), then point the runtime at a SINGLE-CONNECTION
// pool: every transaction queues on one connection, which is exactly
// SQLite's single-writer reality — concurrent writers serialise instead
// of storming SQLITE_BUSY (deterministic, no busy-timeout flakiness).
const runtimeUrl = external ? dbUrl : `${dbUrl}?connection_limit=1`;

if (!external) {
  provision(dbUrl);
  process.env.DATABASE_URL = runtimeUrl;
  // best-effort cleanup — a throwaway DB must never accumulate in /tmp
  process.on("exit", () => {
    for (const p of [cleanupFile, `${cleanupFile}-journal`, `${cleanupFile}-wal`, `${cleanupFile}-shm`]) {
      if (p) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  });
} else {
  process.env.DATABASE_URL = runtimeUrl;
}
