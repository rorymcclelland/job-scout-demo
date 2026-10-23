// H16 (Sprint 8): the safe demo. Made-up data only, written only under
// data\demo\<date>, never the real folders, never Bridge, never the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, type Settings } from "../src/config.ts";
import { assertDemoFolder, demoFetch, resetDemo, runDemo } from "../src/demo.ts";

const root = path.join(import.meta.dirname, "..");
const TODAY = "2026-10-21";

/** A stand-in for Ollama: an advert's requirements are copied from its own bullet lines; replies are typed by subject. */
function fakeOllama(calls: string[], off = false) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (off) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (u.endsWith("/api/tags")) return json({ models: [{ name: "qwen2.5:14b", digest: "d".repeat(64) }] });
    if (u.endsWith("/api/version")) return json({ version: "0.12.6" });
    if (u.endsWith("/api/show")) return json({ digest: "d".repeat(64) });
    if (u.endsWith("/api/generate")) return json({});
    const body = JSON.parse(String(init?.body));
    const text: string = body.messages[1].content;
    let answer: unknown;
    if (/^Subject:/m.test(text)) {
      const subject = /^Subject: (.*)$/m.exec(text)?.[1] ?? "";
      const type = /offer/i.test(subject) ? "offer" : /invitation/i.test(subject) ? "invitation" : /application/i.test(subject) ? "rejection" : "other";
      const company = ["LumenPay", "Orchard Systems", "Northgate Finance"].find((c) => text.includes(c)) ?? "";
      answer = { type, company, role: "", dates: [], ask: "", askBy: "", suspectedInjection: /AI assistant/i.test(text), injectionLines: [] };
    } else {
      const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => /years|experience|shipped|led |strong/i.test(l)).slice(0, 6);
      answer = { title: "", company: "", location: "", workplace: "", employment: "", pay: null, mustHaves: lines, niceToHaves: [], responsibilities: [], reportsTo: null, suspectedInjection: false, injectionLines: [] };
    }
    return json({ message: { content: JSON.stringify(answer) }, eval_count: 400, eval_duration: 1e10 });
  }) as typeof fetch;
}

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-demo-"));
  for (const d of ["data", "store", "vault", "secure"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "vault", "applications.md"), "| Company | Role | Status |\n|---|---|---|\n| Real Co | Real Role | Applied |\n");
  fs.writeFileSync(path.join(dir, "data", "seen.json"), "{}");
  const real: Settings = loadSettings(root, { SETTINGS_FILE: "none", DATA_DIR: path.join(dir, "data"), EMAIL_STORE: path.join(dir, "store"), CONTEXT_DIR: path.join(dir, "vault"), JOB_SCOUT_SECURE_DIR: path.join(dir, "secure") });
  return { dir, real };
}

function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p)); else out.push(p);
  }
  return out;
}

