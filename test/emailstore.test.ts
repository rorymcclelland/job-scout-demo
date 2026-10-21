// H14 (Sprint 5b): raw emails are kept only in the private store on the PC.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { expireCopies, moveOldCopies, run } from "../src/scout.ts";
import { shareEmail } from "../src/share-email.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");

function scratch(keep = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-"));
  for (const d of ["inbox", "context"]) fs.mkdirSync(path.join(dir, d));
  fs.copyFileSync(path.join(fixtures, "linkedin-alert-text.eml"), path.join(dir, "inbox", "a.eml"));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n");
  const env: NodeJS.ProcessEnv = { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), CONTEXT_DIR: path.join(dir, "context") };
  if (keep) env.KEEP_INBOX_FILES = "1";
  return { dir, env, store: path.join(dir, "secure", "emails") };
}

test("H14: a run writes no emails folder under data/runs; the copy is in the private store", async () => {
  const { dir, env, store } = scratch();
  const { folder } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-17" });
  assert.ok(!fs.existsSync(path.join(folder, "emails")));
  assert.ok(fs.existsSync(path.join(store, "2026-10-17", "file-a.eml")));
  const report = fs.readFileSync(path.join(folder, "run.md"), "utf8");
  assert.match(report, /## Emails read/);
  assert.match(report, /npm run share-email -- 2026-10-17 <file>/);
  assert.match(report, /`file-a\.eml`/);
  assert.match(report, /kept only on this PC, in the private store, for 30 days/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H14 (N21): a file dropped in the inbox is read once, then removed from it", async () => {
  const { dir, env, store } = scratch();
  const settings = loadSettings(root, env);
  const first = await run(settings, { bridge: false, today: "2026-10-17" });
  assert.ok(first.judged.length > 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), []);
  assert.ok(fs.existsSync(path.join(store, "2026-10-17", "file-a.eml")));
  const second = await run(settings, { bridge: false, today: "2026-10-18" });
  assert.equal(second.judged.length, 0); // not read again
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H14: when the Bridge read fails, inbox files stay for the next run", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, { ...env, BRIDGE_USER: "x", BRIDGE_PASSWORD: "y", BRIDGE_PORT: "1", BRIDGE_SECURITY: "none" });
  await run(settings, { bridge: true, today: "2026-10-17" });
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), ["a.eml"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H14: copies older than 30 days are deleted, newer ones kept", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  for (const d of ["2026-09-16", "2026-09-17", "2026-10-16", "notes"]) fs.mkdirSync(path.join(store, d));
  assert.equal(expireCopies(store, "2026-10-17", 30), 1);
  assert.deepEqual(fs.readdirSync(store).sort(), ["2026-09-17", "2026-10-16", "notes"]);
  fs.rmSync(store, { recursive: true, force: true });
});

test("H14: the one-off move leaves no raw email in the Job Scout folder", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  fs.mkdirSync(path.join(data, "runs", "2026-10-14", "emails"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "2026-10-14", "emails", "bridge-1.eml"), "x");
  fs.writeFileSync(path.join(data, "runs", "2026-10-14", "run.md"), "kept");
  assert.equal(moveOldCopies(data, store), 1);
  assert.ok(!fs.existsSync(path.join(data, "runs", "2026-10-14", "emails")));
  assert.ok(fs.existsSync(path.join(data, "runs", "2026-10-14", "run.md")));
  assert.equal(fs.readFileSync(path.join(store, "2026-10-14", "bridge-1.eml"), "utf8"), "x");
  assert.equal(moveOldCopies(data, store), 0); // only once
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test("H14: share-email copies one chosen email for a parser fix, and nothing else", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "data-"));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  fs.mkdirSync(path.join(store, "2026-10-17"));
  fs.writeFileSync(path.join(store, "2026-10-17", "bridge-9.eml"), "mail");
  const to = shareEmail(store, data, "2026-10-17", "bridge-9.eml");
  assert.equal(fs.readFileSync(to, "utf8"), "mail");
  assert.throws(() => shareEmail(store, data, "2026-10-17", "../../secret.eml"), /file name/);
  assert.throws(() => shareEmail(store, data, "17 Oct", "bridge-9.eml"), /date/);
  assert.throws(() => shareEmail(store, data, "2026-10-17", "bridge-8.eml"), /No email/);
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});
