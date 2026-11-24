import type { CompletionRequest, CompletionResult, SummaryProvider } from "./provider";

/**
 * Gemma 4 26B A4B: a 2026 instruct model from the account's catalog with JSON-schema output and switchable
 * reasoning. Mixture of experts with 4B active parameters, so it answers fast, at $0.10 / $0.30 per M tokens.
 */
export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const WORKERS_AI_LABEL = "Gemma 4 26B on Workers AI";

/** The slice of the `AI` binding this provider uses. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

type Chat = {
  choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string | null }[];
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Pulls the JSON object out of either response shape (OpenAI-style `choices`, or the older `response`). */
function readOutput(raw: unknown): { value?: unknown; refusal?: boolean; length?: boolean } {
  const r = (raw ?? {}) as Chat;
  const choice = r.choices?.[0];
  if (choice) {
    if (choice.message?.refusal) return { refusal: true };
    if (choice.finish_reason === "length") return { length: true };
    return { value: choice.message?.content };
  }
  return { value: r.response };
}

export function workersAiProvider(ai: AiLike, model = WORKERS_AI_MODEL): SummaryProvider {
  const provider = `workers-ai:${model}`;
  return {
    id: model,
    label: model === WORKERS_AI_MODEL ? WORKERS_AI_LABEL : `${model} on Workers AI`,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let raw: unknown;
      try {
        raw = await ai.run(model, {
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxTokens,
          response_format: { type: "json_schema", json_schema: { name: "summary", schema: req.schema, strict: true } },
          chat_template_kwargs: { enable_thinking: false },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 3040 capacity exceeded / 429: back off like a rate limit.
        const limited = /\b(429|3040)\b|capacity|rate limit/i.test(msg);
        return { ok: false, reason: limited ? "rate_limited" : "error", provider };
      }
      const out = readOutput(raw);
      if (out.refusal) return { ok: false, reason: "refusal", provider };
      if (out.length) return { ok: false, reason: "max_tokens", provider };
      let value = out.value;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
        } catch {
          return { ok: false, reason: "bad_output", provider };
        }
      }
      if (!value || typeof value !== "object") return { ok: false, reason: "bad_output", provider };
      const usage = (raw as Chat).usage;
      return {
        ok: true,
        value,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        provider,
      };
    },
  };
}
