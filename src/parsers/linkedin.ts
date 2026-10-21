// LinkedIn job-alert emails.
//
// An alert lists several jobs. Each job links to linkedin.com/jobs/view/<id>
// (often via /comm/jobs/view/), and that number is what we key on.
//
// Two layouts are handled:
//  - the plain-text part, where a job's lines (title, company, place, extras)
//    come first and its "View job: <url>" line comes last;
//  - the HTML part, flattened by htmlToText, where the title is the link itself
//    and the company and place follow it.
// We prefer plain text when it carries job links, since it is far more regular.

import type { ParsedEmail } from "../mime.ts";
import type { Role } from "../role.ts";
import { htmlToText } from "../html.ts";
import { parsePay } from "../pay.ts";
import { isLocationLine, isNoise, isSignal, urlsIn, withoutUrls, workplaceOf } from "./common.ts";

const JOB_ID = /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/\s?]*-)?(\d{6,})/i;

export function jobIdOf(url: string): string | null {
  const m = JOB_ID.exec(url);
  return m ? m[1] : null;
}

export function isLinkedInAlert(email: ParsedEmail): boolean {
  return /linkedin\.com/i.test(email.from) && JOB_ID.test(email.text + email.html);
}

export function parseLinkedIn(email: ParsedEmail): Role[] {
  const fromText = email.text && JOB_ID.test(email.text) ? parseTextLayout(email.text) : [];
  const roles = fromText.length > 0 ? fromText : parseHtmlLayout(htmlToText(email.html));
  // Drop links that carried no job details at all (e.g. "Jobs similar to ...").
  return roles.map((r) => finish(r, email)).filter((r) => r.title || r.company || r.location);
}

interface Draft {
  jobId: string;
  lines: string[]; // identity and context lines, URLs removed, noise removed
  titleHint?: string; // the link text, in the HTML layout
}

/** Plain text: a job's lines run from the previous job's link to its own. */
function parseTextLayout(text: string): Draft[] {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const drafts: Draft[] = [];
  let pending: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const id = urlsIn(line).map(jobIdOf).find((x) => x) ?? null;
    if (id) {
      const words = withoutUrls(line).replace(/^view job:?/i, "").trim();
      if (!seen.has(id)) {
        seen.add(id);
        drafts.push({ jobId: id, lines: words ? [...pending, words] : pending });
      }
      pending = [];
      continue;
    }
    if (!line || isNoise(line)) continue;
    pending.push(withoutUrls(line));
  }
  return drafts;
}

/** HTML: a job's lines run from its first link to the next job's first link. */
function parseHtmlLayout(text: string): Draft[] {
  const drafts: Draft[] = [];
  const byId = new Map<string, Draft>();
  let current: Draft | null = null;

  for (const raw of text.split("\n")) {
    const id = urlsIn(raw).map(jobIdOf).find((x) => x) ?? null;
    const words = withoutUrls(raw);
    // A link can wrap the whole card: "Title ¦ Company · Place" (see html.ts).
    const [head, ...rest] = words ? words.split(" ¦ ").map((w) => w.trim()) : [""];
    if (id && !byId.has(id)) {
      current = { jobId: id, lines: rest, titleHint: head || undefined };
      byId.set(id, current);
      drafts.push(current);
      continue;
    }
    if (id && byId.has(id)) {
      current = byId.get(id)!;
      if (!current.titleHint && head) {
        current.titleHint = head;
        current.lines.push(...rest);
      } else if (words && head !== current.titleHint) current.lines.push(head, ...rest);
      continue;
    }
    if (current && words && !isNoise(words)) current.lines.push(words);
  }
  return drafts;
}

/** Work out title, company and place from a draft's lines. */
function finish(d: Draft, email: ParsedEmail): Role {
  // "Acme · London, England (Hybrid)" carries two facts on one line.
  const lines = d.lines
    .flatMap((l) => (l.includes(" · ") ? l.split(" · ").map((s) => s.trim()) : [l]))
    .filter((l) => l && !isNoise(l));

  let title = d.titleHint && !isNoise(d.titleHint) ? d.titleHint : "";
  let company = "";
  let location = "";

  // LinkedIn's cards put company and place on one line: "Sterling · London (Hybrid)".
  // Trust that shape even when the place is one we do not recognise.
  const dotLine = d.lines.find((l) => l.includes(" · ") && !isNoise(l));

  if (title && dotLine) {
    const parts = dotLine.split(" · ").map((p) => p.trim()).filter((p) => p && !isNoise(p));
    company = parts[0] ?? "";
    location = parts.slice(1).join(" · ");
  } else if (title) {
    // HTML layout without the dot line: the place is the first line that looks
    // like one, the company the first other line that is not an extra.
    const rest = lines.filter((l) => l !== title);
    location = rest.find((l) => isLocationLine(l)) ?? "";
    company = rest.find((l) => l !== location && !isSignal(l)) ?? "";
  } else {
    // Text layout: title, company, place, then extras. The place is normally
    // the third line; a title such as "Head of Product, Remote UK" also looks
    // like a place, so search from the third line first.
    let at = lines.findIndex((l, i) => i >= 2 && isLocationLine(l));
    if (at >= 2) {
      title = lines[at - 2];
      company = lines[at - 1];
      location = lines[at];
    } else {
      at = lines.findIndex((l) => isLocationLine(l));
      const others = lines.filter((_, i) => i !== at && !isSignal(lines[i]));
      title = others[0] ?? "";
      company = others[1] ?? "";
      location = at >= 0 ? lines[at] : "";
    }
  }

  const used = new Set([title, company, location, ...location.split(" · ")]);
  const notes = lines.filter((l) => !used.has(l) && isSignal(l));
  // Some recruiters put the pay in the title: "Director of Digital Product - Up to £110,000".
  const payLine = notes.find((n) => parsePay(n)) ?? (parsePay(title) ? title : undefined);

  return {
    id: `linkedin:${d.jobId}`,
    source: "linkedin",
    title,
    company,
    location,
    workplace: workplaceOf(location + " " + notes.join(" ")),
    pay: payLine ? parsePay(payLine) : null,
    url: `https://www.linkedin.com/jobs/view/${d.jobId}/`,
    notes,
    email: { subject: email.subject, date: email.date, messageId: email.messageId },
    excerpt: [title, company, location, ...notes].filter(Boolean).join("\n"),
    parse: title && company && location ? "full" : "partial",
  };
}
