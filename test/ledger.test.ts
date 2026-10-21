// H7 (Sprint 5b): the code half records its step in the day's ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";
import { findEntry, hashFile } from "../src/ledger.ts";

const root = path.join(import.meta.dirname, "..");

test("H7: a run writes its ledger entry, and status.json names it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-"));
  for (const d of ["inbox", "context"]) fs.mkdirSync(path.join(dir, d));
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "linkedin-alert-text.eml"), path.join(dir, "inbox", "a.eml"));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n");
  const env = { SETTINGS_FILE: "none", KEEP_INBOX_FILES: "1", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), CONTEXT_DIR: path.join(dir, "context") };
  const s = loadSettings(root, env);
  const { folder, judged } = await run(s, { bridge: false, today: "2026-10-17" });
  const status = JSON.parse(fs.readFileSync(path.join(folder, "status.json"), "utf8"));
  assert.equal(status.ledgerId, "2026-10-17.scout.1");
  const e = findEntry(s.dataDir, status.ledgerId)!;
  assert.equal(e.kind, "code");
  assert.equal(e.where, "pc");
  assert.equal(e.model, null);
  assert.equal(e.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.equal(e.instructions["config/constraints.json"], hashFile(path.join(root, "test", "fixtures", "config", "constraints.json")));
  assert.equal(e.counts.found, judged.length);
  assert.equal((e.inputs.emails as Record<string, number>).linkedin, 1);
  // A second run the same day gets the next number.
  const again = await run(s, { bridge: false, today: "2026-10-17" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(again.folder, "status.json"), "utf8")).ledgerId, "2026-10-17.scout.2");
  fs.rmSync(dir, { recursive: true, force: true });
});
