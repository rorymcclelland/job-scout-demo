// The two checks around the model (H5b, Sprint 5c). The H13 spike found that
// both models tested invent plausible requirements for a page with no advert
// text, so:
//   gate()   before: the page must hold enough readable text, and the role's title;
//   ground() after: each requirement and the pay must be found in the advert itself.

import { keyWords } from "./text.ts";

export function gate(text: string, title: string, minChars = 1500): { ok: boolean; reason?: string } {
  if (text.length < minChars) return { ok: false, reason: `only ${text.length} characters of readable text (the page is probably built by scripts)` };
  // Style sheets and scripts left in the text (the Google case in the spike): braces and semicolons are rare in prose.
  const code = (text.match(/[{};]/g) ?? []).length / text.length;
  if (code > 0.01) return { ok: false, reason: "the page's text is mostly code, not an advert (it is probably built by scripts)" };
  // Alert titles often differ a little from the advert's ("Staff AI Product Manager"
  // for "Product Manager"), so two of the title's words are enough.
  const words = [...new Set(keyWords(title))];
  const t = text.toLowerCase();
  const found = words.filter((w) => t.includes(w));
  if (found.length < Math.min(2, words.length)) return { ok: false, reason: `the role's title (${title}) is not on the page` };
  return { ok: true };
}

export interface Spec {
  title: string;
  company: string;
  location: string;
  workplace: string;
  employment: string;
  pay: { min: number | null; max: number | null; currency: string | null; period: string | null; asWritten: string } | null;
  mustHaves: string[];
  niceToHaves: string[];
  responsibilities: string[];
  reportsTo: string | null;
  suspectedInjection: boolean;
  injectionLines: string[];
}

export interface Grounding {
  mustHaves: { kept: number; dropped: string[] };
  niceToHaves: { kept: number; dropped: string[] };
  pay: "grounded" | "dropped" | "none";
  share: number; // share of must-haves kept
  reliable: boolean;
}

/** An item is grounded when most of its key words appear together in one stretch of the advert. */
export function grounded(item: string, lines: string[][]): boolean {
  const w = [...new Set(keyWords(item))];
  if (w.length === 0) return false;
  const need = Math.max(1, Math.ceil(w.length * 0.6));
  for (let i = 0; i < lines.length; i++) {
    const window = new Set([...(lines[i] ?? []), ...(lines[i + 1] ?? [])]);
    if (w.filter((x) => window.has(x)).length >= need) return true;
  }
  return false;
}

const CURRENCIES = new Set(["GBP", "USD", "EUR", "TWD", "NTD", "CAD", "AUD", "SGD", "HKD", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN"]);
const FUNDING = /\b(series [a-f]|raised|raising|funding|round|valuation|arr|revenue|investors?|backed)\b/i;
const PAY_WORDS = /\b(salary|pay|compensation|base|ote|per annum|a year|per year|annual|day rate|per day|a day|hourly|per hour|package)\b/i;

/** No figure at all (0, unknown, "competitive"): the advert gives no pay. */
function noFigure(pay: NonNullable<Spec["pay"]>): boolean {
  const n = (v: number | null) => typeof v === "number" && v > 0;
  return !n(pay.min) && !n(pay.max) && !/\d/.test(pay.asWritten ?? "");
}

/** Pay must be a believable figure, in a real currency, found in the advert on a line about pay, not funding (H5 retest). */
function payFound(pay: NonNullable<Spec["pay"]>, text: string): boolean {
  if (!pay.currency || !CURRENCIES.has(pay.currency.toUpperCase())) return false;
  if ((pay.min !== null && pay.min <= 0) || (pay.max !== null && pay.max <= 0)) return false;
  if (pay.min !== null && pay.max !== null && pay.min > pay.max) return false;
  const lines = text.split(/\n/).map((l) => l.replace(/\s+/g, " ").toLowerCase());
  const written = (pay.asWritten ?? "").replace(/\s+/g, " ").toLowerCase().trim();
  const forms = (n: number) => [String(n), `${n / 1000}k`];
  const has = (line: string, n: number | null) => n === null || forms(n).some((f) => line.replace(/[,\s]/g, "").includes(f));
  const found = lines.filter((l) => (written.length > 3 && /\d/.test(written) && l.includes(written)) || ((pay.min !== null || pay.max !== null) && has(l, pay.min) && has(l, pay.max)));
  return found.some((l) => !FUNDING.test(l) || PAY_WORDS.test(l));
}

/** Wording that says the job is gone (the Norland Reuters page in the retest). */
const CLOSED = [
  /this (?:job|position|role|vacancy|posting) (?:was|has been) (?:removed|closed|filled|taken down)/i,
  /no longer (?:accepting|taking) applications/i,
  /applications? (?:are|is|have) (?:now )?closed/i,
  /this (?:job|position|role|vacancy|posting) (?:is )?no longer (?:available|open|active)/i,
  /this (?:job|position|role|vacancy|posting) has expired/i,
];
export function closedNotice(text: string): string | null {
  for (const re of CLOSED) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function ground(spec: Spec, text: string): { spec: Spec; grounding: Grounding } {
  const lines = text.split(/\n|(?<=[.;])\s+/).map((l) => keyWords(l));
  const split = (items: string[]) => {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const it of items ?? []) (grounded(it, lines) ? kept : dropped).push(it);
    return { kept, dropped };
  };
  const m = split(spec.mustHaves);
  const n = split(spec.niceToHaves);
  const pay = !spec.pay || noFigure(spec.pay) ? "none" : payFound(spec.pay, text) ? "grounded" : "dropped";
  const share = spec.mustHaves?.length ? m.kept.length / spec.mustHaves.length : 0;
  const out: Spec = { ...spec, mustHaves: m.kept, niceToHaves: n.kept, pay: pay === "grounded" ? spec.pay : null };
  return { spec: out, grounding: { mustHaves: { kept: m.kept.length, dropped: m.dropped }, niceToHaves: { kept: n.kept.length, dropped: n.dropped }, pay, share, reliable: m.kept.length > 0 && share >= 0.5 } };
}
