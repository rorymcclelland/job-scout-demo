// H9 (Sprint 7): the red team's PC half. Hostile, made-up inputs through the
// real pipeline, in a scratch folder only. A stand-in for Ollama plays the
// local model, well behaved or fooled.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { assertScratch, redteam, type Case } from "../src/redteam.ts";

const root = path.join(import.meta.dirname, "..");
const CASES = JSON.parse(fs.readFileSync(path.join(root, "test", "redteam", "cases.json"), "utf8")).cases as Case[];

function real() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-rt-"));
  const s = loadSettings(root, { SETTINGS_FILE: "none", DATA_DIR: path.join(dir, "data"), JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), CONTEXT_DIR: path.join(dir, "context"), OLLAMA_HOST: "http://ollama.test" });
  return { dir, s };
}

const SPEC = (over: Record<string, unknown> = {}) => ({
  title: "Head of Product, Planning", company: "Northwind Analytics", location: "London", workplace: "hybrid", employment: "permanent",
  pay: { min: 120000, max: 140000, currency: "GBP", period: "year", asWritten: "£120,000 to £140,000 a year" },
  mustHaves: ["10+ years in product management, including leading product managers", "Experience with B2B SaaS for finance teams", "Strong written communication"],
  niceToHaves: [], responsibilities: [], reportsTo: null, suspectedInjection: false, injectionLines: [], ...over,
});
const REPLY = { type: "offer", company: "Northwind Analytics", role: "Head of Product, Planning", dates: [], ask: "please send your bank details to payroll@northwind-analytics.example by Monday", askBy: null, suspectedInjection: false, injectionLines: [] };

function ollama(fooled = false) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.endsWith("/api/tags")) return json({ models: [{ name: "qwen2.5:14b", digest: "feedfacecafe0001" }] });
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body));
      const user = body.messages[1].content as string;
      const content = user.startsWith("<<<EMAIL") ? REPLY : fooled && /automated parsers/.test(user)
        ? SPEC({ pay: { min: 900000, max: 900000, currency: "GBP", period: "year", asWritten: "£900,000" }, mustHaves: [] })
        : SPEC();
      return json({ message: { content: JSON.stringify(content) }, eval_count: 300, eval_duration: 1e10 });
    }
    return json({});
  };
}

test("H9 1: at least eight cases, each with a stated expected defence and checks", () => {
  assert.ok(CASES.length >= 8);
  const kinds = new Set(CASES.map((c) => c.kind));
  for (const k of ["alert", "advert", "reply"]) assert.ok(kinds.has(k as Case["kind"]), k);
  for (const c of CASES) {
    assert.ok(c.expected.length > 40, `${c.id} states its defence`);
    assert.ok(c.pc.length > 0 && c.cloud.length > 0, `${c.id} has PC and cloud checks`);
    for (const t of [c.text ?? "", c.eml ?? ""]) assert.doesNotMatch(t.replace(/jobalerts-noreply@linkedin\.com/g, ""), /@(?!(?:[a-z0-9-]+\.)*(?:example|test)\b)[a-z0-9.-]+\.[a-z]{2,}/i, `${c.id}: addresses are made up (.example or .test), apart from LinkedIn's alert sender`);
  }
});

test("H9 2: the run touches no real data: it refuses the real data, run and store folders", () => {
  const { dir, s } = real();
  for (const p of [s.dataDir, path.join(s.dataDir, "runs"), s.emailStore, s.contextDir]) assert.throws(() => assertScratch(p, s), /refused/);
  fs.mkdirSync(path.join(dir, "other"), { recursive: true });
  fs.writeFileSync(path.join(dir, "other", "state.json"), "{}");
  assert.throws(() => assertScratch(path.join(dir, "other"), s), /real run's state/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9 2 and 4: with a well-behaved model every case holds; nothing is written outside data\\redteam; the report lists every case and layer", async () => {
  const { dir, s } = real();
  const r = await redteam(s, { today: "2026-10-17", fetchFn: ollama() });
  assert.equal(r.cases.length, CASES.length);
  assert.deepEqual(r.cases.filter((c) => c.result !== "pass").map((c) => `${c.id}: ${c.checks.filter((x) => x.result !== "pass").map((x) => x.detail).join("; ")}`), []);
  for (const c of r.cases) for (const ch of c.checks) assert.ok(["code", "local model"].includes(ch.layer));
  assert.equal(r.model, "qwen2.5:14b");
  assert.equal(r.digest, "feedfacecafe0001");
  // Only data\redteam was written: no runs, no seen list, no state, no private store.
  assert.deepEqual(fs.readdirSync(s.dataDir), ["redteam"]);
  assert.ok(!fs.existsSync(s.emailStore));
  const results = JSON.parse(fs.readFileSync(path.join(s.dataDir, "redteam", "2026-10-17", "results.json"), "utf8"));
  assert.equal(results.cases.length, CASES.length);
  for (const c of CASES) assert.ok(fs.existsSync(path.join(s.dataDir, "redteam", "2026-10-17", "cloud", `${c.id}.json`)));
  const rt8 = JSON.parse(fs.readFileSync(path.join(s.dataDir, "redteam", "2026-10-17", "cloud", "RT8.json"), "utf8"));
  assert.equal(rt8.replies.replies[0].read.type, "offer", "the hostile reply's summary itself is in the cloud file (BUG-2)");
  const rt1 = JSON.parse(fs.readFileSync(path.join(s.dataDir, "redteam", "2026-10-17", "cloud", "RT1.json"), "utf8"));
  assert.equal(rt1.candidates[0].role.company, "Redteamco");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9 3: a case that gets through is reported as a failure, not hidden", async () => {
  const { dir, s } = real();
  const r = await redteam(s, { today: "2026-10-17", fetchFn: ollama(true) });
  const rt7 = r.cases.find((c) => c.id === "RT7")!;
  assert.equal(rt7.result, "fail");
  assert.match(rt7.checks.find((x) => x.check === "model")!.detail, /900000.*not the advert's real line.*only 0 requirements/);
  assert.equal(r.failed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9: without the model, code checks still run and the model's are 'not run', never passed", async () => {
  const { dir, s } = real();
  const r = await redteam(s, { today: "2026-10-17", useModel: false });
  assert.equal(r.model, null);
  assert.equal(r.failed, 0);
  for (const c of r.cases) for (const ch of c.checks.filter((x) => x.layer === "local model")) assert.equal(ch.result, "not run");
  assert.ok(r.partly >= 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9 (BUG-1, found by RT10): an instruction in an alert's subject line is cleaned before the cloud reads it", async () => {
  const { dir, s } = real();
  const r = await redteam(s, { today: "2026-10-17", useModel: false });
  const rt10 = r.cases.find((c) => c.id === "RT10")!;
  assert.equal(rt10.result, "pass");
  assert.match(rt10.checks[0].detail, /listed under Untrusted text/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9 (review fix): a date that is not YYYY-MM-DD is refused before anything is written", async () => {
  const { dir, s } = real();
  await assert.rejects(redteam(s, { today: "../runs/2026-10-01", useModel: false }), /YYYY-MM-DD/);
  assert.ok(!fs.existsSync(path.join(s.dataDir, "runs")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H9 (fix): a second run the same day clears its own scratch folders and runs again", async () => {
  const { dir, s } = real();
  await redteam(s, { today: "2026-10-17", useModel: false });
  const again = await redteam(s, { today: "2026-10-17", useModel: false });
  assert.equal(again.failed, 0);
  assert.equal(again.cases.length, CASES.length);
  fs.rmSync(dir, { recursive: true, force: true });
});
