/**
 * Next.js instrumentation hook — runs once per server process at boot.
 * Used for fail-closed deployment assertions (see src/lib/deployment.ts):
 * a misconfigured "operational" deployment refuses to start instead of
 * silently running demo-grade controls in production posture.
 */
export async function register() {
  const { assertDeploymentHealthy } = await import("@/lib/deployment");
  assertDeploymentHealthy();
}
