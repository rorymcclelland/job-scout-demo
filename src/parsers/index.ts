// Picks the right parser for an email. Emails from anyone else are ignored and
// counted, so the run log shows if something unexpected is being fetched.

import type { ParsedEmail } from "../mime.ts";
import type { Role, Source } from "../role.ts";
import { isLinkedInAlert, parseLinkedIn } from "./linkedin.ts";
import { isHackajob, parseHackajob } from "./hackajob.ts";
import { isGoogleAlert, parseGoogle } from "./google.ts";
import { isMicrosoftAlert, parseMicrosoft } from "./microsoft.ts";

export type EmailKind = Source | "other";

/** One parser per source in SOURCES (role.ts). A parser may add a note for source health. */
const PARSERS: Record<Source, { is: (e: ParsedEmail) => boolean; parse: (e: ParsedEmail) => { roles: Role[]; note?: string } }> = {
  linkedin: { is: isLinkedInAlert, parse: (e) => ({ roles: parseLinkedIn(e) }) },
  hackajob: { is: isHackajob, parse: (e) => ({ roles: parseHackajob(e) }) },
  google: { is: isGoogleAlert, parse: parseGoogle },
  microsoft: { is: isMicrosoftAlert, parse: parseMicrosoft },
};

export function kindOf(email: ParsedEmail): EmailKind {
  for (const [kind, p] of Object.entries(PARSERS) as Array<[Source, (typeof PARSERS)[Source]]>) if (p.is(email)) return kind;
  return "other";
}

export function rolesFrom(email: ParsedEmail): { kind: EmailKind; roles: Role[]; note?: string } {
  const kind = kindOf(email);
  if (kind === "other") return { kind, roles: [] };
  return { kind, ...PARSERS[kind].parse(email) };
}
