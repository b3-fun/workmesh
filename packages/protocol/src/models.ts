import { z } from "zod";

/**
 * Model choice per handoff (docs/SPEC.md §66, B3-7275): a handoff, a review or a request may carry a *suggestion* of
 * the agent CLI, model and effort that runs it, and the machine that ran it says what actually ran. A suggestion is
 * only that: the receiving machine's own policy (`handoffs.models`, §67) decides what runs, lowers a suggestion above
 * its ceiling, and shows the model that will run before its person accepts. A suggestion never accepts, starts or
 * skips anything.
 *
 * Additive to v2 (§30): an optional `suggest` on a handoff and on the bodies that make one, and an optional `run` on a
 * `start` move. An older hub drops both; an older relay drops `suggest` and runs as it always did.
 */

/** The agent CLIs a relay runs (the same two a handoff and a review run, §31, §53). */
export const HUB_AGENTS = ["claude", "codex"] as const;
export const hubAgentSchema = z.enum(HUB_AGENTS);
export type HubAgent = z.infer<typeof hubAgentSchema>;

/**
 * How hard the agent thinks, lowest first: Claude Code's `--effort` levels. Codex's `model_reasoning_effort` takes the
 * same words, with `max` run as `xhigh` (Codex has no level above it).
 */
export const HUB_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const hubEffortSchema = z.enum(HUB_EFFORTS);
export type HubEffort = z.infer<typeof hubEffortSchema>;

/**
 * Who suggested it: `sender`, the person or agent who sent the handoff (or asked for the review); `project`, the hub,
 * from its project's defaults (an admin's, by a request's size or for reviews).
 */
export const HUB_SUGGEST_SOURCES = ["sender", "project"] as const;
export const hubSuggestSourceSchema = z.enum(HUB_SUGGEST_SOURCES);
export type HubSuggestSource = z.infer<typeof hubSuggestSourceSchema>;

/** A model as the agent CLIs take it (`--model` / `-m`): an alias (`sonnet`, `opus`) or a full id. */
export const HUB_MODEL_RE = /^[\w.:[\]/-]{1,80}$/;
export const HUB_MODEL_NAME_MAX = 80;
export const hubModelNameSchema = z.string().min(1).max(HUB_MODEL_NAME_MAX).regex(HUB_MODEL_RE, "not a model name");

const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);

const someField = (s: { agent?: unknown; model?: unknown; effort?: unknown }) =>
  s.agent !== undefined || s.model !== undefined || s.effort !== undefined;

/** What a sender asks for, on the bodies that make a handoff (`create`, a review `request`). At least one field. */
export const hubModelAskSchema = z
  .strictObject({
    agent: hubAgentSchema.optional(),
    model: hubModelNameSchema.optional(),
    effort: hubEffortSchema.optional(),
  })
  .refine(someField, "a suggestion names an agent, a model or an effort");
export type HubModelAsk = z.infer<typeof hubModelAskSchema>;

/**
 * The hub's reading of a sender's ask: a field it can't read is left out, and an ask with nothing left reads as none.
 * The handoff is made either way.
 */
export const hubModelAskAcceptSchema = z
  .object({
    agent: soft(hubAgentSchema),
    model: soft(hubModelNameSchema),
    effort: soft(hubEffortSchema),
  })
  .nullish()
  .catch(undefined)
  .transform((v) => (v && someField(v) ? v : undefined));
export type HubModelAskAccepted = z.infer<typeof hubModelAskAcceptSchema>;

/** `suggest` on a handoff (§66): what the sender or the project suggests, and which of them did. */
export const hubModelSuggestionSchema = z
  .object({
    agent: hubAgentSchema.optional(),
    model: hubModelNameSchema.optional(),
    effort: hubEffortSchema.optional(),
    source: hubSuggestSourceSchema.optional(),
  })
  .refine(someField, "a suggestion names an agent, a model or an effort");
export type HubModelSuggestion = z.infer<typeof hubModelSuggestionSchema>;

/**
 * A relay's reading of `suggest`: a field it can't read is left out (an unknown agent or effort, a malformed model),
 * and a suggestion with nothing left reads as none. It never drops the handoff it sits on.
 */
export const hubModelSuggestionAcceptSchema = z
  .object({
    agent: soft(hubAgentSchema),
    model: soft(hubModelNameSchema),
    effort: soft(hubEffortSchema),
    source: soft(hubSuggestSourceSchema),
  })
  .nullish()
  .catch(undefined)
  .transform((v) => (v && someField(v) ? v : undefined));
export type HubModelSuggestionAccepted = z.infer<typeof hubModelSuggestionAcceptSchema>;

/**
 * `run` on a `start` move (§66): what this machine runs the handoff on, after its own policy. `model` and `effort` are
 * absent when the agent runs on its own default. `lowered: true` says the machine ran less than was suggested (its
 * ceiling, or a model it doesn't allow); `followed: false` that it ran its own default instead of the suggestion.
 */
export const hubModelRunSchema = z.strictObject({
  agent: hubAgentSchema,
  model: hubModelNameSchema.optional(),
  effort: hubEffortSchema.optional(),
  lowered: z.literal(true).optional(),
  followed: z.boolean().optional(),
});
export type HubModelRun = z.infer<typeof hubModelRunSchema>;

/** The hub's reading of `run`: an unreadable one reads as none, and the move still lands. */
export const hubModelRunAcceptSchema = z
  .object({
    agent: hubAgentSchema,
    model: soft(hubModelNameSchema),
    effort: soft(hubEffortSchema),
    lowered: soft(z.literal(true)),
    followed: soft(z.boolean()),
  })
  .nullish()
  .catch(undefined)
  .transform((v) => v ?? undefined);
export type HubModelRunAccepted = z.infer<typeof hubModelRunAcceptSchema>;
