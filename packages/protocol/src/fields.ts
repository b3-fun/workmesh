import { z } from "zod";

// Field shapes shared by the ingest schemas (index.ts) and v1 Coordinate (coord.ts). Kept apart so coord.ts can use
// them without importing index.ts, which re-exports coord.ts.

export const HUB_ISSUE_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
export const HUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * A person's email, sent beside their display name (SPEC §48): plain ASCII `local@domain` with no spaces, at most 254
 * characters. Two people can share a display name, so a reader that has both emails matches people by email.
 */
export const HUB_PERSON_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
export const HUB_PERSON_EMAIL_MAX = 254;

/** The sender's rule: the field is left out, or it is an email. */
export const hubPersonEmailSchema = z.string().max(HUB_PERSON_EMAIL_MAX).regex(HUB_PERSON_EMAIL_RE, "not an email address");
/**
 * The reader's rule: a missing, `null` or malformed email reads as absent, and the item it sits on is kept. The reader
 * then matches that person by display name, as before emails were sent.
 */
export const hubPersonEmailAcceptSchema = hubPersonEmailSchema.optional().catch(undefined);
