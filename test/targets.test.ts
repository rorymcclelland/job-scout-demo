// B13: target employers (Sprint 5a). Scores are never touched here: the code
// only marks target roles and puts them first; the cap rule is checked by
// tools/validate.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judge, targetOf, type Constraints } from "../src/filters.ts";
import { applySettings } from "../src/settings.ts";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";

const root = path.join(import.meta.dirname, "..");
const constraints: Constraints = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "config", "constraints.json"), "utf8"));
const sources = { senders: [], firstRunLookbackDays: 7 };

test("B13: Google matches Google UK and Google LLC, not Googleplex Ltd", () => {
  assert.equal(targetOf("Google UK", constraints), "Google");
  assert.equal(targetOf("Google LLC", constraints), "Google");
  assert.equal(targetOf("google", constraints), "Google");
  assert.equal(targetOf("Microsoft AI", constraints), "Microsoft");
  assert.equal(targetOf("Googleplex Ltd", constraints), null);
  assert.equal(targetOf("", constraints), null);
});

test("B13: being a target never changes the filters' verdict", () => {
  const role = {
    id: "linkedin:1", source: "linkedin" as const, title: "Product Manager", company: "Google", location: "London",
    workplace: null, pay: null, url: "", notes: [], email: { subject: "", date: "", messageId: "" }, excerpt: "", parse: "full" as const,
  };
  const v = judge(role, constraints);
  assert.equal(v.kept, false); // plain Product Manager is below the floor, target or not
});

test("B13: Settings set the list, the below-the-line option and the extra places", () => {
  const out = applySettings(constraints, sources, { targets: { companies: [" Anthropic ", "Google"], packBelowLine: true, extraPlaces: 1 } });
  const t = out.constraints.targets!;
  assert.deepEqual([t.companies, t.packBelowLine, t.extraPlaces], [["Anthropic", "Google"], true, 1]);
  assert.ok(out.applied.includes("target employers"));
});

test("B13: Settings refuse a list with an empty company name", () => {
  const out = applySettings(constraints, sources, { targets: { companies: ["Google", "  "] } });
  assert.deepEqual(out.constraints.targets?.companies, ["Google", "Microsoft"]); // the file's list stands
  assert.ok(!out.applied.includes("target employers"));
  const bad = applySettings(constraints, sources, { targets: { extraPlaces: 9 } });
  assert.equal(bad.constraints.targets?.extraPlaces, 2);
});

test("B13: target roles to score are marked and listed first, in run.md and candidates.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-"));
  for (const d of ["inbox", "context"]) fs.mkdirSync(path.join(dir, d));
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "linkedin-alert-text.eml"), path.join(dir, "inbox", "a.eml"));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n");
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 9, targets: { companies: ["Wayfinder"] } }));
  const settings = loadSettings(root, {
    SETTINGS_FILE: path.join(dir, "settings.json"), JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"),
    EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1", CONTEXT_DIR: path.join(dir, "context"),
  });
  const { folder, judged } = await run(settings, { bridge: false, today: "2026-10-14" });
  const candidates = JSON.parse(fs.readFileSync(path.join(folder, "candidates.json"), "utf8"));
  assert.equal(candidates[0].role.company, "Wayfinder");
  assert.equal(candidates[0].target, "Wayfinder");
  assert.equal(candidates.filter((c: { target?: string }) => c.target).length, 1);
  assert.ok(judged.length > 1);
  const report = fs.readFileSync(path.join(folder, "run.md"), "utf8");
  assert.match(report, /\*\*Target employers:\*\* 1 to score \(Wayfinder\)/);
  assert.match(report, /Target employer \(Wayfinder\)\./);
  const status = JSON.parse(fs.readFileSync(path.join(folder, "status.json"), "utf8"));
  assert.equal(status.counts.target, 1);
});
