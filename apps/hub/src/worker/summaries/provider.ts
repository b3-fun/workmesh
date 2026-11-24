// One interface for whoever writes summaries (SPEC.md §11): a model on OpenRouter when OPENROUTER_API_KEY is set,
// Workers AI otherwise. Providers never throw; every failure comes back as a reason, and the hub skips the summary.

import { openRouterProvider } from "./openrouter";
import { workersAiProvider, type AiLike } from "./workers-ai";

export interface CompletionRequest {
  system: string;
  user: string;
  /** JSON schema for the output object (all properties required, additionalProperties false). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export type FailureReason = "refusal" | "max_tokens" | "rate_limited" | "error" | "bad_output";

export type CompletionResult =
  | { ok: true; value: unknown; inputTokens: number; outputTokens: number; costUsd?: number; provider: string }
  | { ok: false; reason: FailureReason; provider: string; status?: number };

export interface SummaryProvider {
  /** Model id, for logs. */
  readonly id: string;
  /** For the board footer: "Claude Haiku 5.5 via OpenRouter", "Gemma 4 26B on Workers AI". */
  readonly label: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  SUMMARY_MODEL?: string;
  /** Comma-separated: OpenRouter's `models` fallback list. */
  SUMMARY_MODEL_FALLBACK?: string;
  AI?: AiLike;
}

/**
 * OpenRouter when the key is set, with Workers AI as the fallback for outages (never for refusals); Workers AI alone
 * otherwise; null when neither is available (summaries off).
 */
export function pickProvider(env: ProviderEnv): SummaryProvider | null {
  const key = env.OPENROUTER_API_KEY?.trim();
  const workers = env.AI ? workersAiProvider(env.AI) : null;
  if (key) {
    const router = openRouterProvider({
      apiKey: key,
      model: env.SUMMARY_MODEL,
      fallbacks: (env.SUMMARY_MODEL_FALLBACK ?? "").split(","),
    });
    return workers ? withFallback(router, workers) : router;
  }
  return workers;
}

/** Retries on `secondary` when `primary` is down or rate limited. A refusal or a cut-off answer is final. */
export function withFallback(primary: SummaryProvider, secondary: SummaryProvider): SummaryProvider {
  return {
    id: primary.id,
    label: primary.label,
    async complete(req) {
      const first = await primary.complete(req);
      if (first.ok || (first.reason !== "error" && first.reason !== "rate_limited")) return first;
      return secondary.complete(req);
    },
  };
}
