/**
 * `bun run verify` — the ONE deterministic quality gate (deep-review P0-2/P2-14).
 *
 * Prepares isolated throwaway databases, then runs IN ORDER and fails on any
 * step: lint → typecheck → tests (self-provisioned isolated DB) → evaluation
 * gate → production build (type-validated; ignoreBuildErrors is gone).
 *
 * Emits a machine-readable summary to docs/eval/verification.json (commit SHA,
 * toolchain versions, test counts, eval metrics, DB provider, build status) so
 * README claims are generated from evidence instead of hand-maintained.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SUMMARY_PATH = path.join(ROOT, "docs", "eval", "verification.json");

interface StepResult {
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; stdout: string } {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  return { code: res.status ?? -1, stdout: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function pkgVersion(name: string): string {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")) as {
      version: string;
    };
    return p.version;
  } catch {
    return "unknown";
  }
}

/** Provision a throwaway SQLite DB (schema + demo seed) for eval/build. */
function provisionTmpDb(): string {
  const file = path.join(os.tmpdir(), `hazina-verify-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`);
  const url = `file:${file}`;
  const env = { ...process.env, DATABASE_URL: url };
  for (const args of [
    ["x", "prisma", "db", "push", "--skip-generate"],
    ["run", path.join(ROOT, "prisma", "seed.ts")],
  ]) {
    const res = sh("bun", args, env);
    if (res.code !== 0) throw new Error(`provisioning failed: bun ${args.join(" ")}\n${res.stdout}`);
  }
  return url;
}

// Deterministic TEST-ONLY HMAC key: signs intents during the isolated verify run
// against a throwaway SQLite DB. Production never uses it — `HAZINA_INTENT_SECRET`
// must come from the environment (>=32 chars, fail-closed in operational mode —
// see src/lib/transfer.ts). Allowlisted for gitleaks (generic-api-key FP).
const INTENT_SECRET = "verify-secret-0123456789abcdef"; // gitleaks:allow

console.log("┌──────────────────────────────────────────────────────────────┐");
console.log("│ hazina-assist — bun run verify (isolated, deterministic)    │");
console.log("└──────────────────────────────────────────────────────────────┘");

