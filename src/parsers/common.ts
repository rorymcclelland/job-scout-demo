// Helpers shared by the LinkedIn and hackajob parsers.

import type { Role } from "../role.ts";

/** Words that show a line is about where the job is. */
const PLACE =
  /\b(United Kingdom|UK|England|Scotland|Wales|Northern Ireland|London|Manchester|Bristol|Edinburgh|Cambridge|Oxford|Taiwan|Taipei|New Taipei|Hsinchu|Taichung|Tainan|Kaohsiung|Singapore|Jurong|Tuas|Woodlands|Remote|Hybrid|On-site|Onsite|EMEA|Europe|European Union|Ireland|Dublin|Germany|Berlin|Munich|France|Paris|Netherlands|Amsterdam|Spain|Barcelona|Madrid|Portugal|Lisbon|Switzerland|Zurich|Geneva|United States|USA|New York|San Francisco|Singapore|Hong Kong|Japan|Tokyo|India|Bengaluru|Canada|Toronto|Australia|Sydney|Greater [A-Z][a-z]+ Area|[A-Z][a-z]+ Area)\b/;

export function isLocationLine(line: string): boolean {
  if (line.length > 90) return false;
  return PLACE.test(line);
}

/** Lines LinkedIn and hackajob add around a job that are not its title, company or place. */
const NOISE = [
  /^your job alert/i, /^new jobs? (match|for)/i, /^jobs? you may be interested/i,
  /^view (job|all|more)/i, /^see (all|more) jobs/i, /^apply\b/i, /easy apply/i,
  /actively (hiring|recruiting)/i, /^promoted/i, /alumni/i, /connections? work here/i,
  /applicants?$/i, /early applicant/i, /^new$/i, /^\d+ (hours?|days?|weeks?) ago$/i,
  /^posted/i, /unsubscribe/i, /^manage (alerts|your)/i, /^-{3,}$/, /^_{3,}$/, /^={3,}$/,
  /^linkedin$/i, /^hackajob$/i, /^this email was (intended|sent)/i, /^learn why/i,
  /^you are receiving/i, /^© ?\d{4}/, /^help$/i, /^privacy/i, /^search other jobs/i,
  /^(job )?search smarter/i, /^top job picks/i, /^\d+ new jobs?/i, /^matches your/i,
  /^your response rate/i, /^in-network/i, /^verified$/i, /^be among the first/i,
  // LinkedIn's Premium and widget promotions, and its links to job searches.
  /premium/i, /free trial/i, /^stand out and let hirers/i, /^see jobs where/i, /widgets?\b/i,
  /^expand your search/i, /^jobs similar to/i, /^recommendations based on/i, /^view jobs in/i, /^[^·]{1,40} jobs$/i,
  /company alums?$/i, /^\d+ connections?$/i, /^\d+ school alums?$/i,
];

export function isNoise(line: string): boolean {
  return NOISE.some((p) => p.test(line.trim()));
}

/** Lines worth keeping as context for the scoring step, though not identity. */
const SIGNAL = /applicants?|easy apply|actively|repost|promoted|\bago\b|posted|£|NT\$|\$|€|per (day|year|annum)|salary|contract|fractional|part[- ]time|full[- ]time|permanent/i;

export function isSignal(line: string): boolean {
  return SIGNAL.test(line);
}

export function workplaceOf(text: string): Role["workplace"] {
  if (/\bremote\b/i.test(text)) return "remote";
  if (/\bhybrid\b/i.test(text)) return "hybrid";
  if (/\bon-?site\b|in[- ]office/i.test(text)) return "onsite";
  return null;
}

/** Strip the "{{https://...}}" link markers htmlToText leaves, and bare addresses. */
export function withoutUrls(line: string): string {
  return line.replace(/\{\{[^}]*\}\}/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
}

export function urlsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/https?:\/\/[^\s<>"'){}\]]+/g)) out.push(m[0]);
  return out;
}
