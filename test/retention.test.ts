// H10 (Sprint 7): adverts, specs and reply summaries go after 90 days, except
// for roles the owner applied for; nothing goes without a keep list.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cutoffDate, pruneRuns, readKeep } from "../src/retention.ts";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";

const root = path.join(import.meta.dirname, "..");
const TODAY = "2027-01-20";

function day(dataDir: string, date: string, ids: string[], replies: Array<{ id: string; cardIds: string[] }> = []) {
  const f = path.join(dataDir, "runs", date);
  for (const sub of ["adverts", "specs", "replies"]) fs.mkdirSync(path.join(f, sub), { recursive: true });
  for (const id of ids) {
    fs.writeFileSync(path.join(f, "adverts", `${id}.md`), "Hiring manager: Jane Example");
    fs.writeFileSync(path.join(f, "specs", `${id}.json`), "{}");
  }
  fs.writeFileSync(path.join(f, "specs", "summary.json"), '{"ok":2}');
  fs.writeFileSync(path.join(f, "digest.md"), "# Digest");
  fs.writeFileSync(path.join(f, "scores.json"), "[]");
  fs.writeFileSync(path.join(f, "replies", "found.json"), '{"replies":[]}');
  fs.writeFileSync(path.join(f, "replies", "summary.json"), JSON.stringify({ date, replies }));
  return f;
}

function scratch(keep: object | null | string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-ret-"));
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  if (keep !== null) fs.writeFileSync(path.join(data, "keep.json"), typeof keep === "string" ? keep : JSON.stringify(keep));
  return { dir, data };
}

const KEEP = { written: TODAY, roles: ["linkedin:111"], cards: ["scout-acme-head-of-product"] }; // ids as on the card; files use linkedin-111

test("H10 cutoff: 90 days before 20 January 2027 is 22 October 2026", () => {
  assert.equal(cutoffDate(TODAY, 90), "2026-10-22");
});

