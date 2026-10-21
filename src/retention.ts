// Retention (backlog H10, Sprint 7): keep other people's words no longer than
// the scout needs them.
//
// Run folders hold the adverts the reader fetched (adverts\), the specs it
// wrote from them (specs\) and the reply summaries (replies\summary.json).
// Adverts name recruiters and hiring managers; reply summaries quote a short
// ask. After `days` (90 by default) these are deleted, except for the roles
// The owner applied for, which part 2 lists in data\keep.json each morning.
//
// What stays: digests, scores, candidates, ledgers, found.json (sender
// domains and hashes only) and specs\summary.json (counts). They hold no
// third-party text beyond company names and job titles.
//
// Fail safe: with no keep.json, or one that cannot be read, nothing is
// deleted and the run says why. Deletion never leaves data\runs\.

import fs from "node:fs";
import path from "node:path";

export interface KeepList {
  written: string | null;
  /** Role ids (the card's scoutId, e.g. linkedin-4479124976): their adverts and specs are kept. */
  roles: string[];
  /** Board card ids: replies matched to these cards are kept. */
  cards: string[];
}

export interface RetentionResult {
  ran: boolean;
  days: number;
  /** Run folders touched. */
  folders: string[];
  /** Files deleted, as paths relative to data\runs. */
  deleted: string[];
  /** Replies kept in a summary because their card is on the keep list. */
  repliesKept: number;
  note: string;
}

export function readKeep(file: string): { keep: KeepList | null; problem?: string } {
  if (!fs.existsSync(file)) return { keep: null, problem: "No keep list yet (data\\keep.json, written by part 2), so nothing old was deleted from the run folders." };
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<KeepList>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : null);
    const roles = strs(j.roles);
    const cards = strs(j.cards);
    if (!roles || !cards) return { keep: null, problem: "The keep list (data\\keep.json) has no roles or cards list, so nothing old was deleted from the run folders." };
    // An empty list is far more likely a failed board export than no applications at all.
    if (roles.length === 0 && cards.length === 0) return { keep: null, problem: "The keep list (data\\keep.json) is empty, which usually means the board could not be read, so nothing old was deleted from the run folders." };
    return { keep: { written: typeof j.written === "string" ? j.written : null, roles, cards } };
  } catch (err) {
    return { keep: null, problem: `The keep list (data\\keep.json) could not be read (${(err as Error).message}), so nothing old was deleted from the run folders.` };
  }
}

/** The day `days` before `today` (YYYY-MM-DD). Folders dated before it are old. */
export function cutoffDate(today: string, days: number): string {
  const t = new Date(today + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

const stem = (f: string) => f.replace(/\.(md|json|txt|html)$/i, "");

export function pruneRuns(dataDir: string, today: string, days: number): RetentionResult {
  const res: RetentionResult = { ran: false, days, folders: [], deleted: [], repliesKept: 0, note: "" };
  const runs = path.join(dataDir, "runs");
  const { keep, problem } = readKeep(path.join(dataDir, "keep.json"));
  if (!keep) {
    res.note = problem ?? "";
    return res;
  }
  // A keep list part 2 has stopped refreshing may miss a recent application.
  if (!keep.written || keep.written < cutoffDate(today, 7)) {
    res.note = `The keep list (data\\keep.json) was last written ${keep.written ?? "on an unknown date"}, more than a week ago, so nothing old was deleted from the run folders. Part 2 writes it each morning.`;
    return res;
  }
  res.ran = true;
  if (!fs.existsSync(runs)) {
    res.note = `Run folders are kept for ${days} days; none are older.`;
    return res;
  }
  const limit = cutoffDate(today, days);
  // Adverts and specs are saved under the role id made safe for a file name
  // (linkedin:123 becomes linkedin-123), as src/read-adverts.ts does.
  const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "-");
  const roles = new Set(keep.roles.map(safe));
  const cards = new Set(keep.cards);
  const del = (full: string) => {
    fs.rmSync(full, { force: true });
    res.deleted.push(path.relative(runs, full).split(path.sep).join("\\"));
  };
  for (const day of fs.readdirSync(runs).sort()) {
    // H15 (Sprint 8): a run on request, <date>-req-<n>, is judged by its date like any run folder.
    const m = /^(\d{4}-\d{2}-\d{2})(?:-req-\d+)?$/.exec(day);
    if (!m || m[1] >= limit) continue;
    const folder = path.join(runs, day);
    if (!fs.statSync(folder).isDirectory()) continue;
    const before = res.deleted.length;
    for (const sub of ["adverts", "specs"]) {
      const dir = path.join(folder, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (sub === "specs" && f === "summary.json") continue;
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        if (!roles.has(stem(f))) del(full);
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    const summary = path.join(folder, "replies", "summary.json");
    if (fs.existsSync(summary)) {
      try {
        const s = JSON.parse(fs.readFileSync(summary, "utf8")) as { replies?: Array<{ id?: string; cardIds?: string[] }>; retained?: unknown };
        const all = Array.isArray(s.replies) ? s.replies : [];
        // Replies from hiring systems carry no card until part 2 matches them, in replies\matched.json.
        const matchedFile = path.join(folder, "replies", "matched.json");
        let matched: Map<string, string | null> | null = null;
        try {
          const m = JSON.parse(fs.readFileSync(matchedFile, "utf8")) as { items?: Array<{ replyId?: string; cardId?: string | null }> };
          matched = new Map((m.items ?? []).filter((x) => x.replyId).map((x) => [x.replyId!, x.cardId ?? null]));
        } catch { /* no match file: fail safe below */ }
        const kept = all.filter((r) => {
          if ((r.cardIds ?? []).some((c) => cards.has(c))) return true;
          const card = r.id ? matched?.get(r.id) : undefined;
          if (card) return cards.has(card);
          // Not matched to any card: kept only when there is no record of the match to judge by.
          return matched === null && (r.cardIds ?? []).length === 0;
        });
        if (kept.length === 0) del(summary);
        else if (kept.length < all.length) {
          fs.writeFileSync(summary, JSON.stringify({ ...s, replies: kept, retained: { on: today, removed: all.length - kept.length } }, null, 2));
          res.deleted.push(path.relative(runs, summary).split(path.sep).join("\\") + ` (${all.length - kept.length} of ${all.length} replies)`);
        }
        res.repliesKept += kept.length;
      } catch {
        del(summary); // an unreadable summary is of no use to anyone
      }
    }
    if (res.deleted.length > before) res.folders.push(day);
  }
  const files = res.deleted.length;
  res.note = files
    ? `Adverts, specs and reply summaries are kept for ${days} days, except for roles you applied for: ${files} file${files === 1 ? "" : "s"} from ${res.folders.length} run folder${res.folders.length === 1 ? "" : "s"} before ${limit} ${files === 1 ? "was" : "were"} deleted.`
    : `Adverts, specs and reply summaries are kept for ${days} days, except for roles you applied for; nothing was due for deletion.`;
  return res;
}
