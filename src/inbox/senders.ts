// Which emails are replies to the owner's applications (backlog I1, Sprint 6a).
//
// Code only, on the PC. An email is a reply candidate when its sender's
// ADDRESS (never its display name) is:
//   - a hiring system's mail domain from config/sources.json "replySenders"
//     (Greenhouse, Lever, Ashby and others), or
//   - a company or recruiter on the watch list (data/watchlist.json, written by
//     part 2 from the board and the tracker), or
//   - LinkedIn, but only for its application-update emails, not its job alerts.
// A reply whose DKIM signature does not pass for the sender's domain is kept
// but marked unverified, and never moves a card (I4).

import type { ParsedEmail } from "../mime.ts";
import { companyToken, type Watchlist } from "./watch.ts";

export interface ReplySender {
  /** A short name, e.g. "greenhouse"; "linkedin" is special (subject patterns). */
  system: string;
  /** The domain its application emails come from; subdomains match too. */
  domain: string;
}

export type Via = "hiring-system" | "company" | "recruiter" | "linkedin";

export interface Candidate {
  via: Via;
  system: string | null;
  domain: string;
  /** Watch-list cards this sender points at; empty for hiring systems (I3 decides). */
  cardIds: string[];
  verified: boolean;
  /** I9: found by the company's name in its mail domain, not by a domain or address on the watch list. */
  byName?: boolean;
}

/** LinkedIn's application updates, as opposed to its job alerts. */
export const LINKEDIN_UPDATE = /\byour application\b|\bapplication (?:was )?(?:viewed|sent|submitted)\b|\bupdate (?:on|from)\b.*\bapplication\b|\bnot (?:be )?moving forward\b/i;

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase().replace(/\.$/, "");
}

/** True when `domain` is `base` or one of its subdomains. */
export function within(domain: string, base: string): boolean {
  const d = domain.toLowerCase();
  const b = base.toLowerCase().replace(/^@/, "").replace(/^\./, "");
  return b !== "" && (d === b || d.endsWith("." + b));
}

/**
 * DKIM, from the Authentication-Results headers the receiving server (Proton)
 * added. Passes when a dkim=pass result is signed by the sender's domain, a
 * parent of it, or a subdomain of it.
 */
export function dkimPasses(authResults: string[], domain: string): boolean {
  if (!domain) return false;
  for (const h of authResults) {
    const re = /dkim=(\w+)[^;]*?header\.(?:d|i)=@?([A-Za-z0-9.-]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h))) {
      if (m[1].toLowerCase() !== "pass") continue;
      const d = m[2].toLowerCase();
      if (within(domain, d) || within(d, domain)) return true;
    }
  }
  return false;
}

export function replyCandidate(email: ParsedEmail, watch: Watchlist, senders: ReplySender[]): Candidate | null {
  const address = email.fromAddress ?? "";
  const domain = domainOf(address);
  if (!domain) return null;
  const verified = dkimPasses(email.authResults ?? [], domain);

  const linkedin = senders.find((s) => s.system === "linkedin");
  if (linkedin && within(domain, linkedin.domain)) {
    return LINKEDIN_UPDATE.test(email.subject) ? { via: "linkedin", system: "linkedin", domain, cardIds: [], verified } : null;
  }
  const system = senders.find((s) => s.system !== "linkedin" && within(domain, s.domain));
  if (system) return { via: "hiring-system", system: system.system, domain, cardIds: [], verified };

  const byRecruiter = watch.entries.filter((e) => e.recruiters.some((r) => r.toLowerCase() === address));
  if (byRecruiter.length) return { via: "recruiter", system: null, domain, cardIds: byRecruiter.map((e) => e.cardId), verified };

  const byDomain = watch.entries.filter((e) => e.domains.some((d) => within(domain, d)));
  if (byDomain.length) return { via: "company", system: null, domain, cardIds: byDomain.map((e) => e.cardId), verified };

  // I9: a watched application with no known domain. The sender's domain must
  // BE the company's name ("brightloop.ai", "mail.lendingloop.com"), label for
  // label, never merely contain it, so "brightloop-careers.example" does not pass.
  const byName = watch.entries.filter((e) => !e.domains.length && nameDomain(domain, companyToken(e.company)));
  if (byName.length) return { via: "company", system: null, domain, cardIds: byName.map((e) => e.cardId), verified, byName: true };
  return null;
}

/** I9: is the domain's own name (the label before its public suffix) exactly the token? */
/** Mail providers: never an employer's name, whatever the company is called ("Proton" and proton.me). */
const NOT_A_NAME = ["proton.me", "protonmail.com", "proton.ch", "pm.me", "gmail.com", "googlemail.com", "google.com", "outlook.com", "hotmail.com", "live.com", "microsoft.com", "yahoo.com", "icloud.com", "me.com", "linkedin.com"];

export function nameDomain(domain: string, token: string | null): boolean {
  if (!token) return false;
  const d = domain.toLowerCase();
  if (NOT_A_NAME.some((n) => d === n || d.endsWith("." + n))) return false;
  const labels = d.split(".").filter(Boolean);
  if (labels.length < 2) return false;
  // The label before the suffix: "brightloop.ai" -> brightloop; "mail.pantry.com" -> pantry; "acme.co.uk" -> acme.
  const twoPart = labels.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  const own = labels[labels.length - (twoPart ? 3 : 2)];
  return own === token;
}

/** What to ask Bridge for: FROM searches are substring matches, so domains and addresses both work. */
export function searchTerms(watch: Watchlist, senders: ReplySender[]): string[] {
  const terms = new Set<string>();
  for (const s of senders) terms.add(s.domain.toLowerCase());
  for (const e of watch.entries) {
    for (const d of e.domains) terms.add(d.toLowerCase());
    for (const r of e.recruiters) terms.add(r.toLowerCase());
    if (!e.domains.length) {
      const t = companyToken(e.company);
      if (t) terms.add(t); // I9: Bridge's FROM search is a substring match; replyCandidate then checks the domain itself
    }
  }
  return [...terms].filter((t) => t.length >= 4).sort();
}
