/**
 * Deployment mode — the demo/production boundary, made explicit and
 * fail-closed (deep-review P0-1/P0-3).
 *
 *   DEPLOYMENT_MODE=demo        (default) synthetic data, demo IAM (identity
 *                                picker), OTP code revealed in the UI, dev
 *                                signing-secret fallback allowed.
 *   DEPLOYMENT_MODE=operational  fails closed at startup unless every
 *                                production precondition holds:
 *                                  - a real HAZINA_INTENT_SECRET (set, ≥32
 *                                    chars, not the known dev default)
 *                                  - DEMO_MODE=false (OTP code hidden)
 *                                  - an OTP delivery provider configured
 *                                    (HAZINA_OTP_PROVIDER) — without one the
 *                                transfer flow refuses to run rather than
 *                                pretending an SMS was sent
 *                                  - the demo identity picker is DISABLED;
 *                                this build ships demo IAM only, so
 *                                operational mode cannot mint sessions at all
 *                                until a real IdP integration exists.
 *
 * The assertions are pure functions (env injected) so they are unit-testable;
 * `assertDeploymentHealthy()` runs them once per server process via
 * src/instrumentation.ts and throws on violation — a misconfigured
 * "production" deployment becomes loud at boot instead of silently weak.
 */

export type DeploymentMode = "demo" | "operational";

const KNOWN_DEV_SECRETS = new Set([
  "dev-only-secret-rotate-me",
  "dev-only-secret",
  "change-me",
  "secret",
]);

export interface DeploymentEnv {
  [key: string]: string | undefined;
}

export function deploymentMode(env: DeploymentEnv = process.env): DeploymentMode {
  return env.DEPLOYMENT_MODE?.toLowerCase() === "operational" ? "operational" : "demo";
}

export function isDemo(env: DeploymentEnv = process.env): boolean {
  return deploymentMode(env) === "demo";
}

/** The demo OTP "channel": the 6-digit code is revealed in the chat UI.
 *  This flag does NOT configure real SMS delivery — see transfersAvailable(). */
export function otpRevealEnabled(env: DeploymentEnv = process.env): boolean {
  if (!isDemo(env)) return false; // never reveal codes in operational mode
  return env.DEMO_MODE !== "false";
}

/** Transfers can only run when either (a) demo mode is on (synthetic
 *  everything, code revealed), or (b) a real OTP delivery provider is
 *  configured. Hiding the code without a delivery channel would fake a
 *  step-up that never happened — so we refuse instead. */
export function transfersAvailable(env: DeploymentEnv = process.env): boolean {
  return isDemo(env) || !!env.HAZINA_OTP_PROVIDER?.trim();
}

export interface DeploymentViolation {
  check: string;
  message: string;
}

export function deploymentViolations(env: DeploymentEnv = process.env): DeploymentViolation[] {
  const mode = deploymentMode(env);
  if (mode === "demo") return [];
  const v: DeploymentViolation[] = [];
  const secret = env.HAZINA_INTENT_SECRET?.trim() ?? "";
  if (!secret) {
    v.push({
      check: "HAZINA_INTENT_SECRET",
      message: "operational mode requires an explicit HMAC intent secret",
    });
  } else if (secret.length < 32 || KNOWN_DEV_SECRETS.has(secret.toLowerCase())) {
    v.push({
      check: "HAZINA_INTENT_SECRET",
      message: "operational mode rejects short/known-development signing secrets",
    });
  }
  if (env.DEMO_MODE !== "false") {
    v.push({
      check: "DEMO_MODE",
      message: "operational mode requires DEMO_MODE=false (OTP codes must never be revealed in the UI)",
    });
  }
  if (!env.HAZINA_OTP_PROVIDER?.trim()) {
    v.push({
      check: "HAZINA_OTP_PROVIDER",
      message: "operational mode requires a configured OTP delivery provider before transfers can run",
    });
  }
  v.push({
    check: "identity",
    message:
      "this build ships demo IAM only (selectable synthetic identities); operational mode cannot mint sessions until a real OIDC provider is integrated — login is disabled",
  });
  return v;
}

let asserted = false;

/** Runs once per server process (called from instrumentation.ts). Throws on
 *  operational-mode violations; logs an honest banner in demo mode. */
export function assertDeploymentHealthy(env: DeploymentEnv = process.env): void {
  if (asserted) return;
  asserted = true;
  const mode = deploymentMode(env);
  if (mode === "demo") {
    console.warn(
      "[hazina] DEMO MODE: synthetic data · demo identity picker · OTP code shown in UI. " +
        "Not a production control posture — see docs/governance and README."
    );
    return;
  }
  const violations = deploymentViolations(env);
  if (violations.length > 0) {
    const lines = violations.map((x) => `  - [${x.check}] ${x.message}`).join("\n");
    throw new Error(
      `[hazina] DEPLOYMENT_MODE=operational failed its startup assertions:\n${lines}\n` +
        "Refusing to boot in operational mode (fail-closed). Fix the configuration or run in demo mode."
    );
  }
}
