// hackajob emails, written by its matching assistant "Archer".
//
// Shaped on the owner's real emails (first run, 14 Oct 2026). Every role Archer
// describes has a details line in this form, which is what we key on:
//
//     On-site · London, United Kingdom · £90k-130k
//
// The title and company sit just above it, in one of three shapes:
//   weekly matches:  "<Title> {{link}}" then "at <Company>"
//   single match:    "...role at <Company> that ... looking for a <Title> {{link}} and ..."
//   reminder:        "It's a <Title> {{link}} at <Company> ."
// Below it is Archer's reason for the match, kept as the excerpt.
//
// Links are tracking redirects that differ in every email, so a role's id is
// built from its company and title instead, which stays the same across emails.
// hackajob's job pages need a sign-in, so these emails are the advert we have.
// Emails with no details line (welcome notes, tips) give no roles.

import type { ParsedEmail } from "../mime.ts";
import type { Role } from "../role.ts";
import { htmlToText } from "../html.ts";
import { parsePay } from "../pay.ts";
import { urlsIn, withoutUrls, workplaceOf } from "./common.ts";

const DETAILS = /^(On-?site|Hybrid|Remote|Flexible)\s*·\s*(.+)$/i;

export function isHackajob(email: ParsedEmail): boolean {
  return /hackajob/i.test(email.from);
}

export function parseHackajob(email: ParsedEmail): Role[] {
  const body = email.text || htmlToText(email.html);
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const roles: Role[] = [];

  lines.forEach((line, i) => {
    const m = DETAILS.exec(line);
    if (!m) return;
    const { title, company, url } = identify(lines, i);
    if (!title && !company) return;

    const parts = m[2].split("·").map((p) => p.trim());
    const payPart = parts.find((p) => /£|€|\$|NT\$/.test(p)) ?? "";
    const location = parts.filter((p) => p !== payPart).join(" · ") + ` (${m[1]})`;
    const pay = payPart ? parsePay(payPart.replace(/(\d)\s*-\s*(\d)/, "$1 - £$2")) : null;
    const why = lines[i + 1] && !/^(take a look|apply to|view all|see all)/i.test(lines[i + 1]) ? withoutUrls(lines[i + 1]) : "";

    roles.push({
      id: `hackajob:${slug(company)}-${slug(title)}`,
      source: "hackajob",
      title,
      company,
      location,
      workplace: workplaceOf(m[1]),
      pay,
      url: unwrapLink(url),
      notes: payPart ? [payPart] : [],
      email: { subject: email.subject, date: email.date, messageId: email.messageId },
      excerpt: [`${title} at ${company}`, line, why ? `hackajob's reason for the match: ${why}` : ""].filter(Boolean).join("\n"),
      parse: title && company ? "full" : "partial",
    });
  });
  return roles;
}

/** Find title, company and link in the lines above a details line. */
function identify(lines: string[], i: number): { title: string; company: string; url: string } {
  const above = lines[i - 1] ?? "";
  const twoAbove = lines[i - 2] ?? "";
  const linkOf = (l: string) => urlsIn(l)[0] ?? "";

  // Weekly matches: "<Title> {{link}}" / "at <Company>".
  const at = /^at\s+(.+)$/i.exec(above);
  if (at) return { title: withoutUrls(twoAbove), company: at[1].trim(), url: linkOf(twoAbove) };

  // Reminder: "It's a <Title> {{link}} at <Company> ."
  const reminder = /\bIt'?s an?\s+(.+?)\s*\{\{[^}]*\}\}\s*at\s+(.+?)\s*\.?$/i.exec(above);
  if (reminder) return { title: reminder[1].trim(), company: reminder[2].trim(), url: linkOf(above) };

  // Single match: "...a role at <Company> that ... looking for a <Title> {{link}} ..."
  const looking = /looking for an?\s+(.+?)\s*\{\{[^}]*\}\}/i.exec(above);
  const roleAt = /\brole at\s+(.+?)\s+(?:that|which|who)\b/i.exec(above);
  if (looking) return { title: looking[1].trim(), company: roleAt?.[1].trim() ?? "", url: linkOf(above) };

  return { title: withoutUrls(above), company: "", url: linkOf(above) };
}

/**
 * hackajob's links go through a tracking redirect whose middle segment is
 * base64 JSON holding the real address, sometimes wrapped again in a sign-in
 * link with redirect_to=. Unwrap both, so the link opens the role directly.
 */
export function unwrapLink(url: string): string {
  const m = /\/e\/c\/([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return url;
  try {
    const json = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    let href: string = json.href ?? url;
    const inner = /[?&]redirect_to=([^&]+)/.exec(href);
    if (inner) href = decodeURIComponent(inner[1]);
    return href.replace(/[?#].*$/, "");
  } catch {
    return url;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
