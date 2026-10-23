import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { fetchMessages } from "../src/imap.ts";
import { isScored, missedDays, run } from "../src/scout.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");
// Named, so stray files in the folder do not change the counts below.
const FIXTURES = [
  "linkedin-alert-text.eml", "linkedin-alert-html.eml", "linkedin-alert-cards.eml",
  "hackajob-weekly.eml", "hackajob-single.eml", "hackajob-reminder.eml", "hackajob-welcome.eml",
];

function scratch(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-"));
  fs.mkdirSync(path.join(dir, "inbox"));
  fs.mkdirSync(path.join(dir, "context"));
  for (const f of FIXTURES) fs.copyFileSync(path.join(fixtures, f), path.join(dir, "inbox", f));
  fs.writeFileSync(
    path.join(dir, "context", "applications.md"),
    "| Company | Role | Status | Applied | Next |\n|---|---|---|---|---|\n| Ledgerly | Senior Product Manager, Data Platform | Applied | 2026-09-03 | x |\n| Harbourline (formerly Quayside) | Staff Product Manager, Billing Platform | Applied | 2026-09-03 | x |\n",
  );
  return {
    dir,
    env: { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1", CONTEXT_DIR: path.join(dir, "context") },
  };
}

test("end to end from .eml files: run folder, report and seen list", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, env);
  const { folder, judged, health } = await run(settings, { bridge: false, today: "2026-10-14" });

  assert.equal(health.emails.linkedin, 3);
  assert.equal(health.emails.hackajob, 4);
  assert.equal(judged.length, 22); // LinkedIn 12 + 2 + 3, hackajob 3 + 1 + 1

  const stage = (company: string) => judged.find((j) => j.role.company === company)?.stage;
  assert.equal(stage("Ledgerly"), "known"); // on the tracker
  assert.equal(stage("Harbourline"), "known");
  assert.equal(stage("Wayfinder"), "score"); // £115k: within 10% of the floor (rubric v2)
  assert.equal(stage("Acme AI"), "score");
  assert.equal(stage("Nimbus"), "score"); // £125k top of range clears £120k
  assert.equal(stage("Northbank"), "dropped"); // an engineering role

  const report = fs.readFileSync(path.join(folder, "run.md"), "utf8");
  assert.match(report, /## To score \(/);
  assert.match(report, /just under £120,000/);
  const candidates = JSON.parse(fs.readFileSync(path.join(folder, "candidates.json"), "utf8"));
  assert.ok(candidates.every((c: { stage: string }) => c.stage === "score"));
  // H14: the copy is in the private store, not the run folder the cloud reads.
  assert.ok(fs.existsSync(path.join(dir, "secure", "emails", "2026-10-14", "file-linkedin-alert-text.eml")));
  assert.ok(!fs.existsSync(path.join(folder, "emails")));

  // Same day again: nothing is newly "seen before".
  const again = await run(settings, { bridge: false, today: "2026-10-14" });
  assert.equal(again.judged.filter((j) => j.stage === "score").length, candidates.length);

  const status = JSON.parse(fs.readFileSync(path.join(folder, "status.json"), "utf8"));
  assert.equal(status.ok, true);

  // Next day: everything from yesterday is already known.
  const next = await run(settings, { bridge: false, today: "2026-10-15" });
  assert.equal(next.judged.filter((j) => j.stage === "score").length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("carry-over: a role that missed the cap is offered again, at most twice", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, env);
  const first = await run(settings, { bridge: false, today: "2026-10-14" });
  const missed = first.judged.find((j) => j.role.company === "Acme AI")!.role;
  const carryFile = path.join(dir, "data", "carryover.json");
  fs.writeFileSync(carryFile, JSON.stringify([{ role: missed, score: 66, runDate: "2026-10-14", carries: 0 }]));
  const next = await run(settings, { bridge: false, today: "2026-10-15" });
  const carried = next.judged.filter((j) => j.carried);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].stage, "score");
  assert.deepEqual(carried[0].carried, { from: "2026-10-14", score: 66, carries: 1 });
  assert.match(fs.readFileSync(path.join(next.folder, "run.md"), "utf8"), /Carried over from 2026-10-14 \(scored 66\)/);
  fs.writeFileSync(carryFile, JSON.stringify([{ role: missed, score: 66, runDate: "2026-10-15", carries: 2 }]));
  const third = await run(settings, { bridge: false, today: "2026-10-16" });
  assert.equal(third.judged.filter((j) => j.carried).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("source health: a source silent for two runs is flagged", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, env);
  await run(settings, { bridge: false, today: "2026-10-13" });
  for (const f of fs.readdirSync(path.join(dir, "inbox"))) if (f.startsWith("hackajob")) fs.rmSync(path.join(dir, "inbox", f));
  const quiet1 = await run(settings, { bridge: false, today: "2026-10-14" });
  assert.ok(!quiet1.health.problems.some((p) => /hackajob emails for two runs/.test(p)));
  const quiet2 = await run(settings, { bridge: false, today: "2026-10-15" });
  assert.ok(quiet2.health.problems.some((p) => /No hackajob emails for two runs/.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Bridge failure: reported, and nothing is marked seen, so no mail is lost", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, { ...env, BRIDGE_USER: "x", BRIDGE_PASSWORD: "y", BRIDGE_PORT: "1", BRIDGE_SECURITY: "none" });
  const failed = await run(settings, { bridge: true, today: "2026-10-14" });
  const status = JSON.parse(fs.readFileSync(path.join(failed.folder, "status.json"), "utf8"));
  assert.equal(status.ok, false);
  assert.match(status.problems.join(" "), /Bridge: .*Nothing from this run is marked as seen/);
  assert.ok(!fs.existsSync(path.join(dir, "data", "seen.json")));
  assert.ok(!fs.existsSync(path.join(dir, "data", "state.json")));
  // The next day, with Bridge left out, the same roles are still new.
  const next = await run(loadSettings(root, env), { bridge: false, today: "2026-10-15" });
  assert.equal(next.judged.filter((j) => j.stage === "score").length, failed.judged.filter((j) => j.stage === "score").length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no Bridge settings: the run still works from files and says why", async () => {
  const { dir, env } = scratch();
  const { health } = await run(loadSettings(root, env), { bridge: true, today: "2026-10-14" });
  assert.match(health.problems.join(" "), /not set up yet/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("imap: logs in, opens read-only, searches by sender, fetches with PEEK", async () => {
  const message = fs.readFileSync(path.join(fixtures, "hackajob-weekly.eml")).toString("latin1");
  const seen: string[] = [];

  // A tiny stand-in for Bridge, speaking just the commands the client sends.
  const server = net.createServer((sock) => {
    sock.write("* OK fake Bridge ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        seen.push(cmd);
        if (cmd.startsWith("UID SEARCH")) {
          sock.write(cmd.includes("hackajob") ? "* SEARCH 7\r\n" : "* SEARCH\r\n");
        } else if (cmd.startsWith("UID FETCH 7")) {
          const bytes = Buffer.byteLength(message, "latin1");
          sock.write(`* 1 FETCH (UID 7 BODY[] {${bytes}}\r\n`);
          sock.write(Buffer.from(message, "latin1"));
          sock.write(")\r\n");
        }
        sock.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const msgs = await fetchMessages(
    { host: "127.0.0.1", port, security: "none", user: "sam@example.com", password: 'pa"ss', folder: "INBOX" },
    ["linkedin.com", "hackajob"],
    new Date("2026-10-12T00:00:00"),
  );
  server.close();

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].raw, message);
  assert.match(msgs[0].raw, /3 roles I matched/);
  assert.ok(seen.includes('EXAMINE "INBOX"'), "opens the folder read-only");
  assert.ok(seen.some((c) => c === "UID SEARCH SINCE 12-Oct-2026 FROM \"hackajob\""));
  assert.ok(seen.some((c) => c === "UID FETCH 7 BODY.PEEK[]"), "fetches without marking as read");
  assert.ok(seen.some((c) => c === 'LOGIN "sam@example.com" "pa\\"ss"'), "quotes the password safely");
  assert.ok(!seen.some((c) => /STORE|EXPUNGE|DELETE|MOVE|COPY|APPEND|SELECT /.test(c)), "never changes the mailbox");
});

test("G4: a mail read after the run is scored writes nothing, keeps the last-run date, and --force reads again", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, env);
  const first = await run(settings, { bridge: false, today: "2026-10-23" });
  fs.writeFileSync(path.join(first.folder, "digest.md"), "# scored\n");
  const status = fs.readFileSync(path.join(first.folder, "status.json"), "utf8");
  const state = fs.readFileSync(path.join(dir, "data", "state.json"), "utf8");
  const again = await run(settings, { bridge: false, today: "2026-10-23" });
  assert.equal(again.alreadyScored, true);
  assert.match(again.health.problems[0], /already scored/);
  assert.equal(fs.readFileSync(path.join(first.folder, "status.json"), "utf8"), status, "the scored run's files are untouched");
  assert.equal(fs.readFileSync(path.join(dir, "data", "state.json"), "utf8"), state);
  const forced = await run(settings, { bridge: false, today: "2026-10-23", force: true });
  assert.ok(!forced.alreadyScored);
  // A digest written after a failed mail read (SCOUT.md step 1) does not block the re-run.
  const status2 = JSON.parse(fs.readFileSync(path.join(first.folder, "status.json"), "utf8"));
  fs.writeFileSync(path.join(first.folder, "status.json"), JSON.stringify({ ...status2, ok: false }));
  fs.writeFileSync(path.join(first.folder, "digest.md"), "# Bridge failed\n");
  assert.equal(isScored(first.folder), false);
});

test("G4: mornings with no run since the last one are reported as missed", async () => {
  const { dir, env } = scratch();
  const settings = loadSettings(root, env);
  await run(settings, { bridge: false, today: "2026-10-20" });
  const later = await run(settings, { bridge: false, today: "2026-10-23" });
  assert.ok(later.health.problems.some((p) => /No run on 2026-10-21, 2026-10-22/.test(p)));
  const status = JSON.parse(fs.readFileSync(path.join(later.folder, "status.json"), "utf8"));
  assert.deepEqual(status.missed, ["2026-10-21", "2026-10-22"]);
  assert.deepEqual(missedDays(path.join(dir, "data"), "2026-10-23", "2026-10-24"), []);
  assert.deepEqual(missedDays(path.join(dir, "data"), undefined, "2026-10-24"), []);
});
