import { HUB_PERSON_EMAIL_MAX, HUB_PERSON_EMAIL_RE } from "@workmesh/protocol";

/**
 * Who a display name stands for (docs/SPEC.md §48, §49). Two people on a team can share a display name, so the relay
 * matches a person the hub names by email when both sides have one. With a hub that sends no emails it compares
 * display names, as it always did.
 */

/** A person as the hub names them: the display name, and their email when the hub sent one. */
export interface PersonRef {
  person?: string;
  email?: string;
}

/** An email as it is compared: lower case. Undefined for anything that is not a plain email address. */
export function emailKey(email: string | null | undefined): string | undefined {
  if (typeof email !== "string") return undefined;
  const e = email.trim();
  return e.length <= HUB_PERSON_EMAIL_MAX && HUB_PERSON_EMAIL_RE.test(e) ? e.toLowerCase() : undefined;
}

/**
 * Whether two entries name the same person. With an email on both, the emails decide: equal names with different
 * emails are two people, and one email under two names is one person. With an email missing on either side, the
 * display names decide, read case-insensitively.
 */
export function samePerson(a: PersonRef | undefined, b: PersonRef | undefined): boolean {
  if (!a || !b) return false;
  const ea = emailKey(a.email);
  const eb = emailKey(b.email);
  if (ea !== undefined && eb !== undefined) return ea === eb;
  return !!a.person && !!b.person && a.person.toLowerCase() === b.person.toLowerCase();
}

/** A gate policy's owner. */
export function gateOwner(g: { owner: string; ownerEmail?: string }): PersonRef {
  return { person: g.owner, email: g.ownerEmail };
}

/**
 * The people who may answer a gate policy's approvals: its approvers, or its owner when it names none. The protocol
 * keeps `approverEmails` only when it has one email per approver, so the two lists line up here.
 */
export function gateApprovers(g: {
  owner: string;
  ownerEmail?: string;
  approvers?: readonly string[];
  approverEmails?: readonly string[];
}): PersonRef[] {
  if (!g.approvers?.length) return [gateOwner(g)];
  return g.approvers.map((person, i) => ({ person, email: g.approverEmails?.[i] }));
}
