// The hard filters (backlog item C1). Each test either passes a role, drops it
// with a reason, or passes it with a flag for the scoring step to judge.
//
// The rule throughout: drop only when the alert CLEARLY fails a constraint.
// LinkedIn and hackajob have already filtered on the owner's saved searches, so a
// wrongly dropped role is a worse mistake than one extra role to score.

import type { Role, Verdict } from "./role.ts";

export interface Constraints {
  version: number;
  /** Set when the board's settings (config/settings.json) were laid over this file. */
  settingsVersion?: number;
  /** B13: target employers. Never changes a verdict or a score. */
  targets?: {
    companies: string[];
    packBelowLine: boolean;
    extraPlaces: number;
  };
  level: {
    leadership: string[];
    productWords: string[];
    otherKinds: string[];
    otherKindsContext: string[];
    belowFloor: string[];
    notProductManagement: string[];
    notProductUnlessProductInTitle: string[];
    /** B11: hardware and semiconductor work, dropped in every market. */
    hardwareWords?: string[];
    /** The owner, 17 Oct 2026: in the second market any product title passes, except these functions and levels. */
    secondNotProduct?: string[];
    secondNeverAtAnyLevel?: string[];
  };
  locations: {
    london: string[];
    uk: string[];
    /** A second market, named by secondName, where the owner is less choosy (no pay floor, any product title). Optional. */
    second?: string[];
    secondName?: string;
    /** The owner, 17 Oct 2026: EU places, open for target employers only. */
    eu?: string[];
    remoteMaybeUk: string[];
    elsewhere: string[];
    openFromAbroad: string[];
  };
  pay: {
    ukPermanentMinGBPPerYear: number;
    ukPermanentTolerance: number;
    ukContractMinGBPPerDay: number;
    secondMin?: number | null;
    fractionalMin: number | null;
    hoursPerDay: number;
    approxToGBP: Record<string, number>;
  };
  warnings: {
    staleAfterDays: number;
    recruiterWords: string[];
    unnamedClient: string[];
    nda: string[];
    applicantsWarnAt: number;
    /** The owner, 17 Oct 2026: the user works in English only; a required language is a showstopper. */
    languageRequired?: string[];
  };
}