test("H16.1 the demo writes only under data\\demo\\<date>, and never touches the real folders, Bridge or the internet", async () => {
  const { dir, real } = world();
  const before = listAll(dir).map((f) => [f, fs.readFileSync(f, "utf8")]);
  const calls: string[] = [];
  const r = await runDemo({ ...real, imap: { host: "127.0.0.1", port: 1143, security: "starttls", user: "x", password: "y", folder: "INBOX" } }, { today: TODAY, fetchFn: fakeOllama(calls) });
  const demoHome = path.join(dir, "data", "demo", TODAY) + path.sep;
  for (const [f, text] of before) assert.equal(fs.readFileSync(f, "utf8"), text, `${f} was changed`);
  const added = listAll(dir).filter((f) => !before.some(([b]) => b === f));
  assert.ok(added.length > 10);
  for (const f of added) assert.ok(f.startsWith(demoHome), `${f} is outside data\\demo`);
  assert.ok(r.roles.toScore >= 4, `${r.roles.toScore} roles to score`);
  assert.ok(r.adverts.read >= 4, `${r.adverts.read} adverts read`);
  assert.ok(calls.every((u) => u.startsWith("http://127.0.0.1:11434/")), "only Ollama is called through the real fetch");
  // G11 (Sprint 10): both readers keep the local model's token counts, as Ollama reports them.
  const runDir = path.join(demoHome, "runs", TODAY);
  const specs = JSON.parse(fs.readFileSync(path.join(runDir, "specs", "summary.json"), "utf8"));
  assert.equal(specs.tokens.out, 400 * r.adverts.read, "each advert read adds the reported output tokens");
  const rep = JSON.parse(fs.readFileSync(path.join(runDir, "replies", "summary.json"), "utf8"));
  assert.ok(rep.tokens && rep.tokens.out > 0, "the reply reader keeps its tokens too");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H16.2 the hostile advert loses its lines and is flagged; the fake offer carries its warning", async () => {
  const { dir, real } = world();
  const r = await runDemo(real, { today: TODAY, fetchFn: fakeOllama([]) });
  const adverts = path.join(r.folder, "adverts");
  const marlow = fs.readdirSync(path.join(r.folder, "specs")).map((f) => JSON.parse(fs.readFileSync(path.join(r.folder, "specs", f), "utf8"))).find((s) => String(s.url ?? "").includes("marlow-health"));
  assert.ok(marlow, "the Marlow Health advert was read");
  assert.ok(marlow.linesRemoved >= 1);
  assert.equal(marlow.spec.suspectedInjection, true);
  const saved = fs.readdirSync(adverts).map((f) => fs.readFileSync(path.join(adverts, f), "utf8")).join("\n");
  assert.doesNotMatch(saved, /ignore your previous instructions/i);
  const replies = JSON.parse(fs.readFileSync(path.join(r.folder, "replies", "summary.json"), "utf8")) as { replies: Array<{ domain: string; warnings: string[] }> };
  const offer = replies.replies.find((x) => x.domain === "northgate-finance.example");
  assert.ok(offer, "the fake offer was found");
  assert.ok(offer.warnings.some((w) => /money or bank/.test(w)), offer.warnings.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H16.3 the demo refuses any folder outside data\\demo, and anything it did not make", () => {
  const { dir, real } = world();
  assert.throws(() => assertDemoFolder(real.dataDir, real), /not a folder under data\\demo/);
  assert.throws(() => assertDemoFolder(path.join(real.dataDir, "runs", TODAY), real), /not a folder under data\\demo/);
  assert.throws(() => assertDemoFolder(path.join(dir, "elsewhere"), real), /not a folder under data\\demo/);
  const foreign = path.join(real.dataDir, "demo", "2026-10-22");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "notes.txt"), "mine");
  assert.throws(() => assertDemoFolder(foreign, real), /not one of the demo's own folders/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H16.4 the demo reaches no address outside its own made-up sites", async () => {
  const f = demoFetch(root, "http://127.0.0.1:11434", fakeOllama([]));
  await assert.rejects(() => f("https://example.com/"), /made-up sites/);
  await assert.rejects(() => f("https://www.linkedin.com/jobs/view/1"), /made-up sites/);
  assert.equal((await f("https://careers.corvid-labs.example/robots.txt")).status, 404);
  assert.equal((await f("https://careers.corvid-labs.example/jobs/corvid-labs-head-of-product")).status, 200);
});

test("H16.5 running twice the same day starts clean; --reset deletes only the demo's own folders", async () => {
  const { dir, real } = world();
  const r1 = await runDemo(real, { today: TODAY, fetchFn: fakeOllama([]) });
  fs.writeFileSync(path.join(r1.folder, "leftover.txt"), "from the first run");
  const r2 = await runDemo(real, { today: TODAY, fetchFn: fakeOllama([]) });
  assert.ok(!fs.existsSync(path.join(r2.folder, "leftover.txt")));
  fs.mkdirSync(path.join(real.dataDir, "demo", "keep-me"), { recursive: true });
  assert.equal(resetDemo(real), 1);
  assert.ok(fs.existsSync(path.join(real.dataDir, "demo", "keep-me")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("H16.6 with Ollama off the demo still runs and says the reader was skipped", async () => {
  const { dir, real } = world();
  const r = await runDemo(real, { today: TODAY, fetchFn: fakeOllama([], true) });
  assert.equal(r.adverts.read, 0);
  assert.ok(r.adverts.warnings.some((w) => /Ollama is not answering/.test(w)), r.adverts.warnings.join(" "));
  assert.ok(r.roles.toScore >= 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The demo candidate is a disguised version of the owner's record (the owner's answer, 17 Oct 2026).
// Nothing in demo\ may name the owner, a real employer, a real client or a real application. The names
// live in config/private-names.txt, which is never published (H22); without it this test has nothing to
// check, and says so.
const NAMES_FILE = path.join(root, "config", "private-names.txt");
const REAL = fs.existsSync(NAMES_FILE)
  ? [...fs.readFileSync(NAMES_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")), "Google", "Chrome"]
  : [];
// Google and Chrome are also the names of an alert source and a browser: the board's own code and the public
// config template may name them as such. Everywhere else in demo\ (the candidate, documents, emails, adverts) they are refused.
const PRODUCT_NAMES = new Set(["Google", "Chrome"]);
const APP_FILES = /^demo[\\/](board[\\/]|public-config[\\/]config[\\/])/;

test("H16.7 no real name in the demo folder", { skip: REAL.length ? false : "config/private-names.txt is not here (the public copy)" }, () => {
  const files = listAll(path.join(root, "demo")).filter((f) => /\.(md|json|eml|html|txt|py)$/.test(f));
  assert.ok(files.length > 15);
  const hits: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const app = APP_FILES.test(path.relative(root, f));
    for (const n of REAL) if (!(app && PRODUCT_NAMES.has(n)) && new RegExp(`\\b${n.replace(/[.:]/g, "\\$&")}\\b`, "i").test(text)) hits.push(`${path.relative(root, f)}: ${n}`);
  }
  assert.deepEqual(hits, []);
});
