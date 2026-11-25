import { z } from "zod";

/**
 * `POST /relay/ask` (docs/SPEC.md §29): an agent asks the board's Ask about the team's agents, through its relay with
 * the device token. Two readings per body (§14): the relay builds the request from the strict schema and reads the
 * answer with the accept schema; the hub reads requests with the request accept schema.
 */

/** A question, in characters. */
export const HUB_ASK_QUESTION_MAX = 2000;
/** An answer, in characters (the hub's own cap). */
export const HUB_ASK_ANSWER_MAX = 8000;
/** Sessions an answer names. */
export const HUB_ASK_MAX_SESSIONS = 100;

/** An IANA time zone name ("America/New_York", "UTC", "Etc/GMT+5"). */
const zone = z.string().min(1).max(64).regex(/^[A-Za-z][\w+./-]{0,63}$/, "a time zone name");

export const hubAskRequestSchema = z.strictObject({
  question: z.string().min(1).max(HUB_ASK_QUESTION_MAX),
  zone: zone.optional(),
});
export type HubAskRequest = z.infer<typeof hubAskRequestSchema>;
export const hubAskRequestAcceptSchema = z.object({
  question: z.string().trim().min(1).max(HUB_ASK_QUESTION_MAX),
  zone: zone.nullish().catch(undefined).transform((v) => v ?? undefined),
});
export type HubAskRequestAccepted = z.infer<typeof hubAskRequestAcceptSchema>;

const askSession = z.object({
  hubKey: z.string().min(1).max(300),
  name: z.string().max(120),
  person: z.string().max(120),
  state: z.string().max(40),
});

export const hubAskResponseSchema = z.object({
  ok: z.literal(true),
  answer: z.string().max(HUB_ASK_ANSWER_MAX),
  sessions: z.array(askSession).max(HUB_ASK_MAX_SESSIONS),
});
export type HubAskResponse = z.infer<typeof hubAskResponseSchema>;

const cut = (max: number) => z.string().transform((s) => s.slice(0, max));
const askSessionAccept = z.object({
  hubKey: z.string().min(1).max(300),
  name: cut(120).catch(""),
  person: cut(120).catch(""),
  state: cut(40).catch(""),
});
export const hubAskResponseAcceptSchema = z.object({
  ok: z.literal(true),
  answer: cut(HUB_ASK_ANSWER_MAX),
  sessions: z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const out: z.infer<typeof askSessionAccept>[] = [];
      for (const it of items) {
        const r = askSessionAccept.safeParse(it);
        if (r.success && out.length < HUB_ASK_MAX_SESSIONS) out.push(r.data);
      }
      return out;
    })
    .optional()
    .transform((v) => v ?? []),
});
export type HubAskResponseAccepted = z.infer<typeof hubAskResponseAcceptSchema>;
