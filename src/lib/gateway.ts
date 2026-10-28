/**
 * Model Gateway (LiteLLM-role): routing, pseudonymisation proxy,
 * circuit breaker, deterministic fallback, usage telemetry.
 *
 * - PII is pseudonymised (reversible, vault server-side) BEFORE any external
 *   model call and re-hydrated after — the s.48 cross-border safeguard.
 * - If the external model is unavailable, a deterministic fallback keeps the
 *   four customer journeys alive (graceful degradation, see ADR-001).
 * - Every call records model id, latency, estimated tokens & cost into the
 *   trace so the audit log and cost dashboards are real numbers.
 */
import { pseudonymise, rehydrate } from "@hazina/kit";

export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayCallOptions {
  sessionId: string;
  tag: string; // orchestration node that made the call
  temperature?: number;
  maxTokens?: number;
}

export interface GatewayResult {
  content: string;
  model: string;
  backend: "external" | "fallback";
  latencyMs: number;
  estPromptTokens: number;
  estCompletionTokens: number;
  costUsd: number;
  pseudonyms: { token: string; piiType: string }[];
}

// Circuit breaker state (per-process)
const breaker = { failures: 0, openUntil: 0, threshold: 3, cooldownMs: 60_000 };
const COST_PER_1K = { input: 0.0006, output: 0.0018 }; // USD, demo pricing

const estTokens = (s: string) => Math.ceil(s.length / 4);

// Demo vault for the current call only — persisted copies are stored by the
// caller if needed for audit; originals never reach the external model.

/** Hard deadline for any external model attempt (env-tunable). A model call
 *  without a deadline can blackhole the request thread forever; on timeout we
 *  count a breaker failure and fall back to the deterministic composer. */
const MODEL_DEADLINE_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 6_000);

async function tryExternalCall(messages: GatewayMessage[]): Promise<string | null> {
  if (Date.now() < breaker.openUntil) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`model deadline exceeded (${MODEL_DEADLINE_MS}ms)`)),
      MODEL_DEADLINE_MS
    );
    (timer as unknown as { unref?: () => void }).unref?.(); // don't hold the event loop
  });
  try {
    const attempt = (async () => {
      const mod = "z-ai-web-dev-sdk";
      const ZAI = (await import(mod/* @vite-ignore */)).default;
      const zai = await ZAI.create();
      return await zai.chat.completions.create({
        messages: messages.map((m) => ({
          role: m.role === "system" ? "assistant" : m.role,
          content: m.content,
        })),
        thinking: { type: "disabled" },
      });
    })();
    const completion = await Promise.race([attempt, deadline]);
    const content = completion?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new Error("empty completion");
    breaker.failures = 0;
    return content as string;
  } catch (err) {
    breaker.failures += 1;
    if (breaker.failures >= breaker.threshold) {
      breaker.openUntil = Date.now() + breaker.cooldownMs;
      breaker.failures = 0;
      console.warn("[gateway] circuit opened for 60s:", (err as Error).message);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function breakerState() {
  return { open: Date.now() < breaker.openUntil, openUntil: breaker.openUntil, threshold: breaker.threshold };
}

/**
 * Send a conversation through the gateway. The LAST user message and any
 * assistant-visible untrusted text are pseudonymised; the system prompt is
 * never mixed with untrusted content (it is constructed server-side).
 */
export async function gatewayChat(
  messages: GatewayMessage[],
  opts: GatewayCallOptions
): Promise<GatewayResult> {
  const started = Date.now();

  // 1. Pseudonymise every message except the server-authored system prompt.
  const vault = new Map<string, string>();
  const pseudonymList: { token: string; piiType: string }[] = [];
  const shielded: GatewayMessage[] = messages.map((m, i) => {
    if (m.role === "system" && i === 0) return m;
    const p = pseudonymise(m.content, vault);
    for (const map of p.mappings) pseudonymList.push({ token: map.token, piiType: map.piiType });
    return { ...m, content: p.text };
  });

  // 2. External model (with fallback)
  const raw = await tryExternalCall(shielded);
  let content: string;
  let backend: "external" | "fallback" = "external";
  if (raw) {
    content = raw;
  } else {
    backend = "fallback";
    content = ""; // caller supplies deterministic composer when null content returned
  }

  // 3. Re-hydrate tokens in the model output
  if (content) content = rehydrate(content, vault);

  const latencyMs = Date.now() - started;
  const estPromptTokens = shielded.reduce((a, m) => a + estTokens(m.content), 0);
  const estCompletionTokens = content ? estTokens(content) : 0;
  const costUsd =
    (estPromptTokens / 1000) * COST_PER_1K.input +
    (estCompletionTokens / 1000) * COST_PER_1K.output;

  return {
    content,
    model: backend === "external" ? "glm-4.7-zai (via gateway)" : "deterministic-fallback",
    backend,
    latencyMs,
    estPromptTokens,
    estCompletionTokens,
    costUsd: Math.round(costUsd * 10000) / 10000,
    pseudonyms: pseudonymList,
  };
}

/** Mark a fallback invocation (the caller composes the deterministic text). */
export function fallbackResult(
  content: string,
  startedAt: number,
  opts: GatewayCallOptions
): GatewayResult {
  const latencyMs = Date.now() - startedAt;
  return {
    content,
    model: "deterministic-fallback",
    backend: "fallback",
    latencyMs,
    estPromptTokens: estTokens(content) / 2,
    estCompletionTokens: estTokens(content),
    costUsd: 0,
    pseudonyms: [],
  };
}
