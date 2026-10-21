// B12: Google's and Microsoft's own alert emails as sources, and sources made
// data-driven. Fixtures are the owner's real alerts with personal and tracking
// addresses removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEmail } from "../src/mime.ts";
import { kindOf, rolesFrom } from "../src/parsers/index.ts";
import { mergeDuplicates } from "../src/dedupe.ts";
import { applySettings } from "../src/settings.ts";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";
import type { Role } from "../src/role.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");
const email = (f: string) => parseEmail(fs.readFileSync(path.join(fixtures, f)).toString("latin1"));

test("B12: a Google alert gives every role, with title, place, link and id", () => {
  const { kind, roles, note } = rolesFrom(email("google-alert.eml"));
  assert.equal(kind, "google");
  assert.equal(roles.length, 4);
  assert.equal(note, undefined);
  const gpm = roles.find((r) => r.title === "Group Product Manager, Google Labs")!;
  assert.equal(gpm.id, "google:92710706155004614");
  assert.equal(gpm.company, "Google");
  assert.equal(gpm.location, "London");
  assert.equal(gpm.url, "https://www.google.com/about/careers/applications/jobs/results/92710706155004614-group-product-manager,-google-labs");
  assert.match(gpm.excerpt, /10 years of experience in product management/);
  assert.deepEqual(gpm.notes, ["Posted 4 days ago"]);
  assert.ok(roles.every((r) => r.parse === "full" && r.source === "google"));
});

test("B12: a Microsoft alert gives the roles it shows, and says how many it left out", () => {
  const { kind, roles, note } = rolesFrom(email("microsoft-alert.eml"));
  assert.equal(kind, "microsoft");
  assert.equal(roles.length, 3);
  assert.match(note ?? "", /showed 3 of 30 new jobs/);
  const recruiter = roles[0];
  assert.equal(recruiter.id, "microsoft:1970393557002628");
  assert.equal(recruiter.title, "Senior Recruiter Microsoft AI");
  assert.equal(recruiter.location, "United Kingdom, London, London");
  assert.equal(recruiter.url, "https://microsoft.eightfold.ai/careerhub/explore/jobs/1970393557002628");
  assert.equal(roles[1].location, "United Kingdom, Multiple Locations, Multiple Locations | Netherlands, Multiple Locations, Multiple Locations");
});

test("B12: Google's unquoted links survive HTML to text (LinkedIn and hackajob unchanged)", () => {
  assert.equal(kindOf(email("linkedin-alert-html.eml")), "linkedin");
  assert.equal(kindOf(email("hackajob-weekly.eml")), "hackajob");
  assert.equal(kindOf(email("recruiter-phish.eml")), "other");
});

test("B12: the same role from Google and a LinkedIn alert is one candidate, the employer's own record kept", () => {
  const g = rolesFrom(email("google-alert.eml")).roles.find((r) => r.id === "google:92710706155004614")!;
  const li: Role = { ...g, id: "linkedin:4400000001", source: "linkedin", company: "Google", title: "Group Product Manager, Google Labs", url: "https://www.linkedin.com/jobs/view/4400000001", notes: [] };
  for (const order of [[li, g], [g, li]]) {
    const out = mergeDuplicates(order);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "google:92710706155004614");
    assert.match(out[0].notes.join(" "), /Also in a linkedin alert \(linkedin:4400000001\)/);
  }
  // A different role at the same company is not merged.
  assert.equal(mergeDuplicates([g, { ...li, title: "Head of Product, Cloud" }]).length, 2);
});

test("B12: Settings accept the new sources, and a sender with no parser yet", () => {
  const sources = { senders: [], firstRunLookbackDays: 7 };
  const c = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "config", "constraints.json"), "utf8"));
  const senders = [{ source: "google", from: "careers-noreply@google.com" }, { source: "anthropic", from: "jobs@anthropic.com" }];
  assert.deepEqual(applySettings(c, sources, { sources: { senders } }).sources.senders, senders);
  assert.equal(applySettings(c, sources, { sources: { senders: [{ source: "Bad Name!", from: "x" }] } }).sources.senders.length, 0);
  const configured = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "config", "sources.json"), "utf8")).senders.map((s: { source: string }) => s.source);
  for (const s of ["linkedin", "hackajob", "google", "microsoft"]) assert.ok(configured.includes(s), s);
});

function scratch(files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-"));
  for (const d of ["inbox", "context"]) fs.mkdirSync(path.join(dir, d));
  for (const f of files) fs.copyFileSync(path.join(fixtures, f), path.join(dir, "inbox", f));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n");
  const env = { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1", CONTEXT_DIR: path.join(dir, "context") };
  return { dir, env };
}

test("B12: a run reads both, counts them in source health, and reports what Microsoft left out", async () => {
  const { env } = scratch(["google-alert.eml", "microsoft-alert.eml", "linkedin-alert-text.eml"]);
  const { folder, judged, health } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-02" });
  assert.equal(health.emails.google, 1);
  assert.equal(health.emails.microsoft, 1);
  assert.equal(health.rolesBySource.google, 4);
  assert.equal(health.rolesBySource.microsoft, 3);
  const report = fs.readFileSync(path.join(folder, "run.md"), "utf8");
  assert.match(report, /\| Google Careers \| 1 \| 4 \|/);
  assert.match(report, /\| Microsoft Careers \| 1 \| 3 \|/);
  assert.match(report, /showed 3 of 30 new jobs/);
  // Google and Microsoft are target employers by default (B13): their roles to score come first.
  const gpm = judged.find((j) => j.role.id === "google:92710706155004614")!;
  assert.equal(gpm.stage, "score");
  assert.equal(gpm.target, "Google");
  const recruiter = judged.find((j) => j.role.id === "microsoft:1970393557002628")!;
  assert.equal(recruiter.stage, "dropped"); // a recruiter role, target or not
  const candidates = JSON.parse(fs.readFileSync(path.join(folder, "candidates.json"), "utf8"));
  assert.equal(candidates[0].target, "Google");
  const state = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, "state.json"), "utf8"));
  assert.equal(state.history.at(-1).google, 1);
  assert.equal(state.history.at(-1).microsoft, 1);
});

test("B12: Google going silent for two runs is reported", async () => {
  const { env } = scratch(["linkedin-alert-text.eml"]);
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.DATA_DIR, "state.json"), JSON.stringify({
    lastRun: "2026-10-13",
    history: [{ date: "2026-10-11", linkedin: 2, hackajob: 1, google: 1 }, { date: "2026-10-12", linkedin: 2, hackajob: 1, google: 0 }, { date: "2026-10-13", linkedin: 2, hackajob: 1 }],
  }));
  const { health } = await run(loadSettings(root, env), { bridge: false, today: "2026-10-14" });
  assert.ok(health.problems.some((p) => /No Google Careers emails for two runs in a row/.test(p)), health.problems.join("\n"));
  assert.ok(!health.problems.some((p) => /Microsoft/.test(p))); // never sent, so not missed
});
