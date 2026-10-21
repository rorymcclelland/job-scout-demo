// De-duplication (backlog item B6): against the application tracker, against
// roles seen in earlier runs, and within today's run.

import type { Role } from "./role.ts";

export interface TrackerRow {
  company: string;
  role: string;
  status: string;
}

/** Read the table in _context/applications.md: | Company | Role | Status | ... */
export function readTracker(markdown: string): TrackerRow[] {
  const rows: TrackerRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0] === "Company" || /^-+$/.test(cells[0].replace(/[: ]/g, "") || "-")) continue;
    rows.push({ company: cells[0], role: cells[1], status: cells[2] });
  }
  return rows;
}

const FILLER = new Set(["the", "a", "an", "of", "and", "for", "at", "in", "ltd", "limited", "plc", "inc", "gmbh", "client", "not", "named", "formerly", "via"]);

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, (m) => ` ${m} `)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
}

/** Share of the shorter title's words that also appear in the other. */
function overlap(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

function sameCompany(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return false;
  // "Ridge Search" matches "Ridge Search (client not named)"; "Harbourline" matches "Harbourline (formerly Quayside)".
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}

export function onTracker(role: Role, tracker: TrackerRow[]): TrackerRow | null {
  for (const row of tracker) {
    if (sameCompany(role.company, row.company) && overlap(role.title, row.role) >= 0.6) return row;
  }
  return null;
}

export interface SeenEntry {
  firstSeen: string; // YYYY-MM-DD of the run that first saw it
  title: string;
  company: string;
}

export type SeenStore = Record<string, SeenEntry>;

/**
 * Was this role seen in an EARLIER run? Matching the same id, or the same
 * company and title under a new id (a repost). Roles first seen today do not
 * count, so running the scout twice in a morning gives the same answer.
 */
export function seenBefore(role: Role, seen: SeenStore, today: string): { entry: SeenEntry; repost: boolean } | null {
  const direct = seen[role.id];
  if (direct && direct.firstSeen < today) return { entry: direct, repost: false };
  if (!role.company || !role.title) return null;
  for (const [id, e] of Object.entries(seen)) {
    if (id === role.id || e.firstSeen >= today) continue;
    if (sameCompany(role.company, e.company) && overlap(role.title, e.title) >= 0.9) return { entry: e, repost: true };
  }
  return null;
}

/** Sources run by the employer itself: their record wins over a job board's copy (B12). */
const EMPLOYER_SOURCES = new Set(["google", "microsoft"]);

/**
 * Merge roles that appear in two alerts on the same day, keeping the fuller
 * record. The same job from two sources (Google's own alert and a LinkedIn
 * alert, say) has two ids, so it is matched on company and title too; the
 * employer's own record is kept, with a note of where else it appeared.
 */
export function mergeDuplicates(roles: Role[]): Role[] {
  const byId = new Map<string, Role>();
  for (const r of roles) {
    const prev = byId.get(r.id);
    if (!prev || (prev.parse === "partial" && r.parse === "full")) byId.set(r.id, r);
  }
  const kept: Role[] = [];
  for (const r of byId.values()) {
    const at = kept.findIndex((k) => k.source !== r.source && k.company && r.company && sameCompany(k.company, r.company) && overlap(k.title, r.title) >= 0.9 && overlap(r.title, k.title) >= 0.9);
    if (at < 0) {
      kept.push(r);
      continue;
    }
    const other = kept[at];
    const [keep, drop] = EMPLOYER_SOURCES.has(r.source) && !EMPLOYER_SOURCES.has(other.source) ? [r, other] : [other, r];
    kept[at] = { ...keep, notes: [...keep.notes, `Also in a ${drop.source} alert (${drop.id}).`] };
  }
  return kept;
}