const steps: Record<string, StepResult> = {};
let evalDbUrl = "";
try {
  evalDbUrl = provisionTmpDb();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

function runStep(name: string, cmd: string[], env: NodeJS.ProcessEnv = {}): StepResult {
  const t0 = Date.now();
  console.log(`\n▶ ${name}  (${cmd.join(" ")})`);
  const res = sh(cmd[0], cmd.slice(1), env);
  const r: StepResult = { ok: res.code === 0, durationMs: Date.now() - t0, exitCode: res.code };
  steps[name] = r;
  // stream the interesting tail so the operator sees real evidence
  const tail = res.stdout.trimEnd().split("\n").slice(-6).join("\n");
  if (tail) console.log(tail);
  console.log(r.ok ? `✔ ${name} passed (${r.durationMs}ms)` : `✘ ${name} FAILED (exit ${res.code})`);
  return r;
}

runStep("lint", ["bun", "run", "lint"]);
runStep("typecheck", ["bun", "run", "typecheck"]);
const testRes = sh("bun", ["run", "test"], { HAZINA_INTENT_SECRET: INTENT_SECRET });
steps.test = { ok: testRes.code === 0, durationMs: 0, exitCode: testRes.code };
console.log("\n▶ test  (bun run test — self-provisioned isolated DB)");
{
  const tail = testRes.stdout.trimEnd().split("\n").slice(-4).join("\n");
  if (tail) console.log(tail);
  console.log(steps.test.ok ? "✔ test passed" : "✘ test FAILED");
}

const evalRes = sh("bun", ["run", "eval"], {
  DATABASE_URL: evalDbUrl,
  HAZINA_INTENT_SECRET: INTENT_SECRET,
});
steps.eval = { ok: evalRes.code === 0, durationMs: 0, exitCode: evalRes.code };
console.log("\n▶ eval  (golden set through the real orchestrator)");
{
  const tail = evalRes.stdout.trimEnd().split("\n").slice(-6).join("\n");
  if (tail) console.log(tail);
  console.log(steps.eval.ok ? "✔ eval gate passed" : "✘ eval gate FAILED");
}

runStep("build", ["bun", "run", "build"], {
  DATABASE_URL: evalDbUrl,
  HAZINA_INTENT_SECRET: INTENT_SECRET,
});

// ---- parse evidence out of the raw outputs --------------------------------
const m = (re: RegExp, s: string): string | null => s.match(re)?.[1] ?? null;
const testSummary = {
  total: parseInt(m(/Ran (\d+) tests/, testRes.stdout) ?? "0", 10),
  pass: parseInt(m(/(\d+) pass/, testRes.stdout) ?? "0", 10),
  fail: parseInt(m(/(\d+) fail/, testRes.stdout) ?? "0", 10),
  files: parseInt(m(/across (\d+) files?/, testRes.stdout) ?? "0", 10),
};
const evalSummary = {
  passRatePercent: m(/Pass rate:\s+([\d.]+)%/, evalRes.stdout),
  casesPassed: parseInt(m(/Pass rate:.*?\((\d+)\/(\d+)\)/, evalRes.stdout) ?? "0", 10),
  casesTotal: (() => {
    const g = evalRes.stdout.match(/Pass rate:.*?\((\d+)\/(\d+)\)/);
    return g ? parseInt(g[2], 10) : 0;
  })(),
  routeAccuracyPercent: m(/Route accuracy:\s+([\d.]+)%/, evalRes.stdout),
  refusalPrecisionRecall: m(/Refusal precision\/recall:\s+(\S+)/, evalRes.stdout),
  feeNumericMatchPercent: m(/Fee numeric match:\s+([\d.]+)%/, evalRes.stdout),
  latency: m(/Latency P50\/P95:\s+(\S+ \/ \S+)/, evalRes.stdout),
  gate: m(/CI gate:\s+(\w+)/, evalRes.stdout),
};

const overallOk = Object.values(steps).every((s) => s.ok);
const summary = {
  command: "bun run verify",
  overall: overallOk ? "PASS" : "FAIL",
  commit: gitSha(),
  generatedAt: new Date().toISOString(),
  deploymentMode: process.env.DEPLOYMENT_MODE?.toLowerCase() === "operational" ? "operational" : "demo",
  toolchain: {
    bun: process.versions.bun ?? "unknown",
    node: process.versions.node ?? "unknown",
    prisma: pkgVersion("prisma"),
    typescript: pkgVersion("typescript"),
  },
  database: {
    provider: "sqlite",
    posture: "isolated throwaway test DB (per-run tmp file); demo deployment posture",
  },
  steps: Object.fromEntries(
    Object.entries(steps).map(([k, v]) => [k, { ok: v.ok, exitCode: v.exitCode }])
  ),
  tests: testSummary,
  evaluation: evalSummary,
  build: {
    ok: steps.build?.ok ?? false,
    typeValidation: "enforced — next.config.ts has no ignoreBuildErrors escape",
  },
  notes: [
    "Counts in this file are GENERATED from command output, never hand-edited.",
    "Demo system: synthetic data only; see README for the production boundary.",
  ],
};

fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`\n${overallOk ? "✔ VERIFY PASS" : "✘ VERIFY FAIL"} — summary written to docs/eval/verification.json`);
console.log(
  `  tests: ${testSummary.pass} pass / ${testSummary.fail} fail (${testSummary.total} across ${testSummary.files} files)` +
    ` · eval: ${evalSummary.passRatePercent}% (${evalSummary.casesPassed}/${evalSummary.casesTotal}) gate=${evalSummary.gate}` +
    ` · build: ${steps.build?.ok ? "ok (type-validated)" : "FAILED"}`
);
process.exit(overallOk ? 0 : 1);
