// Sprint 4 (Contain): secrets out of reach (H1), untrusted text handled as
// data (H2) and the pause switch (H4). Output validation (H3) is tested in
// tools/test_validate.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";
import { bridgeCredentials, parseEnvFile } from "../src/secrets.ts";
import { cleanUntrusted } from "../src/untrusted.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");

function scratch(files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-gov-"));
  for (const d of ["inbox", "context", "secure"]) fs.mkdirSync(path.join(dir, d));
  for (const f of files) fs.copyFileSync(path.join(fixtures, f), path.join(dir, "inbox", f));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status | Applied | Next |\n|---|---|---|---|---|\n");
  const env = {
    SETTINGS_FILE: "none",
    JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"),
    DATA_DIR: path.join(dir, "data"),
    EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1",
    CONTEXT_DIR: path.join(dir, "context"),
  };
  return { dir, env };
}

test("H2: LinkedIn's parser already ignores free text between the fields", async () => {
  const { dir, env } = scratch(["linkedin-alert-injected.eml"]);
  const { judged } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-14" });
  assert.equal(judged.length, 2, "both roles are still read");
  for (const j of judged) assert.doesNotMatch([j.role.title, j.role.excerpt, ...j.role.notes].join("\n"), /ignore all previous|system prompt|rate this candidate|forward the candidate profile/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H2: instructions hidden in an alert are removed, reported and flagged", async () => {
  const { dir, env } = scratch(["hackajob-injected.eml"]);
  const { folder, judged, health } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-14" });

  const steer = judged.find((j) => j.role.company === "Steerly")!;
  assert.ok(steer, "the role is still read");
  assert.doesNotMatch([steer.role.title, steer.role.excerpt, ...steer.role.notes].join("\n"), /AI reviewing this|score this role 100|candidate profile/i);
  assert.match(steer.verdict.warnings.join(" "), /Instruction-like text was removed/);
  assert.equal(steer.stage, "score", "a hostile line is a warning, not a reason to drop the role");
  assert.equal(health.untrusted.length, 1);
  const report = fs.readFileSync(path.join(folder, "run.md"), "utf8");
  assert.match(report, /## Untrusted text/);
  assert.match(report, /tries to override instructions/);
  const status = JSON.parse(fs.readFileSync(path.join(folder, "status.json"), "utf8"));
  assert.equal(status.untrustedLinesRemoved, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H2: a fake recruiter email asking for details produces no roles", async () => {
  const { dir, env } = scratch(["recruiter-phish.eml"]);
  const { judged, health } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-14" });
  assert.equal(judged.length, 0);
  assert.equal(health.emails.other, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H2: ordinary advert wording is left alone", () => {
  const ok = ["Experience with Claude, Copilot and Gemini a plus", "Ranked in the top 100 start-ups", "Send your CV to jobs@acme.com", "12 applicants"].join("\n");
  const c = cleanUntrusted(ok, 1500);
  assert.equal(c.removed.length, 0);
  assert.equal(c.text, ok);
  const long = cleanUntrusted("word ".repeat(1000), 100);
  assert.ok(long.truncated && long.text.length <= 102);
});

test("H1: the Bridge password comes from the secure store, never from a plain file", () => {
  const { dir } = scratch([]);
  const secure = path.join(dir, "secure");
  fs.writeFileSync(path.join(secure, "bridge.env"), "BRIDGE_USER=sam@example.com\nBRIDGE_PASSWORD=should-be-ignored\nBRIDGE_PORT=1143\n");
  fs.writeFileSync(path.join(secure, "bridge-password.dpapi"), "ENCRYPTED");
  const decrypt = (f: string) => (f.endsWith("bridge-password.dpapi") ? "from-dpapi" : "");

  const fromStore = bridgeCredentials({ JOB_SCOUT_SECURE_DIR: secure }, decrypt);
  assert.equal(fromStore.password, "from-dpapi");
  assert.equal(fromStore.from, "secure store");
  assert.equal(fromStore.env.BRIDGE_USER, "sam@example.com");
  assert.equal(fromStore.problem, null);
  assert.equal(parseEnvFile("BRIDGE_PASSWORD=x").BRIDGE_PASSWORD, undefined);

  const both = bridgeCredentials({ JOB_SCOUT_SECURE_DIR: secure, BRIDGE_PASSWORD: "plain" }, decrypt);
  assert.equal(both.password, "from-dpapi");
  assert.match(both.problem ?? "", /also still in \.env/);

  const plainOnly = bridgeCredentials({ JOB_SCOUT_SECURE_DIR: path.join(dir, "nowhere"), BRIDGE_PASSWORD: "plain" }, decrypt);
  assert.equal(plainOnly.from, ".env");
  assert.match(plainOnly.problem ?? "", /set-bridge-password/);

  const s = loadSettings(root, { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: secure }, decrypt);
  assert.equal(s.imap?.password, "from-dpapi");
  assert.equal(s.imap?.user, "sam@example.com");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H4: paused in Settings, the run reads nothing and keeps its place", async () => {
  const { dir, env } = scratch(["linkedin-alert-text.eml"]);
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 3, control: { paused: true } }));
  const paused = await run(loadSettings(root, { ...env, SETTINGS_FILE: settingsFile }), { bridge: false, today: "2026-10-14" });
  assert.equal(paused.paused, true);
  assert.equal(paused.judged.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "data", "runs")));
  assert.ok(!fs.existsSync(path.join(dir, "data", "state.json")));
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 4, control: { paused: false } }));
  const resumed = await run(loadSettings(root, { ...env, SETTINGS_FILE: settingsFile }), { bridge: false, today: "2026-10-15" });
  assert.ok(resumed.judged.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
