import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo (packages/hazina-kit): pin the workspace root so Turbopack
  // resolves correctly with the local file: dependency.
  turbopack: {
    root: path.join(process.cwd()),
  },
  // Allow the sandbox preview proxy to load _next/* assets in dev.
  allowedDevOrigins: ["*.space-z.ai", "localhost"],
  // The demo SQLite DB ships with the standalone server (Vercel/k8s deploys);
  // .prisma/** pins the native query engine into the serverless bundle so the
  // single API function can open SQLite on Vercel's read-only FS.
  outputFileTracingIncludes: {
    "/**": ["./db/**", "./prisma/**", "./node_modules/.prisma/**"],
  },
  // The reusable kit ships raw TypeScript; transpile it into the app build.
  transpilePackages: ["@hazina/kit"],
  // Production build MUST fail on TypeScript errors (deep-review P0-1):
  // no type-error suppression option may ever appear here — guarded by
  // tests/repo-contract.test.ts. An explicit `bun run typecheck` gate exists
  // as well; the build enforces the same contract so a broken artifact can
  // never ship green.
  reactStrictMode: true,
};

export default nextConfig;
