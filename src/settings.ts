// Settings the owner edits on the board (the Settings dialog of the Application
// Pipeline). The board keeps them in its database; each morning the scoring
// run copies them to config/settings.json, and this file lays them over
// config/constraints.json and config/sources.json. Anything missing or
// malformed in settings.json is ignored field by field, so a bad value can
// never stop the mail being read: the JSON files' own values stand.

import type { Constraints } from "./filters.ts";
import type { Sources } from "./config.ts";

export interface BoardSettings {
  version?: number;
  rubricVersion?: number;
  scoring?: {
    carryOverMax?: number;
  };
  control?: {
    paused?: boolean;
    advertsPerRun?: number;
  };
  filters?: {
    ukPermanentMin?: number;
    ukPermanentTolerancePct?: number;
    ukContractMinPerDay?: number;
    secondMin?: number | null;
    fractionalMin?: number | null;
    hoursPerDay?: number;
    eurToGbp?: number;
    usdToGbp?: number;
  };
  warnings?: {
    staleAfterDays?: number;
    applicantsWarnAt?: number;
    recruiterWords?: string[];
    unnamedClient?: string[];
    nda?: string[];
  };
  markets?: Partial<Record<"london" | "uk" | "second" | "remoteMaybeUk" | "elsewhere" | "openFromAbroad", string[]>>;
  level?: Partial<Record<"leadership" | "productWords" | "otherKinds" | "otherKindsContext" | "belowFloor" | "notProductManagement" | "notProductUnlessProductInTitle" | "hardwareWords", string[]>>;
  /** H5: the advert reader on the PC. */
  reader?: {
    enabled?: boolean;
    model?: string;
    useForScoring?: boolean;
    waitMinutes?: number;
  };
  targets?: {
    companies?: string[];
    packBelowLine?: boolean;
    extraPlaces?: number;
  };
  sources?: {
    senders?: Array<{ source: string; from: string }>;
    firstRunLookbackDays?: number;
    /** Sprint 6a (I1). */
    replySenders?: Array<{ system: string; domain: string }>;
    repliesEnabled?: boolean;
  };
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

const words = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string" && w.trim() !== "")
    ? v.map((w: string) => w.trim().toLowerCase())
    : undefined;

export interface ReaderSettings {
  enabled: boolean;
  model: string;
  /** False until a model passes the retest (the owner, 16 Oct 2026): specs then feed only the ATS match. */
  useForScoring: boolean;
  /** How long the reader waits for the morning run's list of addresses. */
  waitMinutes: number;
}

export const READER_DEFAULTS: ReaderSettings = { enabled: true, model: "qwen2.5:14b", useForScoring: false, waitMinutes: 30 };

export function readerSettings(s: BoardSettings | null): ReaderSettings {
  const r = s?.reader ?? {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : READER_DEFAULTS.enabled,
    model: typeof r.model === "string" && /^[\w.:/-]{2,80}$/.test(r.model.trim()) ? r.model.trim() : READER_DEFAULTS.model,
    useForScoring: typeof r.useForScoring === "boolean" ? r.useForScoring : READER_DEFAULTS.useForScoring,
    waitMinutes: num(r.waitMinutes, 0, 120) ?? READER_DEFAULTS.waitMinutes,
  };
}

/** Lay the board's settings over the JSON files' values. Returns new objects; the inputs are untouched. */
export function applySettings(c: Constraints, src: Sources, s: BoardSettings | null): { constraints: Constraints; sources: Sources; applied: string[]; carryOverMax: number } {
  const constraints: Constraints = structuredClone(c);
  const sources: Sources = structuredClone(src);
  const applied: string[] = [];
  let carryOverMax = 2;
  if (!s || typeof s !== "object") return { constraints, sources, applied, carryOverMax };

  const set = <T>(label: string, value: T | undefined, put: (v: T) => void) => {
    if (value !== undefined) {
      put(value);
      applied.push(label);
    }
  };

  const f = s.filters ?? {};
  set("UK permanent floor", num(f.ukPermanentMin, 0, 10_000_000), (v) => (constraints.pay.ukPermanentMinGBPPerYear = v));
  set("pay tolerance", num(f.ukPermanentTolerancePct, 0, 50), (v) => (constraints.pay.ukPermanentTolerance = v / 100));
  set("UK contract floor", num(f.ukContractMinPerDay, 0, 100_000), (v) => (constraints.pay.ukContractMinGBPPerDay = v));
  if (f.secondMin === null || num(f.secondMin, 0, 1e9) !== undefined) set("second-market floor", f.secondMin as number | null, (v) => (constraints.pay.secondMin = v));
  if (f.fractionalMin === null || num(f.fractionalMin, 0, 1e7) !== undefined) set("fractional floor", f.fractionalMin as number | null, (v) => (constraints.pay.fractionalMin = v));
  set("hours per day", num(f.hoursPerDay, 1, 24), (v) => (constraints.pay.hoursPerDay = v));
  set("EUR rate", num(f.eurToGbp, 0.01, 10), (v) => (constraints.pay.approxToGBP.EUR = v));
  set("USD rate", num(f.usdToGbp, 0.01, 10), (v) => (constraints.pay.approxToGBP.USD = v));

  const w = s.warnings ?? {};
  constraints.warnings = { ...constraints.warnings };
  set("stale after", num(w.staleAfterDays, 1, 365), (v) => (constraints.warnings.staleAfterDays = v));
  set("applicants warning", num(w.applicantsWarnAt, 1, 100_000), (v) => (constraints.warnings.applicantsWarnAt = v));
  set("agency words", words(w.recruiterWords), (v) => (constraints.warnings.recruiterWords = v));
  set("unnamed-client words", words(w.unnamedClient), (v) => (constraints.warnings.unnamedClient = v));
  set("NDA words", words(w.nda), (v) => (constraints.warnings.nda = v));

  for (const key of ["london", "uk", "second", "remoteMaybeUk", "elsewhere", "openFromAbroad"] as const) {
    set(`places: ${key}`, words(s.markets?.[key]), (v) => (constraints.locations[key] = v));
  }
  for (const key of ["leadership", "productWords", "otherKinds", "otherKindsContext", "belowFloor", "notProductManagement", "notProductUnlessProductInTitle", "hardwareWords"] as const) {
    set(`level: ${key}`, words(s.level?.[key]), (v) => (constraints.level[key] = v));
  }

  // Target employers (B13): names keep their case for the digest. A list with
  // an empty name is ignored whole, as the board's Settings refuse it too.
  const t = s.targets;
  if (t && typeof t === "object") {
    constraints.targets = { ...(constraints.targets ?? { companies: [], packBelowLine: false, extraPlaces: 2 }) };
    const names = Array.isArray(t.companies) && t.companies.every((x) => typeof x === "string" && x.trim() !== "")
      ? t.companies.map((x) => x.trim())
      : undefined;
    set("target employers", names, (v) => (constraints.targets!.companies = v));
    set("pack target roles below the line", typeof t.packBelowLine === "boolean" ? t.packBelowLine : undefined, (v) => (constraints.targets!.packBelowLine = v));
    set("extra places for target roles", num(t.extraPlaces, 0, 5), (v) => (constraints.targets!.extraPlaces = v));
  }

  const senders = s.sources?.senders;
  if (Array.isArray(senders) && senders.length > 0 && senders.every((x) => typeof x?.source === "string" && /^[a-z0-9-]+$/.test(x.source) && typeof x.from === "string" && x.from.trim() !== "")) {
    set("senders", senders.map((x) => ({ source: x.source, from: x.from.trim() })), (v) => (sources.senders = v));
  }
  set("first-run look-back", num(s.sources?.firstRunLookbackDays, 1, 60), (v) => (sources.firstRunLookbackDays = v));

  // Sprint 6a (I1): hiring systems' mail domains, and the reply switch.
  const rs = s.sources?.replySenders;
  if (Array.isArray(rs) && rs.every((x) => typeof x?.system === "string" && /^[a-z0-9-]+$/.test(x.system) && typeof x.domain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.domain.trim()))) {
    set("hiring systems", rs.map((x) => ({ system: x.system, domain: x.domain.trim().toLowerCase() })), (v) => (sources.replySenders = v));
  }
  if (typeof s.sources?.repliesEnabled === "boolean") set("replies", s.sources.repliesEnabled, (v) => (sources.replies = { firstLookDays: 60, ...sources.replies, enabled: v }));

  set("carry-over limit", num(s.scoring?.carryOverMax, 0, 5), (v) => (carryOverMax = v));

  if (applied.length && typeof s.version === "number") constraints.settingsVersion = s.version;
  return { constraints, sources, applied, carryOverMax };
}
