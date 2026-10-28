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
  // The demo SQLite DB ships with the standalone server (Vercel/k8s deploys).
  outputFileTracingIncludes: {
    "/**": ["./db/**", "./prisma/**"],
  },
  // The reusable kit ships raw TypeScript; transpile it into the app build.
  transpilePackages: ["@hazina/kit"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
