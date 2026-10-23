// E16 (Sprint 10): how fresh each pack is.
//
// Every pack built from 0.15.0 records in pack.json what it was built from
// (tools/staleness.py record): the CV and letter bases, the career notes, the
// highlight and form-answer banks, by path inside Professional development and
// a hash of their contents, plus the settings version and the build date. Each
// morning the mail read compares those with the files as they are now and
// writes staleness.json in the run folder; part 2 puts the result on Draft
// cards only (SCOUT.md). This reads files and hashes them; it never changes a
// pack, and nothing but hashes and reasons leaves the PC.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Level = "fresh" | "probably" | "stale";

export interface PackStaleness {
  pack: string; // "Professional development\\[<subfolder>\\]<folder>"
  folder: string; // the pack's own folder name, which cards are matched by (BUG-8)
  level: Level;
  reasons: string[];
  built: string | null;
}

export interface StalenessReport {
  checked: string;
  staleAfterDays: number;
  settingsVersion: number | null;
  packs: PackStaleness[];
  problems: string[];
}

interface FileRef { path?: unknown; hash?: unknown; kind?: unknown }

const MAX_PACKS = 400;
// What a changed source means for the pack (E16 refinement).
const SOURCES: Record<string, { level: Level; reason: string }> = {
  cvBase: { level: "stale", reason: "CV master changed since build" },
  letterBase: { level: "probably", reason: "letter base changed since build" },
  careerNotes: { level: "probably", reason: "career notes changed" },
  highlights: { level: "probably", reason: "highlight bank changed" },
  formAnswers: { level: "probably", reason: "form-answer bank changed" },
};

export const hashBytes = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

export function hashFile(file: string): string {
  return hashBytes(fs.readFileSync(file));
}

/** The Markdown files under a folder, by forward-slash relative path; the same as staleness.py. */
export function hashFolder(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) lines.push(`${path.relative(dir, full).split(path.sep).join("/")}\t${hashFile(full)}\n`);
    }
  };
  walk(dir);
  return hashBytes(lines.sort().join(""));
}

/** A path inside the root, or null when it would lead out of it. */
function inside(root: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel.trim()) return null;
  const parts = rel.trim().split(/[\\/]+/).filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..") || /^[A-Za-z]:/.test(rel.trim()) || /^[\\/]/.test(rel.trim())) return null;
  // Links are resolved first, so a link inside the folder cannot lead out of it (Sprint 10 check).
  let full: string, base: string;
  try { full = fs.realpathSync(path.resolve(root, ...parts)); base = fs.realpathSync(root); } catch { return path.resolve(root, ...parts); }
  const r = path.relative(base, full);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? full : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}

export function checkPack(folder: string, root: string, opts: { today: string; staleAfterDays: number; settingsVersion: number | null }): PackStaleness | { problem: string } {
  const name = "Professional development\\" + path.relative(root, folder).split(path.sep).join("\\");
  const base = path.basename(folder);
  let pack: { builtFrom?: { built?: unknown; settingsVersion?: unknown; files?: Record<string, FileRef> } };
  try {
    pack = JSON.parse(fs.readFileSync(path.join(folder, "pack.json"), "utf8"));
  } catch {
    return { problem: `${name}: pack.json could not be read as JSON, so it was skipped` };
  }
  const bf = pack && typeof pack === "object" ? pack.builtFrom : undefined;
  if (!bf || typeof bf !== "object") return { pack: name, folder: base, level: "probably", reasons: ["built before staleness was recorded"], built: null };
  if (!bf.files || typeof bf.files !== "object" || !Object.keys(SOURCES).some((k) => bf.files?.[k])) {
    return { pack: name, folder: base, level: "probably", reasons: ["no sources recorded for this pack"], built: null };
  }
  const reasons: string[] = [];
  let level: Level = "fresh";
  const raise = (l: Level) => { if (l === "stale" || (l === "probably" && level === "fresh")) level = l; };
  for (const [key, how] of Object.entries(SOURCES)) {
    const ref = bf.files?.[key];
    if (!ref) continue;
    const full = inside(root, ref.path);
    if (!full) { reasons.push(`${key} path is not inside Professional development; not followed`); raise("probably"); continue; }
    let now: string | null = null;
    try { now = ref.kind === "folder" ? hashFolder(full) : hashFile(full); } catch { now = null; }
    if (now === null) { reasons.push(`${how.reason.split(" changed")[0]} no longer found`); raise(how.level); }
    else if (now !== ref.hash) { reasons.push(how.reason); raise(how.level); }
  }
  if (typeof bf.settingsVersion === "number" && opts.settingsVersion !== null && bf.settingsVersion !== opts.settingsVersion) {
    reasons.push("settings changed"); raise("probably");
  }
  const built = typeof bf.built === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bf.built) ? bf.built : null;
  if (built) {
    const age = daysBetween(built, opts.today);
    if (age > opts.staleAfterDays) { reasons.push(`built ${age} days ago`); raise("probably"); }
  }
  return { pack: name, folder: base, level, reasons, built };
}

/** Folders a pack may be in: directly inside Professional development, or one folder down
 *  (packs often sit in a folder of applications; BUG-8, found at the Sprint 10 review). */
function packFolders(root: string): string[] {
  const out: string[] = [];
  const dirs = (d: string) => {
    try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".") && !e.name.startsWith("_")); } catch { return []; }
  };
  for (const e of dirs(root)) {
    const folder = path.join(root, e.name);
    if (fs.existsSync(path.join(folder, "pack.json"))) { out.push(folder); continue; }
    for (const f of dirs(folder)) if (fs.existsSync(path.join(folder, f.name, "pack.json"))) out.push(path.join(folder, f.name));
  }
  return out;
}

/** Every pack folder in Professional development (two levels), checked. */
export function checkAll(root: string, opts: { today: string; staleAfterDays: number; settingsVersion: number | null }): StalenessReport {
  const report: StalenessReport = { checked: opts.today, staleAfterDays: opts.staleAfterDays, settingsVersion: opts.settingsVersion, packs: [], problems: [] };
  if (!fs.existsSync(root)) { report.problems.push("Professional development could not be read, so no packs were checked"); return report; }
  for (const folder of packFolders(root)) {
    if (report.packs.length >= MAX_PACKS) { report.problems.push(`more than ${MAX_PACKS} packs; the rest were not checked`); break; }
    const r = checkPack(folder, root, opts);
    if ("problem" in r) report.problems.push(r.problem); else report.packs.push(r);
  }
  return report;
}

/** settings.json's staleAfterDays (7 unless the board says otherwise). */
export function staleAfterDays(configDir: string): number {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
    const n = s?.packs?.staleAfterDays;
    return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 7;
  } catch { return 7; }
}
