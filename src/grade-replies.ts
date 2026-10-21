// npm run grade-replies — the owner grades the reply reader (backlog I2, Q6).
//
//   npm run grade-replies -- --make    writes a sheet of recent replies to the
//                                      private store, with the model's type for
//                                      each, for him to mark the right type;
//   npm run grade-replies              scores the marked sheet and writes
//                                      data/replies-grade.json.
//
// The sheet holds subjects, so it lives in the private store
// (%LOCALAPPDATA%\JobScout\grading), never in a folder the cloud can read. The
// result holds counts only. Bar (the owner, 17 Oct 2026): at least 10 marked, 9 in
// 10 types right, and no rejection read as an invitation or the reverse.
// Until the model passes, every move is a suggestion the user confirms (Q2).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { parseEmail } from "./mime.ts";
import { REPLY_TYPES } from "./reader/reply.ts";
import type { RepliesSummary } from "./read-replies.ts";

export const sheetPath = (s: Settings) => path.join(path.dirname(s.emailStore), "grading", "replies.csv");

const csv = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

export function makeSheet(s: Settings, max = 25): { file: string; rows: number } {
  const runs = path.join(s.dataDir, "runs");
  const rows: string[] = [];
  const days = fs.existsSync(runs) ? fs.readdirSync(runs).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const seen = new Set<string>();
  for (const day of days) {
    const f = path.join(runs, day, "replies", "summary.json");
    const found = path.join(runs, day, "replies", "found.json");
    if (!fs.existsSync(f) || !fs.existsSync(found)) continue;
    const sum = JSON.parse(fs.readFileSync(f, "utf8")) as RepliesSummary;
    const files = new Map((JSON.parse(fs.readFileSync(found, "utf8")).replies as Array<{ id: string; file: string; day: string }>).map((r) => [r.id, r]));
    for (const r of sum.replies) {
      if (!r.read || seen.has(r.id) || rows.length >= max) continue;
      seen.add(r.id);
      const where = files.get(r.id);
      const src = where ? path.join(s.emailStore, where.day, where.file) : "";
      const subject = src && fs.existsSync(src) ? parseEmail(fs.readFileSync(src).toString("latin1")).subject : "";
      rows.push([r.id, r.date.slice(0, 10), r.domain, subject, r.read.type, ""].map(csv).join(","));
    }
  }
  const file = sheetPath(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [`id,date,from,subject,model type,your type (${REPLY_TYPES.join(" / ")})`, ...rows].join("\r\n") + "\r\n");
  return { file, rows: rows.length };
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === "," || ch === ";") { cells.push(cur); cur = ""; } // Excel in some locales saves with ";"
      else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

export interface Grade { date: string; model: string; right: number; of: number; confusions: number; passed: boolean; wrong: Array<{ model: string; yours: string }> }

export function scoreSheet(s: Settings, today: string): Grade | { problem: string } {
  const file = sheetPath(s);
  if (!fs.existsSync(file)) return { problem: `No sheet at ${file}. Run: npm run grade-replies -- --make` };
  const rows = parseCsv(fs.readFileSync(file, "utf8")).slice(1);
  const marked = rows.filter((r) => (r[5] ?? "").trim() !== "").map((r) => ({ model: (r[4] ?? "").trim().toLowerCase(), yours: (r[5] ?? "").trim().toLowerCase() }));
  const bad = marked.filter((m) => !(REPLY_TYPES as readonly string[]).includes(m.yours));
  if (bad.length) return { problem: `${bad.length} row${bad.length === 1 ? "" : "s"} marked with a type not in the list (${REPLY_TYPES.join(", ")}): ${[...new Set(bad.map((b) => b.yours))].join(", ")}.` };
  const right = marked.filter((m) => m.model === m.yours).length;
  const confusions = marked.filter((m) => (m.model === "rejection" && m.yours === "invitation") || (m.model === "invitation" && m.yours === "rejection")).length;
  const of = marked.length;
  const passed = of >= 10 && right / of >= 0.9 && confusions === 0;
  const g: Grade = { date: today, model: s.reader.model, right, of, confusions, passed, wrong: marked.filter((m) => m.model !== m.yours) };
  fs.writeFileSync(path.join(s.dataDir, "replies-grade.json"), JSON.stringify(g, null, 2));
  return g;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const s = loadSettings(root);
  if (process.argv.includes("--make")) {
    const { file, rows } = makeSheet(s);
    console.log(`Grading sheet: ${rows} replies, in ${file}`);
    console.log(`Open it, put the right type in the last column for each (${REPLY_TYPES.join(", ")}), save it as CSV, then run: npm run grade-replies`);
  } else {
    const d = new Date();
    const g = scoreSheet(s, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    if ("problem" in g) { console.log(g.problem); process.exitCode = 1; }
    else console.log(`${g.right} of ${g.of} right, ${g.confusions} rejection/invitation mix-up${g.confusions === 1 ? "" : "s"}: ${g.passed ? "PASSED. From tomorrow the scout may move cards itself (with Undo); the first look back stays as suggestions." : "not passed yet (bar: at least 10 marked, 9 in 10 right, no mix-ups). Moves stay as suggestions."}`);
  }
}
