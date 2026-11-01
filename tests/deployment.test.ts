/**
 * Deployment-mode assertions (deep-review P0-1/P0-3) — the demo/production
 * boundary must fail CLOSED: no configuration path can silently turn demo
 * IAM, OTP reveal or the dev signing secret into an operational posture.
 */
import { describe, expect, test } from "bun:test";
import {
  deploymentMode,
  deploymentViolations,
  isDemo,
  otpRevealEnabled,
  transfersAvailable,
} from "../src/lib/deployment";

describe("deployment mode", () => {
  test("defaults to demo", () => {
    expect(deploymentMode({})).toBe("demo");
    expect(isDemo({})).toBe(true);
    expect(deploymentMode({ DEPLOYMENT_MODE: "DEMO" })).toBe("demo");
    expect(deploymentMode({ DEPLOYMENT_MODE: "garbage" })).toBe("demo");
  });

  test("demo mode has zero violations", () => {
    expect(deploymentViolations({})).toEqual([]);
    expect(deploymentViolations({ HAZINA_INTENT_SECRET: "dev-only-secret-rotate-me" })).toEqual([]);
  });

  test("operational mode fails closed on the dev signing secret", () => {
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "dev-only-secret-rotate-me",
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
    });
    expect(v.some((x) => x.check === "HAZINA_INTENT_SECRET")).toBe(true);
  });

  test("operational mode fails closed on a missing secret", () => {
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
    });
    expect(v.some((x) => x.check === "HAZINA_INTENT_SECRET")).toBe(true);
  });

  test("operational mode fails closed on a short secret", () => {
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "tooshortsecretvalue",
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
    });
    expect(v.some((x) => x.check === "HAZINA_INTENT_SECRET")).toBe(true);
  });

  test("operational mode demands DEMO_MODE=false", () => {
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "a".repeat(40),
      HAZINA_OTP_PROVIDER: "sms-gw",
    });
    expect(v.some((x) => x.check === "DEMO_MODE")).toBe(true);
  });

  test("operational mode demands an OTP delivery provider", () => {
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "a".repeat(40),
      DEMO_MODE: "false",
    });
    expect(v.some((x) => x.check === "HAZINA_OTP_PROVIDER")).toBe(true);
  });

  test("operational mode always flags demo IAM — this build has no real IdP", () => {
    // even a fully-secreted configuration cannot mint sessions in
    // operational mode: the identity check is a permanent violation until a
    // real OIDC provider is integrated.
    const v = deploymentViolations({
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "a".repeat(40),
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
      DATABASE_URL: "postgresql://db.internal:5432/hazina",
      HAZINA_METRICS_TOKEN: "a-long-scrape-token-value",
    });
    expect(v.some((x) => x.check === "identity")).toBe(true);
    // and with durable DB + metrics token configured, those checks pass
    expect(v.some((x) => x.check === "DATABASE_URL")).toBe(false);
    expect(v.some((x) => x.check === "HAZINA_METRICS_TOKEN")).toBe(false);
  });

  test("operational mode fails closed on SQLite / local-file / tmp databases", () => {
    const base = {
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "a".repeat(40),
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
      HAZINA_METRICS_TOKEN: "a-long-scrape-token-value",
    } as Record<string, string>;
    for (const dbUrl of [
      "file:/tmp/hazina-demo.db", // SQLite file in /tmp
      "file:./db/custom.db", // SQLite local file
      "file::memory:", // in-memory
      "postgres://host/hazina?state=/tmp/x", // /tmp anywhere in the URL
    ]) {
      const v = deploymentViolations({ ...base, DATABASE_URL: dbUrl });
      expect(v.some((x) => x.check === "DATABASE_URL")).toBe(true);
    }
    const missing = deploymentViolations({ ...base });
    expect(missing.some((x) => x.check === "DATABASE_URL")).toBe(true);
  });

  test("operational mode fails closed without a real metrics scrape token", () => {
    const base = {
      DEPLOYMENT_MODE: "operational",
      HAZINA_INTENT_SECRET: "a".repeat(40),
      DEMO_MODE: "false",
      HAZINA_OTP_PROVIDER: "sms-gw",
      DATABASE_URL: "postgresql://db.internal:5432/hazina",
    } as Record<string, string>;
    expect(deploymentViolations(base).some((x) => x.check === "HAZINA_METRICS_TOKEN")).toBe(true);
    expect(
      deploymentViolations({ ...base, HAZINA_METRICS_TOKEN: "short" }).some(
        (x) => x.check === "HAZINA_METRICS_TOKEN"
      )
    ).toBe(true);
    expect(
      deploymentViolations({ ...base, HAZINA_METRICS_TOKEN: "a-long-scrape-token-value" }).some(
        (x) => x.check === "HAZINA_METRICS_TOKEN"
      )
    ).toBe(false);
  });

  test("OTP reveal: demo default on, DEMO_MODE=false hides, operational never reveals", () => {
    expect(otpRevealEnabled({})).toBe(true);
    expect(otpRevealEnabled({ DEMO_MODE: "false" })).toBe(false);
    expect(
      otpRevealEnabled({ DEPLOYMENT_MODE: "operational", DEMO_MODE: "true" })
    ).toBe(false);
  });

  test("transfers: available in demo; in operational mode only with an OTP provider", () => {
    expect(transfersAvailable({})).toBe(true);
    expect(transfersAvailable({ DEPLOYMENT_MODE: "operational" })).toBe(false);
    expect(
      transfersAvailable({ DEPLOYMENT_MODE: "operational", HAZINA_OTP_PROVIDER: "sms-gw" })
    ).toBe(true);
  });
});
