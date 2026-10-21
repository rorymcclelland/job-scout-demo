// Reads pay out of the short text alerts carry, e.g.
//   "£100K/yr - £115K/yr"   "£120,000 - £140,000 a year"   "£800/day"
//   "£650 - £750 per day"   "NT$2,400,000 - NT$3,000,000"
// Returns null when there is no recognisable amount: unknown pay never filters.

import type { Pay } from "./role.ts";

const CURRENCY: Array<[RegExp, Pay["currency"]]> = [
  [/NT\$|TWD/i, "TWD"],
  [/£|GBP/i, "GBP"],
  [/€|EUR/i, "EUR"],
  [/US\$|\$|USD/i, "USD"],
];

export function parsePay(text: string): Pay | null {
  const amountPattern = /(?:NT\$|US\$|£|€|\$)?\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?([kK])?/g;
  const hasMoneyCue = /NT\$|TWD|£|GBP|€|EUR|\$|USD/i.test(text);
  if (!hasMoneyCue) return null;

  const amounts: number[] = [];
  for (const m of text.matchAll(amountPattern)) {
    if (!m[1]) continue;
    let n = Number(m[1].replace(/[,]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
    if (m[2]) n *= 1000;
    // Ignore small stray numbers such as "2 days a week" that are not pay.
    if (n >= 50) amounts.push(n);
  }
  if (amounts.length === 0) return null;

  let currency: Pay["currency"] = null;
  for (const [pattern, code] of CURRENCY) {
    if (pattern.test(text)) { currency = code; break; }
  }

  let period: Pay["period"] = null;
  if (/\/\s?(day|d)\b|per day|a day|daily|day rate/i.test(text)) period = "day";
  else if (/\/\s?(hr|hour)\b|per hour|an hour|hourly/i.test(text)) period = "hour";
  else if (/\/\s?(mo|month)\b|per month|a month|monthly/i.test(text)) period = "month";
  else if (/\/\s?(yr|year)\b|per year|a year|annual|p\.?a\.?|per annum/i.test(text)) period = "year";
  else period = Math.max(...amounts) >= 20000 ? "year" : null; // a bare "£120,000" is a salary

  return {
    min: Math.min(...amounts),
    max: Math.max(...amounts),
    currency,
    period,
    text: text.trim(),
  };
}
