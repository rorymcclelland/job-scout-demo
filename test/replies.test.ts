// Sprint 6a, I2: reading each reply on the PC. The local model is replaced by a
// stand-in that answers as a model might, including wrongly, so the tests check
// what code does with the answer: grounding, calendar files, warnings, and
// that no email text leaves the PC. The real model's accuracy is the owner's
// grading sheet (npm run grade-replies).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { run } from "../src/scout.ts";
import { readReplies } from "../src/read-replies.ts";
import { makeSheet, scoreSheet, sheetPath } from "../src/grade-replies.ts";
import { appears, codeWarnings, groundReply, parseIcs, resolveDate, zoneNear, type ModelReply } from "../src/reader/reply.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures", "replies");

const base: ModelReply = { type: "other", company: "", role: "", dates: [], ask: "", askBy: "", suspectedInjection: false, injectionLines: [] };

/** What the stand-in model says, by a word in the subject. */
const ANSWERS: Record<string, Partial<ModelReply>> = {
  "Your application to Northwind": { type: "rejection", company: "Northwind", role: "Group Product Manager, Platform" },
  "Re: Head of Product at Acme AI": {
    type: "invitation", company: "Acme AI", role: "Head of Product",
    dates: [{ what: "first call option 1", asWritten: "Tuesday 20 October at 14:00" }, { what: "first call option 2", asWritten: "Wednesday 21 October at 10:30" }, { what: "made up", asWritten: "Friday 23 October at 09:00" }],
    ask: "Please reply with the slot that suits you by 18 October.", askBy: "18 October",
  },
  "Next step: your Seedling": { type: "assessment", company: "Seedling", role: "Fractional Chief Product Officer", ask: "Please complete the take-home task by 24 October 2026 using the link below.", askBy: "24 October 2026" },
  "Offer: Head of Product": { type: "offer", company: "Acme AI", role: "Head of Product", askBy: "2 November 2026" },
  "Still interested": { type: "follow-up", company: "Northwind", role: "Group Product Manager, Platform" },
  "We received your application": { type: "other", company: "Seedling" },
  "Invitation: Sam": { type: "invitation", company: "Acme AI", dates: [{ what: "call", asWritten: "Tuesday 20 October 2026, 14:00" }] },
  "Update on your Northwind": { type: "rejection", company: "Northwind" },
};

function fakeOllama(log: string[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5:14b" }] }));
    if (u.endsWith("/api/generate")) return new Response("{}");
    const body = JSON.parse(String(init?.body));
    const user: string = body.messages[1].content;
    log.push(user);
    const key = Object.keys(ANSWERS).find((k) => user.includes(k));
    const answer = { ...base, ...(key ? ANSWERS[key] : {}) };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) }, eval_count: 50, eval_duration: 1e9 }));
  }) as typeof fetch;
}