/** Whole-word, case-insensitive: "lead" matches "Lead PM" but not "Leaderboard". */
function hasAny(text: string, words: string[]): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9&]+/g, " ")} `;
  for (const w of words) {
    const needle = ` ${w.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim()} `;
    if (t.includes(needle)) return w;
  }
  return null;
}

/** B13: the target employer this company matches, as whole words, or null. */
export function targetOf(company: string, c: Constraints): string | null {
  if (!company) return null;
  for (const t of c.targets?.companies ?? []) if (hasAny(company, [t])) return t;
  return null;
}

export function judge(role: Role, c: Constraints, today?: string): Verdict {
  const v: Verdict = { kept: true, reasons: [], flags: [], warnings: [], market: "unknown" };
  checkLevel(role, c, v);
  checkLocation(role, c, v);
  checkPay(role, c, v);
  warningSigns(role, c, v, today);
  if (role.parse === "partial") v.flags.push("The email did not give title, company and place clearly: check the advert.");
  v.kept = v.reasons.length === 0;
  return v;
}

function checkLevel(role: Role, c: Constraints, v: Verdict): void {
  const title = role.title;
  if (!title) {
    v.flags.push("No title found in the email.");
    return;
  }
  const hardware = hasAny(title, c.level.hardwareWords ?? []);
  if (hardware) {
    v.reasons.push(`Hardware or semiconductor role ("${hardware}" in the title).`);
    return;
  }
  // The second market (the owner, 17 Oct 2026): anything product-related comes across, whatever its
  // seniority, since the owner cannot be as choosy there; only engineering, design, sales, recruiting and trainee roles drop.
  if (hasAny(`${role.location} ${title}`, c.locations.second ?? []) && hasAny(title, c.level.productWords)) {
    const trainee = hasAny(title, c.level.secondNeverAtAnyLevel ?? []);
    if (trainee) {
      v.reasons.push(`A trainee role ("${trainee}" in the title).`);
      return;
    }
    const other = hasAny(title, c.level.secondNotProduct ?? []);
    if (other) {
      v.reasons.push(`Not a product role ("${other}" in the title).`);
      return;
    }
    v.flags.push(`${c.locations.secondName ?? "Second market"}: a product-related title, brought across whatever its seniority; score it on its merits.`);
    return;
  }
  const notPm = hasAny(title, c.level.notProductManagement);
  const otherKind = hasAny(title, c.level.otherKinds);
  const otherContext = hasAny(title + " " + role.excerpt.slice(0, 600), c.level.otherKindsContext);

  if (otherKind && otherContext) {
    v.flags.push(`A ${otherKind} role rather than a product leadership role: score it on its own merits.`);
    return;
  }
  if (notPm) {
    v.reasons.push(`Not a product management role ("${notPm}" in the title).`);
    return;
  }
  const below = hasAny(title, c.level.belowFloor);
  if (below) {
    v.reasons.push(`Below the Senior PM floor ("${below}" in the title).`);
    return;
  }
  const isProduct = hasAny(title, c.level.productWords);
  const level = hasAny(title, c.level.leadership);
  const otherFunction = hasAny(title, c.level.notProductUnlessProductInTitle);
  if (!isProduct && otherFunction) {
    v.reasons.push(`Not a product role ("${otherFunction}" in the title).`);
    return;
  }
  if (isProduct && !level) {
    // Some companies title senior roles plainly; published pay above the
    // floor is the tell (hackajob's Sierra role: "Product Manager", £150k-£300k).
    const top = role.pay?.max && role.pay.currency ? role.pay.max * (c.pay.approxToGBP[role.pay.currency] ?? 0) : 0;
    if (role.pay?.period === "year" && top >= c.pay.ukPermanentMinGBPPerYear) {
      v.flags.push(`No seniority in the title, but the pay (${role.pay.text}) suggests a senior role: check it.`);
      return;
    }
    v.reasons.push("Below the Senior PM floor (no seniority in the title).");
    return;
  }
  if (!isProduct && !level) {
    v.reasons.push("Not a product role, and no seniority in the title.");
    return;
  }
  if (!isProduct) {
    v.flags.push("Senior title without the word product: check it is a product role.");
  }
  if (level && ["senior", "sr"].includes(level.toLowerCase()) && !hasAny(title, c.level.leadership.filter((w) => !["senior", "sr"].includes(w)))) {
    v.flags.push("Senior PM level: in scope but scored down (target is Lead, Staff and above).");
  }
}

function checkLocation(role: Role, c: Constraints, v: Verdict): void {
  const place = `${role.location} ${role.title}`;
  const whole = `${place} ${role.notes.join(" ")}`;
  const second = hasAny(place, c.locations.second ?? []);
  const london = hasAny(place, c.locations.london);
  const uk = hasAny(place, c.locations.uk);
  const remote = role.workplace === "remote";

  if (second) { v.market = "second"; return; }
  if (london) { v.market = "uk"; return; }
  if (uk) {
    // The owner, 17 Oct 2026: the user need not be London-based, and would consider another
    // major city for the right role, so a UK role anywhere passes; outside London it is flagged.
    v.market = "uk";
    if (remote) return;
    v.flags.push(`UK role outside London or with no city given (${role.location || uk}): for the right role; weigh the move or the commute.`);
    return;
  }
  const eu = hasAny(place, c.locations.eu ?? []);
  const target = targetOf(role.company, c);
  if (eu && target) {
    v.flags.push(`A target employer in the EU (${role.location || eu}): the owner would consider it for ${target}.`);
    return;
  }
  const elsewhere = hasAny(place, c.locations.elsewhere);
  if (elsewhere && !remote) {
    // Rubric v2: consultancy, contract or fractional work abroad can often be
    // done from London (Pantry), so it passes with a flag.
    const open = hasAny(`${role.title} ${role.excerpt.slice(0, 600)}`, c.locations.openFromAbroad);
    if (open) {
      v.flags.push(`Based abroad (${role.location || elsewhere}) but a ${open} role: check it can be done from London${c.locations.secondName ? ` or ${c.locations.secondName}` : ""}.`);
      return;
    }
    v.reasons.push(`Outside London, the UK${c.locations.secondName ? ` and ${c.locations.secondName}` : ""} (${role.location || elsewhere}).`);
    return;
  }
  if (remote || hasAny(whole, c.locations.remoteMaybeUk)) {
    v.flags.push(`Remote${elsewhere ? ` from ${elsewhere}` : ""}: check a UK-based hire is eligible.`);
    return;
  }
  v.flags.push(role.location ? `Place not recognised (${role.location}): check it.` : "No place given: check it.");
}

function checkPay(role: Role, c: Constraints, v: Verdict): void {
  const pay = role.pay;
  if (!pay || pay.max === null) return;
  if (v.market === "second") return; // no floor in the second market yet, by decision
  const text = `${role.title} ${role.notes.join(" ")} ${role.excerpt.slice(0, 800)}`.toLowerCase();
  if (/fractional|part[- ]time|\b\d (days?|d) (a|per) week\b/.test(text)) return; // no fractional floor yet

  const rate = pay.currency ? c.pay.approxToGBP[pay.currency] : undefined;
  if (rate === undefined) {
    v.flags.push(`Pay in a currency with no conversion set (${pay.text}): check it.`);
    return;
  }
  const top = pay.max * rate;
  const shown = pay.text;

  if (pay.period === "day" || pay.period === "hour") {
    const perDay = pay.period === "hour" ? top * c.pay.hoursPerDay : top;
    if (perDay < c.pay.ukContractMinGBPPerDay) {
      v.reasons.push(`Contract rate below £${c.pay.ukContractMinGBPPerDay} a day (${shown}).`);
    }
    return;
  }
  if (pay.period === "year" || pay.period === "month") {
    const perYear = pay.period === "month" ? top * 12 : top;
    const floor = c.pay.ukPermanentMinGBPPerYear;
    const lowest = Math.round(floor * (1 - (c.pay.ukPermanentTolerance ?? 0)));
    if (perYear < lowest) {
      v.reasons.push(`Pay below £${floor.toLocaleString("en-GB")}, and more than ${Math.round((c.pay.ukPermanentTolerance ?? 0) * 100)}% under it (${shown}).`);
    } else if (perYear < floor) {
      v.flags.push(`Pay tops out just under £${floor.toLocaleString("en-GB")} (${shown}): check whether bonus or on-target earnings clear it.`);
    }
    return;
  }
  v.flags.push(`Pay given without a period (${shown}): check it.`);
}

/**
 * Warning signs visible in the alert itself (C5) and the role's age (B7).
 * They never drop a role. The scorer adds the ones only the full advert shows.
 */
function warningSigns(role: Role, c: Constraints, v: Verdict, today?: string): void {
  const w = c.warnings;
  if (!w) return;
  const text = `${role.title} ${role.excerpt} ${role.notes.join(" ")}`;
  const recruiter = role.company ? hasAny(role.company, w.recruiterWords) : null;
  if (recruiter) v.warnings.push(`Posted by what looks like an agency (${role.company}): the hiring company may be unnamed.`);
  const unnamed = hasAny(text, w.unnamedClient);
  if (unnamed && !recruiter) v.warnings.push(`The alert says "${unnamed}": the hiring company may be unnamed.`);
  if (hasAny(text, w.nda)) v.warnings.push("Mentions an NDA: details may come only after signing one.");
  const language = hasAny(text, w.languageRequired ?? []);
  if (language) v.warnings.push(`Mentions ${language[0].toUpperCase()}${language.slice(1)}: if the advert requires it, that is a showstopper (the owner speaks English only).`);
  const applicants = text.match(/(\d[\d,]*)\+?\s+applicants/i);
  if (applicants && Number(applicants[1].replace(/,/g, "")) >= w.applicantsWarnAt) v.warnings.push(`${applicants[0]}: long odds.`);
  if (/\breposted\b/i.test(text)) v.warnings.push("Reposted.");
  const age = ageInDays(role, today);
  if (age !== null && age > w.staleAfterDays) v.warnings.push(`Alerted ${age} days ago: check it is still open.`);
}

/** Days since the alert email arrived: a lower bound on how old the posting is. */
export function ageInDays(role: Role, today?: string): number | null {
  if (!role.email?.date || !today) return null;
  const sent = Date.parse(role.email.date.slice(0, 10) + "T12:00:00Z");
  const now = Date.parse(today + "T12:00:00Z");
  if (Number.isNaN(sent) || Number.isNaN(now)) return null;
  return Math.max(0, Math.round((now - sent) / 86_400_000));
}
