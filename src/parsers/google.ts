// Google Careers job-alert emails (B12, shaped on the owner's alert of 28 Sep 2026).
//
// Sent by careers-noreply@google.com. Each job is a block of lines:
//
//     Group Product Manager, Google Labs {{https://www.google.com/about/careers/applications/jobs/results/92710706155004614-...}}
//     Google – London
//     4 days ago
//     <the advert's minimum qualifications, one per line>
//
// The number in the job's address is its id. Google lists every job it found,
// so there is nothing left out to report.

import type { ParsedEmail } from "../mime.ts";
import type { Role } from "../role.ts";
import { htmlToText } from "../html.ts";
import { urlsIn, withoutUrls, workplaceOf } from "./common.ts";

const JOB = /google\.com\/about\/careers\/applications\/jobs\/results\/(\d{6,})/i;
const FOOTER = /^(you'?re receiving this email|manage alerts|unsubscribe|view more)/i;

export function isGoogleAlert(email: ParsedEmail): boolean {
  return /careers-noreply@google\.com/i.test(email.from);
}

export function parseGoogle(email: ParsedEmail): { roles: Role[] } {
  const lines = (email.text && JOB.test(email.text) ? email.text : htmlToText(email.html))
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const starts = lines.flatMap((l, i) => (JOB.test(l) ? [i] : []));
  const roles: Role[] = [];
  starts.forEach((at, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const block = lines.slice(at + 1, end);
    const footer = block.findIndex((l) => FOOTER.test(l));
    const body = footer >= 0 ? block.slice(0, footer) : block;
    const url = urlsIn(lines[at]).find((u) => JOB.test(u)) ?? "";
    const id = JOB.exec(url)![1];
    const title = withoutUrls(lines[at]);
    // "Google – London": the company, then the place, split by a dash.
    const where = /^(.+?)\s+[–-]\s+(.+)$/.exec(body[0] ?? "");
    const company = where ? where[1].trim() : "Google";
    const location = where ? where[2].trim() : "";
    const age = body.find((l) => /\b(ago|today|yesterday)\b/i.test(l) && l.length < 30) ?? "";
    const requirements = body.filter((l) => l !== body[0] && l !== age);
    roles.push({
      id: `google:${id}`,
      source: "google",
      title,
      company,
      location,
      workplace: workplaceOf(location),
      pay: null,
      url: url.replace(/[?#].*$/, ""),
      notes: age ? [`Posted ${age}`] : [],
      email: { subject: email.subject, date: email.date, messageId: email.messageId },
      excerpt: [`${title} at ${company}, ${location}`, ...(requirements.length ? ["Minimum qualifications:", ...requirements] : [])].join("\n"),
      parse: title && where ? "full" : "partial",
    });
  });
  return { roles };
}
