// The audit trail (backlog H7, Sprint 5b): one ledger file per day,
// data/ledger/<date>.json, with an entry for every step of every run that day.
// The code half writes its own entry here; each AI step adds its entry with
// tools/ledger.py, and scores, packs and cards carry their entry's id, so any
// output can be traced to the model, the instructions and the settings that
// produced it.
//
// Hashes are SHA-256 of the file with line endings made \n, first 16 hex
// characters, so a file hashes the same on the PC and in Claude's workspace
// (tools/ledger.py does the same).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LedgerEntry {
  id: string; // <date>.<agent>.<n>, e.g. 2026-10-17.scout.1
  agent: string; // scout | orchestrator | writer | reviewer | weekly | ...
  kind: "code" | "ai";
  where: "pc" | "cloud";
  model: string | null; // null for code
  version: string | null; // the code's version, for code
  at: string; // ISO time the entry was written
  instructions: Record<string, string>; // file name -> hash (procedures for AI, config for code)
  settingsVersion: number | null;
  inputs: Record<string, unknown>;
  counts: Record<string, number>;
}

export interface Ledger {
  date: string;
  entries: LedgerEntry[];
}

export function hashFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file).toString("utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function ledgerPath(dataDir: string, date: string): string {
  return path.join(dataDir, "ledger", `${date}.json`);
}

export function readLedger(dataDir: string, date: string): Ledger {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath(dataDir, date), "utf8")) as Ledger;
    if (l && Array.isArray(l.entries)) return l;
  } catch { /* none yet */ }
  return { date, entries: [] };
}

/** Add an entry, numbering it after any earlier entries by the same agent that day. Returns its id. */
export function appendEntry(dataDir: string, date: string, entry: Omit<LedgerEntry, "id">): string {
  const ledger = readLedger(dataDir, date);
  const n = ledger.entries.filter((e) => e.agent === entry.agent).length + 1;
  const id = `${date}.${entry.agent}.${n}`;
  ledger.entries.push({ id, ...entry });
  fs.mkdirSync(path.dirname(ledgerPath(dataDir, date)), { recursive: true });
  fs.writeFileSync(ledgerPath(dataDir, date), JSON.stringify(ledger, null, 2));
  return id;
}

export function findEntry(dataDir: string, id: string): LedgerEntry | null {
  const m = /^(\d{4}-\d{2}-\d{2})\./.exec(id);
  if (!m) return null;
  return readLedger(dataDir, m[1]).entries.find((e) => e.id === id) ?? null;
}
