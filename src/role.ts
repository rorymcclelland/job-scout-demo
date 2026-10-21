// The one record every source is turned into (backlog item B5).

/**
 * The sources the scout has a parser for (B12 made this the one list: the
 * role type, the email kinds, source health and the history all follow it).
 * To add a source: a parser in src/parsers, an entry here, and its sender in
 * config/sources.json or the board's Settings.
 */
export const SOURCES = [
  { id: "linkedin", name: "LinkedIn" },
  { id: "hackajob", name: "hackajob" },
  { id: "google", name: "Google Careers" },
  { id: "microsoft", name: "Microsoft Careers" },
] as const;

export type Source = (typeof SOURCES)[number]["id"];

export const sourceName = (id: string): string => SOURCES.find((s) => s.id === id)?.name ?? id;

/** Zero counts for every source, plus "other" for email no parser recognised. */
export function sourceCounts(): Record<Source | "other", number> {
  const out = { other: 0 } as Record<Source | "other", number>;
  for (const s of SOURCES) out[s.id] = 0;
  return out;
}

export interface Pay {
  min: number | null;
  max: number | null;
  currency: "GBP" | "TWD" | "USD" | "EUR" | "SGD" | null;
  period: "year" | "day" | "hour" | "month" | null;
  text: string; // as written in the email
}

export interface Role {
  /** Stable key, e.g. "linkedin:4477156160". Used to de-duplicate across runs. */
  id: string;
  source: Source;
  title: string;
  company: string; // "" when the alert does not say
  location: string; // as written, e.g. "London, England, United Kingdom (Hybrid)"
  workplace: "remote" | "hybrid" | "onsite" | null;
  pay: Pay | null;
  url: string; // the job's own page, tracking parameters removed
  /** Lines from the email near this role (applicant counts, "Easy Apply", salary). */
  notes: string[];
  email: { subject: string; date: string; messageId: string };
  /**
   * The email's own words about this role. For hackajob this is often the only
   * description we have, because hackajob's job pages sit behind a sign-in.
   */
  excerpt: string;
  /** How sure the parser is that title, company and location are right. */
  parse: "full" | "partial";
}

export interface Verdict {
  kept: boolean;
  /** Why it was dropped. Empty when kept. */
  reasons: string[];
  /** Things the scoring step should look at: unclear location, level and so on. */
  flags: string[];
  /** Warning signs seen in the alert (C5, B7): agency poster, NDA, stale, 200+ applicants. Never a reason to drop. */
  warnings: string[];
  /** The market the role falls in, decided by the location test. */
  market: "uk" | "second" | "unknown";
}
