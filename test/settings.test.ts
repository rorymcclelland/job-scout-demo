import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { applySettings } from "../src/settings.ts";
import { judge } from "../src/filters.ts";
import type { Role } from "../src/role.ts";

const root = path.join(import.meta.dirname, "..");
const base = loadSettings(root, { DATA_DIR: os.tmpdir(), SETTINGS_FILE: "none" });

const role: Role = {
  id: "linkedin:1", source: "linkedin", title: "Head of Product", company: "Acme", location: "London, England, United Kingdom",
  workplace: "hybrid", pay: { min: 100000, max: 112000, currency: "GBP", period: "year", text: "£100k-£112k" },
  url: "", notes: [], email: { subject: "", date: "2026-10-14T08:00:00Z", messageId: "" }, excerpt: "", parse: "full",
};

test("settings: board values replace the file's, field by field", () => {
  const { constraints, sources, applied } = applySettings(base.constraints, base.sources, {
    version: 4,
    filters: { ukPermanentMin: 130000, ukPermanentTolerancePct: 5 },
    warnings: { staleAfterDays: 10, recruiterWords: ["Talent", " Search "] },
    sources: { firstRunLookbackDays: 3 },
  });
  assert.equal(constraints.pay.ukPermanentMinGBPPerYear, 130000);
  assert.equal(constraints.pay.ukPermanentTolerance, 0.05);
  assert.equal(constraints.warnings.staleAfterDays, 10);
  assert.deepEqual(constraints.warnings.recruiterWords, ["talent", "search"]);
  assert.equal(sources.firstRunLookbackDays, 3);
  assert.equal(constraints.settingsVersion, 4);
  assert.ok(applied.includes("UK permanent floor"));
  // Untouched fields keep the file's values; the inputs are not changed.
  assert.equal(constraints.pay.ukContractMinGBPPerDay, base.constraints.pay.ukContractMinGBPPerDay);
  assert.equal(base.constraints.pay.ukPermanentMinGBPPerYear, 120000);
  // £112k: inside 10% of £120k by default, more than 5% under £130k with the board's values.
  assert.equal(judge(role, base.constraints).kept, true);
  assert.equal(judge(role, constraints).kept, false);
});

test("settings: bad values are ignored, never fatal", () => {
  const { constraints, applied } = applySettings(base.constraints, base.sources, {
    filters: { ukPermanentMin: -5, ukContractMinPerDay: Number.NaN },
    markets: { london: [] },
    level: { leadership: ["", "x"] },
    sources: { senders: [{ source: "linkedin", from: "" }] },
  } as never);
  assert.deepEqual(applied, []);
  assert.equal(constraints.pay.ukPermanentMinGBPPerYear, 120000);
  assert.ok(constraints.locations.london.includes("london"));
});

test("settings: config/settings.json is read, and a broken one is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-settings-"));
  fs.mkdirSync(path.join(dir, "config"));
  for (const f of ["constraints.json", "sources.json"]) fs.copyFileSync(path.join(root, "test", "fixtures", "config", f), path.join(dir, "config", f));
  fs.writeFileSync(path.join(dir, "config", "settings.json"), JSON.stringify({ version: 7, filters: { ukContractMinPerDay: 900 }, scoring: { carryOverMax: 1 } }));
  const s = loadSettings(dir, { DATA_DIR: path.join(dir, "data") });
  assert.equal(s.constraints.pay.ukContractMinGBPPerDay, 900);
  assert.equal(s.carryOverMax, 1);
  assert.equal(s.constraints.settingsVersion, 7);
  assert.equal(s.settingsProblem, null);
  fs.writeFileSync(path.join(dir, "config", "settings.json"), "{ not json");
  const broken = loadSettings(dir, { DATA_DIR: path.join(dir, "data") });
  assert.match(broken.settingsProblem ?? "", /could not be read/);
  assert.equal(broken.constraints.pay.ukContractMinGBPPerDay, 800);
  fs.rmSync(dir, { recursive: true, force: true });
});
