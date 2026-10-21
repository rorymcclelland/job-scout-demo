// The reader's evaluation (backlog H8, Sprint 7): did the local model copy
// each advert's requirements and pay correctly?
//
// Each advert in the set has a checked answer (eval\reader\expected.json in
// the vault): the pay as stated (or none), whether the input gate should
// refuse it, and each requirement as a few words that must all appear in one
// of the model's requirements. Paraphrase is allowed; a requirement cut to a
// bare label, dropped, or a pay figure made up from a funding round is not.
// The grounding check (src/reader/check.ts) has already removed anything the
// advert does not say, so this checks what is missing or wrong, not invented.

import type { Spec } from "./check.ts";

export interface ExpectedPay { min: number; max: number; currency: string }

export interface ExpectedAdvert {
  advert: string;
  /** The gate should refuse this one (a page built by scripts, say). */
  refuse?: boolean;
  /** The advert says the job has closed. */
  closed?: boolean;
  pay: ExpectedPay | null;
  /** One entry per requirement: words that must all appear in one of the model's requirements. */
  requirements: string[][];
  note?: string;
}

export interface ReaderAnswer {
  advert: string;
  /** Why the gate refused it, if it did. */
  gate?: string | null;
  error?: string | null;
  status?: string | null;
  spec: Pick<Spec, "mustHaves" | "pay"> | null;
}

export interface Judgement {
  advert: string;
  right: boolean;
  problems: string[];
  /** H19: the model's requirements when one was missed, so a person can grade the miss quickly. */
  got?: string[];
}

export interface ReaderScore {
  right: number;
  of: number;
  rate: number | null;
  refusedAsExpected: number;
  wrong: Judgement[];
  missing: string[];
}

const words = (s: string) => ` ${String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9+#]+/g, " ").trim()} `;

/**
 * H19: a light stem, so an inflection of the checked word still counts
 * ("translating" matches "translate", "translation"; "decisions" matches
 * "decision"). Only a few common English endings are cut, and never below four
 * letters, so short words and acronyms stay as they are.
 */
export function stem(w: string): string {
  let x = w.toLowerCase();
  for (const end of ["ations", "ation", "ings", "ing", "ions", "ion", "ed", "sses", "es", "s", "e", "al", "ly"]) {
    // "process" keeps its double s, so it stems like "processes" (review, Sprint 8).
    if (end === "s" && x.endsWith("ss")) continue;
    if (x.length - end.length >= 4 && x.endsWith(end)) { x = end === "sses" ? x.slice(0, -2) : x.slice(0, -end.length); break; }
  }
  return x;
}

/** Does one of the model's requirements contain every key, word for word or as an inflection? */
export function hasAll(requirement: string, keys: string[]): boolean {
  const toks = words(requirement).trim().split(" ").filter(Boolean);
  const stems = toks.map(stem);
  return keys.every((k) => {
    const kw = words(k).trim();
    if (kw.includes(" ")) return words(requirement).includes(` ${kw}`);
    const ks = stem(kw);
    return toks.some((t, i) => t.startsWith(kw) || stems[i] === ks);
  });
}

export function payMatches(want: ExpectedPay | null, got: Spec["pay"] | null | undefined): boolean {
  const empty = !got || !got.min || !got.max || !/^[A-Z]{3}$/.test(String(got.currency ?? ""));
  if (!want) return empty;
  if (empty) return false;
  return got!.min === want.min && got!.max === want.max && String(got!.currency).toUpperCase() === want.currency.toUpperCase();
}

export function judge(want: ExpectedAdvert, got: ReaderAnswer | undefined): Judgement {
  const problems: string[] = [];
  if (!got) return { advert: want.advert, right: false, problems: ["no answer"] };
  if (want.refuse) {
    if (!got.gate) problems.push("the gate should have refused it");
    return { advert: want.advert, right: problems.length === 0, problems };
  }
  if (got.gate) return { advert: want.advert, right: false, problems: [`refused by the gate (${got.gate})`] };
  if (want.closed) {
    if (got.status !== "closed") problems.push("the advert is closed, but it was not marked closed");
    return { advert: want.advert, right: problems.length === 0, problems };
  }
  // H19: say so when the reader marked the advert closed, rather than "no answer" (the 19 Oct puzzle).
  if (got.status === "closed") return { advert: want.advert, right: false, problems: ["marked closed: the page says the job has closed; check the advert, and mark it closed in expected.json if so"] };
  if (got.error || !got.spec) return { advert: want.advert, right: false, problems: [`no spec (${got.error ?? "no answer"})`] };
  const reqs = (got.spec.mustHaves ?? []).map(String);
  let missed = false;
  for (const need of want.requirements) {
    if (!reqs.some((r) => hasAll(r, need))) { problems.push(`missed the requirement "${need.join(" ... ")}"`); missed = true; }
  }
  if (!payMatches(want.pay, got.spec.pay)) {
    const p = got.spec.pay;
    problems.push(want.pay
      ? `pay should be ${want.pay.currency} ${want.pay.min} to ${want.pay.max}, got ${p ? `${p.currency} ${p.min} to ${p.max}` : "none"}`
      : `the advert gives no pay, got ${p?.currency} ${p?.min} to ${p?.max}`);
  }
  return { advert: want.advert, right: problems.length === 0, problems, ...(missed ? { got: reqs } : {}) };
}

export function scoreReader(expected: ExpectedAdvert[], answers: ReaderAnswer[]): ReaderScore {
  const by = new Map(answers.map((a) => [a.advert, a]));
  let right = 0, of = 0, refusedAsExpected = 0;
  const wrong: Judgement[] = [];
  const missing: string[] = [];
  for (const e of expected) {
    const got = by.get(e.advert);
    if (!got) missing.push(e.advert);
    const j = judge(e, got);
    if (e.refuse) {
      if (j.right) refusedAsExpected++;
      else wrong.push(j);
      continue; // refusals are not counted in the graded figure, as in the H5 retest
    }
    of++;
    if (j.right) right++;
    else wrong.push(j);
  }
  return { right, of, rate: of ? Math.round((right / of) * 1000) / 10 : null, refusedAsExpected, wrong, missing };
}
