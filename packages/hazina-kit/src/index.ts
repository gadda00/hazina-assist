/**
 * @hazina/kit — reusable, framework-free building blocks for bank-grade LLM apps.
 *
 * Everything here is pure TypeScript (node:crypto only) so it can be lifted
 * into any Node/Bun service. App-specific glue (Prisma, Next.js) stays out.
 */
export * from "./signing";
export * from "./pii";
export * from "./injection";
export * from "./guards";
export * from "./policy";
export * from "./eval";
export * from "./retrieval";

export const KIT_VERSION = "0.1.0";