test("H10 1: a 91-day-old run folder loses its adverts, specs and replies; its digest and scores stay", () => {
  const { dir, data } = scratch(KEEP);
  const f = day(data, "2026-10-21", ["linkedin-222"], [{ id: "r-1", cardIds: ["scout-other"] }]);
  const r = pruneRuns(data, TODAY, 90);
  assert.equal(r.ran, true);
  assert.ok(!fs.existsSync(path.join(f, "adverts")));
  assert.ok(!fs.existsSync(path.join(f, "specs", "linkedin-222.json")));
  assert.ok(!fs.existsSync(path.join(f, "replies", "summary.json")));
  for (const stays of ["digest.md", "scores.json", "replies/found.json", "specs/summary.json"]) assert.ok(fs.existsSync(path.join(f, stays)), stays);
  assert.deepEqual(r.folders, ["2026-10-21"]);
  assert.match(r.note, /3 files from 1 run folder before 2026-10-22 were deleted/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H10 2: an 89-day-old folder is untouched", () => {
  const { dir, data } = scratch(KEEP);
  const f = day(data, "2026-10-23", ["linkedin-222"], [{ id: "r-1", cardIds: [] }]);
  const r = pruneRuns(data, TODAY, 90);
  assert.ok(fs.existsSync(path.join(f, "adverts", "linkedin-222.md")));
  assert.ok(fs.existsSync(path.join(f, "replies", "summary.json")));
  assert.equal(r.deleted.length, 0);
  assert.match(r.note, /nothing was due for deletion/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H10 3: a role on keep.json keeps its advert and spec at any age, and a kept card keeps its replies", () => {
  const { dir, data } = scratch(KEEP);
  const f = day(data, "2025-01-01", ["linkedin-111", "linkedin-222"], [
    { id: "r-1", cardIds: ["scout-acme-head-of-product"] },
    { id: "r-2", cardIds: ["scout-other"] },
  ]);
  const r = pruneRuns(data, TODAY, 90);
  assert.ok(fs.existsSync(path.join(f, "adverts", "linkedin-111.md")));
  assert.ok(fs.existsSync(path.join(f, "specs", "linkedin-111.json")));
  assert.ok(!fs.existsSync(path.join(f, "adverts", "linkedin-222.md")));
  const s = JSON.parse(fs.readFileSync(path.join(f, "replies", "summary.json"), "utf8"));
  assert.deepEqual(s.replies.map((x: { id: string }) => x.id), ["r-1"]);
  assert.deepEqual(s.retained, { on: TODAY, removed: 1 });
  assert.equal(r.repliesKept, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H10 4: no keep.json, or a broken one, deletes nothing and says why (fail safe)", () => {
  for (const keep of [null, "{not json", JSON.stringify({ written: TODAY })]) {
    const { dir, data } = scratch(keep);
    const f = day(data, "2025-01-01", ["linkedin-222"]);
    const r = pruneRuns(data, TODAY, 90);
    assert.equal(r.ran, false);
    assert.ok(fs.existsSync(path.join(f, "adverts", "linkedin-222.md")));
    assert.match(r.note, /nothing old was deleted/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(readKeep("/no/such/keep.json").keep, null);
});

test("H10: deletion stays inside data\\runs and ignores folders that are not dates", () => {
  const { dir, data } = scratch(KEEP);
  fs.mkdirSync(path.join(data, "runs", "notes", "adverts"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "notes", "adverts", "x.md"), "mine");
  fs.writeFileSync(path.join(data, "watchlist.json"), "{}");
  pruneRuns(data, TODAY, 90);
  assert.ok(fs.existsSync(path.join(data, "runs", "notes", "adverts", "x.md")));
  assert.ok(fs.existsSync(path.join(data, "watchlist.json")));
  assert.ok(fs.existsSync(path.join(data, "keep.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H10: the mail read tidies old folders and says so in run.md", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-ret-run-"));
  for (const d of ["inbox", "context"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n");
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "keep.json"), JSON.stringify(KEEP));
  const old = day(data, "2026-09-01", ["linkedin-222"]);
  const env: NodeJS.ProcessEnv = { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: data, EML_FOLDER: path.join(dir, "inbox"), CONTEXT_DIR: path.join(dir, "context") };
  const settings = loadSettings(root, env);
  assert.equal(settings.runDays, 90);
  const { folder } = await run(settings, { bridge: false, today: TODAY });
  assert.ok(!fs.existsSync(path.join(old, "adverts")));
  assert.match(fs.readFileSync(path.join(folder, "run.md"), "utf8"), /kept for 90 days, except for roles you applied for/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H10 (review fix): a hiring system's reply is kept through part 2's match; an empty or stale keep list deletes nothing", () => {
  const { dir, data } = scratch(KEEP);
  const f = day(data, "2025-01-01", [], [{ id: "r-gh", cardIds: [] }, { id: "r-other", cardIds: [] }]);
  fs.writeFileSync(path.join(f, "replies", "matched.json"), JSON.stringify({ items: [{ replyId: "r-gh", cardId: "scout-acme-head-of-product" }, { replyId: "r-other", cardId: null }] }));
  pruneRuns(data, TODAY, 90);
  const s = JSON.parse(fs.readFileSync(path.join(f, "replies", "summary.json"), "utf8"));
  assert.deepEqual(s.replies.map((x: { id: string }) => x.id), ["r-gh"]);
  // With no record of the match, an unlinked reply is kept (fail safe).
  const g = day(data, "2025-01-02", [], [{ id: "r-x", cardIds: [] }]);
  pruneRuns(data, TODAY, 90);
  assert.ok(fs.existsSync(path.join(g, "replies", "summary.json")));
  fs.rmSync(dir, { recursive: true, force: true });
  for (const keep of [{ written: TODAY, roles: [], cards: [] }, { ...KEEP, written: "2027-01-01" }]) {
    const t = scratch(keep);
    const h = day(t.data, "2025-01-01", ["linkedin-222"]);
    const r = pruneRuns(t.data, TODAY, 90);
    assert.ok(fs.existsSync(path.join(h, "adverts", "linkedin-222.md")));
    assert.match(r.note, /empty|more than a week ago/);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("H15 (Sprint 8): a run on request, data\\runs\\<date>-req-<n>, is pruned by its date like any run folder", () => {
  const { dir, data } = scratch(KEEP);
  const old = day(data, "2026-10-21-req-1", ["request-acme-head-of-product"]);
  const recent = day(data, "2026-10-23-req-2", ["request-beta-staff-pm"]);
  const r = pruneRuns(data, TODAY, 90);
  assert.ok(!fs.existsSync(path.join(old, "adverts")));
  assert.ok(fs.existsSync(path.join(recent, "adverts", "request-beta-staff-pm.md")));
  assert.deepEqual(r.folders, ["2026-10-21-req-1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
