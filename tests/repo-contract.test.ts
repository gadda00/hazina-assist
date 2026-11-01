/**
 * Repository contract tests — the verification PIPELINE itself is under test.
 *
 * These guard against regressions of the exact defects the deep review found:
 *   1. `ignoreBuildErrors: true` sneaking back into next.config.ts (the
 *      production build must fail on TypeScript errors);
 *   2. `reactStrictMode` being disabled without a documented reason;
 *   3. CI silently bypassing `bun install --frozen-lockfile` with a fallback;
 *   4. the test command drifting back to an unscoped `bun test` that would
 *      swallow test files from a nested foreign checkout;
 *   5. the machine-readable verification artifact drifting out of the repo.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("repo contract — verification must stay trustworthy", () => {
  test("next.config.ts contains no ignoreBuildErrors escape hatch", () => {
    const cfg = read("next.config.ts");
    expect(cfg).not.toContain("ignoreBuildErrors");
    // a commented-out mention is also suspicious: assert the word is absent
    // entirely so the option cannot return disguised as documentation.
    expect(cfg.toLowerCase()).not.toContain("ignorebuilderrors");
  });

  test("reactStrictMode is enabled", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("reactStrictMode: true");
  });

  test("CI installs strictly from the frozen lockfile (no fallback)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain("|| bun install");
    expect(ci).not.toContain("||bun install");
    const installs = ci.match(/bun install[^\n]*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) {
      expect(line.trim()).toBe("bun install --frozen-lockfile");
    }
  });

  test("CI runs both the explicit typecheck AND the type-validated build", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("bun run typecheck");
    expect(ci).toContain("bun run build");
  });

  test("the test command is scoped to this repository's test files", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    // Unscoped `bun test` collects *.test.ts from ANY nested directory — a
    // foreign checkout inside the workspace then breaks the suite. The scoped
    // path keeps the run hermetic to this repo.
    expect(pkg.scripts.test).toBe("bun test ./tests/");
  });

  test("the machine-readable verification summary is committed and current", () => {
    const p = path.join(ROOT, "docs", "eval", "verification.json");
    expect(fs.existsSync(p)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(p, "utf8")) as {
      overall: string;
      tests: { pass: number; fail: number };
      toolchain: { bun: string };
    };
    expect(["PASS", "FAIL"]).toContain(summary.overall);
    expect(summary.tests.pass).toBeGreaterThan(80);
    expect(summary.toolchain.bun).toBeTruthy();
  });

  test("bunfig.toml wires the self-contained test preload", () => {
    const cfg = read("bunfig.toml");
    expect(cfg).toContain("preload");
    expect(cfg).toContain("tests/setup.ts");
  });
});
