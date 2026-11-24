import type { CompletionRequest, CompletionResult, SummaryProvider } from "./provider";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Fast, cheap, strong at following instructions, with structured output: $0.10 / $0.50 per M tokens (2026-11). */
export const DEFAULT_SUMMARY_MODEL = "anthropic/claude-haiku-5.5";

const NAMES: Record<string, string> = {
  "anthropic/claude-haiku-5.5": "Claude Haiku 5.5",
  "openai/gpt-6-luna": "GPT-6 Luna",
  "deepseek/deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash",
  "google/gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
};

/** "anthropic/claude-haiku-5.5" -> "Claude Haiku 5.5"; unknown ids show their slug. */
export function modelName(id: string): string {
  return NAMES[id] ?? id.split("/").pop() ?? id;
}

/** Room for the model's reasoning on top of the visible answer (reasoning tokens count against max_tokens). */
const REASONING_HEADROOM = 600;

type ChatResponse = {
  choices?: {
    message?: { content?: unknown; refusal?: unknown };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
};

export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  /** OpenRouter's `models` list: tried in order when the first model is down or refuses the request. */
  fallbacks?: string[];
  /** Test hook. */
  fetch?: typeof fetch;
}

/** Strict: the whole reply must be one JSON object (a code fence around it is tolerated). */
export function parseJsonObject(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === "object" && !Array.isArray(content)) return content as Record<string, unknown>;
  if (typeof content !== "string") return null;
  const body = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * OpenRouter's OpenAI-compatible chat completions over plain fetch. Structured output (`json_schema`) first; a model
 * that can't do it gets JSON mode with the schema in the prompt, remembered per model. Any parse failure is a skip.
 */
export function openRouterProvider(opts: OpenRouterOptions): SummaryProvider {
  const model = opts.model?.trim() || DEFAULT_SUMMARY_MODEL;
  const fallbacks = (opts.fallbacks ?? []).map((m) => m.trim()).filter((m) => m && m !== model);
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const jsonModeOnly = new Set<string>();
  const provider = `openrouter:${model}`;

  async function post(req: CompletionRequest, structured: boolean): Promise<{ status: number; body: ChatResponse | null }> {
    const system = structured
      ? req.system
      : `${req.system}\n\nReply with only a JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(req.schema)}`;
    const res = await doFetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://bullpen.b3os.org",
        "X-Title": "Bullpen",
      },
      body: JSON.stringify({
        model,
        ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens + REASONING_HEADROOM,
        // The JSON-mode retry is the portable request: no reasoning control either.
        ...(structured ? { reasoning: { effort: "low", exclude: true } } : {}),
        response_format: structured
          ? { type: "json_schema", json_schema: { name: "summary", strict: true, schema: req.schema } }
          : { type: "json_object" },
        // Only route to endpoints that honour response_format.
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    let body: ChatResponse | null = null;
    try {
      body = (await res.json()) as ChatResponse;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  return {
    id: model,
    label: `${modelName(model)} via OpenRouter`,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let structured = !jsonModeOnly.has(model);
      let r: { status: number; body: ChatResponse | null };
      try {
        r = await post(req, structured);
        // 400/404: no endpoint takes this request (json_schema or reasoning) for the model. Retry once in JSON mode
        // and remember.
        if (structured && (r.status === 400 || r.status === 404)) {
          structured = false;
          r = await post(req, false);
          if (r.status === 200) jsonModeOnly.add(model);
        }
      } catch {
        return { ok: false, reason: "error", provider };
      }
      if (r.status === 429) return { ok: false, reason: "rate_limited", provider, status: 429 };
      if (r.status !== 200 || !r.body || r.body.error) return { ok: false, reason: "error", provider, status: r.status };
      const choice = r.body.choices?.[0];
      if (!choice) return { ok: false, reason: "bad_output", provider };
      const finish = choice.finish_reason ?? "";
      if (choice.message?.refusal || finish === "content_filter" || choice.native_finish_reason === "refusal") {
        return { ok: false, reason: "refusal", provider };
      }
      if (finish === "length") return { ok: false, reason: "max_tokens", provider };
      const value = parseJsonObject(choice.message?.content);
      if (!value) return { ok: false, reason: "bad_output", provider };
      return {
        ok: true,
        value,
        inputTokens: r.body.usage?.prompt_tokens ?? 0,
        outputTokens: r.body.usage?.completion_tokens ?? 0,
        costUsd: typeof r.body.usage?.cost === "number" ? r.body.usage.cost : undefined,
        provider,
      };
    },
  };
}
