// Microsoft Careers job-alert emails (B12, shaped on the owner's alert of 1 Oct 2026).
//
// Sent from email.careers.microsoft.com. Each job is a block of lines:
//
//     Senior Recruiter Microsoft AI {{https://microsoft.eightfold.ai/careerhub/explore/jobs/1970393557002628?...}}
//     United Kingdom, London, London
//     <a second place, after a " |" on the line before, when there is one>
//     <skill tags such as "Stakeholder Management" and "Good Match">
//
// The number in the job's address is its id. The email shows only the first
// few jobs ("We've found 30 new jobs", then three, then "View all"), so the
// parser reports how many it could not see, for the digest to be honest about.

import type { ParsedEmail } from "../mime.ts";
import type { Role } from "../role.ts";
import { htmlToText } from "../html.ts";
import { urlsIn, withoutUrls } from "./common.ts";

const JOB = /microsoft\.eightfold\.ai\/careerhub\/explore\/jobs\/(\d{6,})/i;
/** "United Kingdom, London, London", or "Ireland, Multiple Locations, Multiple Locations |". */
const PLACE = /^[A-Z][^,|]{1,40},\s*[^,|]{1,40},\s*[^,|]{1,40}\s*\|?$/;
const END = /^(view all|take a moment|review profile|manage alerts)\b/i;

export function isMicrosoftAlert(email: ParsedEmail): boolean {
  return /careers\.microsoft\.com/i.test(email.from);
}

export function parseMicrosoft(email: ParsedEmail): { roles: Role[]; note?: string } {
  const text = email.text && JOB.test(email.text) ? email.text : htmlToText(email.html);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const starts = lines.flatMap((l, i) => (JOB.test(l) ? [i] : []));
  const roles: Role[] = [];
  starts.forEach((at, n) => {
    const next = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const block = lines.slice(at + 1, next);
    const stop = block.findIndex((l) => END.test(l));
    const body = stop >= 0 ? block.slice(0, stop) : block;
    const places = body.filter((l) => PLACE.test(l)).map((l) => l.replace(/\s*\|$/, ""));
    const tags = body.filter((l) => !PLACE.test(l));
    const url = urlsIn(lines[at]).find((u) => JOB.test(u)) ?? "";
    const title = withoutUrls(lines[at]);
    const location = places.join(" | ");
    roles.push({
      id: `microsoft:${JOB.exec(url)![1]}`,
      source: "microsoft",
      title,
      company: "Microsoft",
      location,
      workplace: null, // the alert does not say
      pay: null,
      url: url.replace(/[?#].*$/, ""),
      notes: tags.length ? [`Microsoft's tags: ${tags.join(", ")}`] : [],
      email: { subject: email.subject, date: email.date, messageId: email.messageId },
      excerpt: [`${title} at Microsoft, ${location}`, ...(tags.length ? [`Tags: ${tags.join(", ")}`] : [])].join("\n"),
      parse: title && location ? "full" : "partial",
    });
  });
  const found = /found\s+(\d+)\s+new jobs?/i.exec(text.replace(/\s+/g, " "));
  const total = found ? Number(found[1]) : null;
  const note = total !== null && total > roles.length
    ? `showed ${roles.length} of ${total} new jobs; the rest are only on Microsoft's site ("View all"). A narrower saved search makes the ones shown count.`
    : undefined;
  return { roles, note };
}