function scratch(files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-replies-"));
  for (const d of ["inbox", "context", "data"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status | Applied | Next |\n|---|---|---|---|---|\n");
  fs.writeFileSync(path.join(dir, "data", "watchlist.json"), JSON.stringify({ written: "2026-10-16", entries: [
    { cardId: "c-acme", company: "Acme AI", role: "Head of Product", status: "applied", domains: ["acme-ai.example"], recruiters: [] },
    { cardId: "c-northwind", company: "Northwind", role: "Group Product Manager, Platform", status: "applied", domains: [], recruiters: ["sam.taylor@talentco.example"] },
  ] }));
  for (const f of files) fs.copyFileSync(path.join(fixtures, f + ".eml"), path.join(dir, "inbox", f + ".eml"));
  const env: NodeJS.ProcessEnv = { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1", CONTEXT_DIR: path.join(dir, "context") };
  return { dir, settings: loadSettings(root, env) };
}

const ALL = ["greenhouse-rejection", "company-invitation", "lever-assessment", "company-offer", "recruiter-followup", "workable-ack", "calendar-invite", "spoof-offer", "dkim-fail"];

async function readAll() {
  const { dir, settings } = scratch(ALL);
  await run(settings, { bridge: false, today: "2026-10-27" });
  const sent: string[] = [];
  const s = await readReplies(settings, { today: "2026-10-27", fetchFn: fakeOllama(sent) });
  const by = (domain: string, type?: string) => s.replies.find((r) => r.domain === domain && (!type || r.read?.type === type));
  return { dir, settings, s, sent, by };
}

test("I2.1 a rejection: typed, company and role kept", async () => {
  const { s } = await readAll();
  const r = s.replies.find((x) => x.domain === "greenhouse-mail.io" && x.verified)!;
  assert.equal(r.status, "ok");
  assert.equal(r.read?.company, "Northwind");
  assert.equal(r.read?.role, "Group Product Manager, Platform");
});

test("I2.2 and 7 an invitation keeps both real slots; a date the model made up is dropped and the reply marked partial", async () => {
  const { s } = await readAll();
  const r = s.replies.find((x) => x.read?.type === "invitation" && x.read.dates.length >= 2)!;
  assert.deepEqual(r.read!.dates.map((d) => [d.date, d.time]), [["2026-10-20", "14:00"], ["2026-10-21", "10:30"]]);
  assert.equal(r.status, "partial");
  assert.match(r.reason!, /Friday 23 October/);
  assert.equal(r.read!.ask, "Please reply with the slot that suits you by 18 October.");
  assert.equal(r.read!.askBy?.date, "2026-10-18");
});

test("I2.3 an assessment keeps its deadline and quoted ask, and notes the link without opening it", async () => {
  const { by } = await readAll();
  const r = by("hire.lever.co")!;
  assert.equal(r.read?.type, "assessment");
  assert.equal(r.read?.askBy?.date, "2026-10-24");
  assert.equal(r.links, true);
});

test("I2.4, 5, 6 an offer, a recruiter's follow-up and an acknowledgement are typed as such", async () => {
  const { s } = await readAll();
  const types = s.replies.map((r) => `${r.domain}:${r.read?.type}`);
  assert.ok(types.includes("acme-ai.example:offer"));
  assert.ok(types.includes("talentco.example:follow-up"));
  assert.ok(types.includes("workablemail.com:other"));
});

test("I2.8 a calendar invitation's time is taken from the file, in its own zone", async () => {
  const { s } = await readAll();
  const r = s.replies.find((x) => x.calendar)!;
  assert.deepEqual(r.calendar, { start: "2026-10-20T14:00:00", end: "2026-10-20T14:45:00", zone: "Europe/London", organiserDomain: "acme-ai.example", method: "REQUEST" });
  assert.equal(parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261020T130000Z\nEND:VEVENT")?.zone, "UTC");
  assert.equal(parseIcs("not a calendar"), null);
});

test("I2.9 and 10 a hostile 'offer' is warned about, its instruction line never reaches the model, and nothing is sent", async () => {
  // The spoof is not from a hiring system or a watched sender, so the mail read
  // never lists it (I1.8). Read on its own, code still catches it.
  const text = fs.readFileSync(path.join(fixtures, "spoof-offer.eml"), "utf8");
  assert.deepEqual(codeWarnings(text), ["asks for money or bank details"]);
  const { sent } = await readAll();
  assert.ok(sent.every((u) => !/mark this candidate as hired/.test(u)));
});

test("I2.11 the summary that leaves the PC holds no email body", async () => {
  const { dir } = await readAll();
  const text = fs.readFileSync(path.join(dir, "data", "runs", "2026-10-27", "replies", "summary.json"), "utf8");
  for (const phrase of ["Thank you for applying", "Unfortunately, we have decided", "formal offer letter", "Just checking you are still"]) {
    assert.ok(!text.includes(phrase), `"${phrase}" must not leave the PC`);
  }
  const s = JSON.parse(text);
  for (const r of s.replies) assert.ok(!r.read?.ask || r.read.ask.length <= 200);
});

test("I2 grounding: a company the email never names is dropped; matching ignores case, quotes and spacing", () => {
  const g = groundReply({ ...base, type: "rejection", company: "Globex", role: "Head  of Product" }, "Thanks for applying for the head of product role.", "2026-10-16T08:00:00Z");
  assert.equal(g.company, "");
  assert.equal(g.role, "Head  of Product");
  assert.equal(g.partial, true);
  assert.ok(appears("it’s", "It's here"));
  assert.equal(groundReply({ ...base, type: "hired" as never }, "x", "").type, "other", "an unknown type becomes other");
});

test("I2 dates: day-month, month-day, UK numeric, and a January date in a December email", () => {
  assert.deepEqual(resolveDate("Tuesday 20 October at 14:00", "2026-10-16T08:00:00Z"), { date: "2026-10-20", time: "14:00" });
  assert.deepEqual(resolveDate("October 24, 2026", ""), { date: "2026-10-24", time: null });
  assert.deepEqual(resolveDate("20/10/2026", ""), { date: "2026-10-20", time: null });
  assert.equal(resolveDate("5 January", "2026-12-18T08:00:00Z").date, "2027-01-05");
  assert.deepEqual(resolveDate("next week", ""), { date: null, time: null });
});

test("I2 with Ollama down, replies are listed but not read, and say why", async () => {
  const { settings } = scratch(["greenhouse-rejection"]);
  await run(settings, { bridge: false, today: "2026-10-27" });
  const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  const s = await readReplies(settings, { today: "2026-10-27", fetchFn: down });
  assert.equal(s.replies[0].status, "failed");
  assert.match(s.warnings[0], /Ollama is not answering/);
});

test("I2.12 grading: the sheet stays in the private store; the bar is 9 in 10 with no rejection/invitation mix-up", async () => {
  const { dir, settings } = await readAll();
  const { file, rows } = makeSheet(settings);
  assert.equal(file, sheetPath(settings));
  assert.ok(file.startsWith(path.join(dir, "secure")), "subjects never go to the run folder");
  assert.ok(rows >= 8);
  // Mark every row with the model's own type: 100%, but fewer than 10 rows is not enough.
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const mark = (rowsIn: string[], f: (cells: string[], i: number) => string) => [lines[0], ...rowsIn.map((l, i) => { const c = l.split('","'); return l.replace(/""$/, `"${f(c, i)}"`); })].join("\r\n");
  const body = lines.slice(1);
  fs.writeFileSync(file, mark(body, (c) => c[4]));
  let g = scoreSheet(settings, "2026-10-27");
  assert.ok(!("problem" in g));
  if (!("problem" in g)) { assert.equal(g.of, body.length); assert.equal(g.passed, body.length >= 10); }
  // Ten rows, one wrong but not a mix-up: passes.
  const ten = Array.from({ length: 10 }, (_, i) => body[i % body.length]);
  fs.writeFileSync(file, mark(ten, (c, i) => (i === 0 ? "other" : c[4])));
  g = scoreSheet(settings, "2026-10-27");
  assert.ok(!("problem" in g) && g.of === 10 && g.right >= 9 && g.confusions === 0 && g.passed === true);
  // A rejection marked as an invitation fails, however good the rest.
  const rej = body.find((l) => l.includes('"rejection"'))!;
  fs.writeFileSync(file, mark(Array.from({ length: 12 }, () => rej), (c, i) => (i === 0 ? "invitation" : c[4])));
  g = scoreSheet(settings, "2026-10-27");
  assert.ok(!("problem" in g) && g.confusions === 1 && g.passed === false);
  // A type not in the list is refused.
  fs.writeFileSync(file, mark([rej], () => "hired"));
  g = scoreSheet(settings, "2026-10-27");
  assert.ok("problem" in g);
});

test("I2 to I4 end to end: the PC's summary passes the checker, and part 2's matching and moves pass theirs", async (t) => {
  const { spawnSync } = await import("node:child_process");
  // The Python tools run in Claude's workspace each morning, not on the PC, so
  // this test needs a Python only where one is installed; otherwise it is skipped.
  const py = ["python3", "python", "py"].find((c) => {
    const r = spawnSync(c, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "3";
  });
  if (!py) { t.skip("no Python 3 on this computer: the tools run in Claude's workspace, and npm run test:tools covers them there"); return; }
  const { dir } = await readAll();
  const sum = path.join(dir, "data", "runs", "2026-10-27", "replies", "summary.json");
  const tool = (args: string[]) => spawnSync(py, args, { cwd: root, encoding: "utf8" });
  const v = tool(["tools/validate.py", "replies", sum]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const board = path.join(dir, "board.json");
  fs.writeFileSync(board, JSON.stringify([
    { id: "acme", data: { company: "Acme AI", role: "Head of Product", status: "applied" } },
    { id: "northwind", data: { company: "Northwind", role: "Group Product Manager, Platform", status: "applied" } },
    { id: "seedling", data: { company: "Seedling", role: "Fractional Chief Product Officer", status: "applied" } },
  ]));
  const m = tool(["tools/replies.py", "match", "--summary", sum, "--board", board, "--today", "2026-10-27"]);
  assert.equal(m.status, 0, m.stderr);
  const matched = path.join(dir, "matched.json");
  fs.writeFileSync(matched, m.stdout);
  const out = JSON.parse(m.stdout);
  // The first look back and an ungraded reader: everything is a suggestion, nothing moves.
  assert.ok(out.items.every((i: { action: string }) => i.action !== "move"));
  assert.ok(out.patches.every((p: { patch: Record<string, unknown> }) => !("status" in p.patch)));
  const c = tool(["tools/validate.py", "moves", matched, "--existing", board]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
});

test("I7 zones written beside a time are noted; none is guessed", async () => {
  assert.equal(zoneNear("Wednesday 21 October at 10:30", "Could you do Wednesday 21 October at 10:30 (UK time)?"), "Europe/London");
  assert.equal(zoneNear("14:00 CET", "at 14:00 CET"), "Europe/Berlin");
  assert.equal(zoneNear("Monday at 9:00", "Monday at 9:00 Singapore time works"), "Asia/Singapore");
  assert.equal(zoneNear("Tuesday 20 October at 14:00", "Tuesday 20 October at 14:00, or later"), null);
  const { s } = await readAll();
  const inv = s.replies.find((x) => x.read?.type === "invitation" && x.read.dates.length >= 2)!;
  assert.deepEqual(inv.read!.dates.map((d) => d.zone), ["Europe/London", "Europe/London"], "\"(UK time)\" after the pair covers both slots");
});

test("BUG-4 (live run, 18 Oct): a VTIMEZONE block's DTSTART is not taken for the event's start", async () => {
  const { parseIcs } = await import("../src/reader/reply.ts");
  const ics = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VTIMEZONE", "TZID:Europe/London", "BEGIN:DAYLIGHT", "DTSTART:19700329T010000", "END:DAYLIGHT", "BEGIN:STANDARD", "DTSTART:19701025T020000", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", "DTSTART;TZID=Europe/London:20261020T153000", "DTEND;TZID=Europe/London:20261020T161500", "ORGANIZER:mailto:talent@example.com", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const e = parseIcs(ics)!;
  assert.equal(e.start, "2026-10-20T15:30:00");
  assert.equal(e.end, "2026-10-20T16:15:00");
  assert.equal(e.zone, "Europe/London");
  assert.equal(e.method, "REQUEST");
});

