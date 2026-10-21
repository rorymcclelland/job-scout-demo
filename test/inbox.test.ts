// Sprint 6a, I1: finding the replies to the owner's applications, and only those.
// Test numbers follow docs\refinement\sprint-6.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config.ts";
import { parseEmail } from "../src/mime.ts";
import { run } from "../src/scout.ts";
import { dkimPasses, replyCandidate, searchTerms, within, type ReplySender } from "../src/inbox/senders.ts";
import type { Watchlist } from "../src/inbox/watch.ts";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");
const reply = (f: string) => parseEmail(fs.readFileSync(path.join(fixtures, "replies", f + ".eml")).toString("latin1"));
const SENDERS: ReplySender[] = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "config", "sources.json"), "utf8")).replySenders;

const WATCH: Watchlist = {
  written: "2026-10-16",
  entries: [
    { cardId: "c-northwind", company: "Northwind", role: "Group Product Manager, Platform", status: "applied", domains: ["northwind.example"], recruiters: ["sam.taylor@talentco.example"] },
    { cardId: "c-acme", company: "Acme AI", role: "Head of Product", status: "applied", domains: ["acme-ai.example"], recruiters: [] },
    { cardId: "c-harbourline", company: "Harbourline", role: "Staff Product Manager, Billing Platform", status: "applied", domains: ["harbourline.example", "quayside.example"], recruiters: [] },
  ],
};

test("I1.1 a hiring system's rejection is a reply, verified by DKIM", () => {
  const c = replyCandidate(reply("greenhouse-rejection"), WATCH, SENDERS);
  assert.equal(c?.via, "hiring-system");
  assert.equal(c?.system, "greenhouse");
  assert.equal(c?.verified, true);
  assert.deepEqual(c?.cardIds, []); // I3 decides which card
});

test("I1.2 an email from a watched company's own domain is a reply, pointing at its card", () => {
  const c = replyCandidate(reply("company-invitation"), WATCH, SENDERS);
  assert.equal(c?.via, "company");
  assert.deepEqual(c?.cardIds, ["c-acme"]);
});

test("I1.2b a watched recruiter's address is a reply", () => {
  const c = replyCandidate(reply("recruiter-followup"), WATCH, SENDERS);
  assert.equal(c?.via, "recruiter");
  assert.deepEqual(c?.cardIds, ["c-northwind"]);
});

test("I1.3 a LinkedIn job alert is not a reply; a LinkedIn application update is", () => {
  const alert = parseEmail(fs.readFileSync(path.join(fixtures, "linkedin-alert-text.eml")).toString("latin1"));
  assert.equal(replyCandidate(alert, WATCH, SENDERS), null);
  const update = replyCandidate(reply("linkedin-update"), WATCH, SENDERS);
  assert.equal(update?.via, "linkedin");
});

test("I1.4 a hiring system's newsletter, from its marketing domain, is ignored", () => {
  assert.equal(replyCandidate(reply("greenhouse-newsletter"), WATCH, SENDERS), null);
});

test("I1.5 a company with two domains is found through either", () => {
  assert.ok(within("mail.quayside.example", "quayside.example"));
  assert.ok(searchTerms(WATCH, SENDERS).includes("quayside.example"));
  assert.ok(searchTerms(WATCH, SENDERS).includes("harbourline.example"));
  assert.ok(!within("notperk.example", "harbourline.example"), "a look-alike domain is not a subdomain");
});

test("I1.8 a display name saying Greenhouse does not make a sender a hiring system", () => {
  assert.equal(replyCandidate(reply("spoof-offer"), WATCH, SENDERS), null);
});

test("I1.9 a reply whose DKIM signature fails is kept but unverified", () => {
  const c = replyCandidate(reply("dkim-fail"), WATCH, SENDERS);
  assert.equal(c?.via, "hiring-system");
  assert.equal(c?.verified, false);
  assert.equal(dkimPasses(["mx; dkim=pass header.d=other.example"], "greenhouse-mail.io"), false, "a pass for another domain does not count");
  assert.equal(dkimPasses([], "greenhouse-mail.io"), false, "no header, no pass");
});

// ---- end to end through the mail read ----

function scratch(withWatch = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scout-inbox-"));
  for (const d of ["inbox", "context", "data"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "context", "applications.md"), "| Company | Role | Status | Applied | Next |\n|---|---|---|---|---|\n");
  if (withWatch) fs.writeFileSync(path.join(dir, "data", "watchlist.json"), JSON.stringify(WATCH));
  const env: NodeJS.ProcessEnv = { SETTINGS_FILE: "none", JOB_SCOUT_SECURE_DIR: path.join(dir, "secure"), DATA_DIR: path.join(dir, "data"), EML_FOLDER: path.join(dir, "inbox"), KEEP_INBOX_FILES: "1", CONTEXT_DIR: path.join(dir, "context") };
  return { dir, env };
}

/** A stand-in for Bridge that answers every FROM search with the messages whose From contains the term. */
async function fakeBridge(messages: Record<number, string>, opts: { failSearch?: boolean } = {}) {
  const seen: string[] = [];
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
          if (opts.failSearch) { sock.write(`${tag} NO search failed\r\n`); continue; }
          const term = /FROM "([^"]*)"/.exec(cmd)?.[1] ?? "";
          const hits = Object.entries(messages).filter(([, m]) => (/^From: (.*)$/m.exec(m)?.[1] ?? "").toLowerCase().includes(term)).map(([u]) => u);
          sock.write(`* SEARCH ${hits.join(" ")}\r\n`);
        } else if (cmd.startsWith("UID FETCH")) {
          const uid = Number(cmd.split(" ")[2]);
          const m = messages[uid];
          if (m) {
            sock.write(`* 1 FETCH (UID ${uid} BODY[] {${Buffer.byteLength(m, "latin1")}}\r\n`);
            sock.write(Buffer.from(m, "latin1"));
            sock.write(")\r\n");
          }
        }
        sock.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

const raw = (f: string) => fs.readFileSync(path.join(fixtures, "replies", f + ".eml")).toString("latin1");

test("I1.1, 6, 10 the mail read finds replies read-only, lists them without their text, and looks back 60 days the first time", async () => {
  const { dir, env } = scratch();
  const bridge = await fakeBridge({
    11: raw("greenhouse-rejection"), 12: raw("company-invitation"), 13: raw("greenhouse-newsletter"),
    14: raw("dkim-fail"), 15: raw("lever-assessment"), 16: raw("spoof-offer"),
  });
  const settings = loadSettings(root, env);
  settings.imap = { host: "127.0.0.1", port: bridge.port, security: "none", user: "sam@example.com", password: "x", folder: "INBOX" };
  const { folder } = await run(settings, { bridge: true, today: "2026-10-17" });
  bridge.close();

  const found = JSON.parse(fs.readFileSync(path.join(folder, "replies", "found.json"), "utf8"));
  assert.equal(found.firstLook, true);
  assert.equal(found.since, "2026-08-18"); // 60 days back (the owner, Q4)
  assert.ok(bridge.seen.some((c) => c === 'UID SEARCH SINCE 18-Aug-2026 FROM "greenhouse-mail.io"'));
  const domains = found.replies.map((r: { domain: string }) => r.domain).sort();
  assert.deepEqual(domains, ["acme-ai.example", "greenhouse-mail.io", "greenhouse-mail.io", "hire.lever.co"]);
  assert.ok(found.replies.every((r: { firstLook: boolean }) => r.firstLook));
  assert.equal(found.replies.filter((r: { verified: boolean }) => !r.verified).length, 1);

  // No email text in the run folder: no subject, no body.
  const text = fs.readFileSync(path.join(folder, "replies", "found.json"), "utf8");
  assert.doesNotMatch(text, /Unfortunately|Your application|take-home|bank details/);
  // The emails themselves are in the private store; the newsletter and the spoof are not kept.
  const stored = fs.readdirSync(path.join(dir, "secure", "emails", "2026-10-17"));
  assert.equal(stored.filter((f) => f.startsWith("reply-")).length, 4);
  // Read-only, as for the alerts.
  assert.ok(bridge.seen.every((c) => !/STORE|EXPUNGE|DELETE|MOVE|COPY|APPEND|SELECT /.test(c)), "never changes the mailbox");
  assert.ok(bridge.seen.filter((c) => c.startsWith("UID FETCH")).every((c) => c.endsWith("BODY.PEEK[]")));

  // Next morning: no longer the first look, and it looks back from the last run.
  const bridge2 = await fakeBridge({});
  settings.imap.port = bridge2.port;
  const second = await run(settings, { bridge: true, today: "2026-10-18" });
  bridge2.close();
  const found2 = JSON.parse(fs.readFileSync(path.join(second.folder, "replies", "found.json"), "utf8"));
  assert.equal(found2.firstLook, false);
  assert.equal(found2.since, "2026-10-16");
});

test("I1.7 when Bridge fails, no replies are read and the next run looks back over the same days", async () => {
  const { dir, env } = scratch();
  const bridge = await fakeBridge({}, { failSearch: true });
  const settings = loadSettings(root, env);
  settings.imap = { host: "127.0.0.1", port: bridge.port, security: "none", user: "sam@example.com", password: "x", folder: "INBOX" };
  const { health } = await run(settings, { bridge: true, today: "2026-10-17" });
  bridge.close();
  assert.equal(health.bridge, "failed");
  const file = path.join(dir, "data", "state.json");
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.equal(state.inboxLastRun, undefined, "the first look is still to come");
});

test("I1 replies dropped in the inbox folder are read too, and a reply is never parsed for roles", async () => {
  const { dir, env } = scratch(false);
  for (const f of ["greenhouse-rejection", "linkedin-update", "workable-ack"]) fs.copyFileSync(path.join(fixtures, "replies", f + ".eml"), path.join(dir, "inbox", f + ".eml"));
  fs.copyFileSync(path.join(fixtures, "linkedin-alert-text.eml"), path.join(dir, "inbox", "linkedin-alert-text.eml"));
  const settings = loadSettings(root, env);
  const { folder, judged, health } = await run(settings, { bridge: false, today: "2026-10-17" });
  const found = JSON.parse(fs.readFileSync(path.join(folder, "replies", "found.json"), "utf8"));
  assert.equal(found.replies.length, 3);
  assert.equal(health.emails.linkedin, 1, "only the alert counts as a LinkedIn alert");
  assert.equal(judged.length, 12, "the alert's twelve roles, and nothing from the replies");
  assert.ok(!health.problems.some((p) => /No roles found/.test(p)), "a reply is not a broken alert");
  assert.ok(health.notes!.some((n) => /No watch list yet/.test(n)));
});

test("I1 replies can be switched off in Settings", async () => {
  const { dir, env } = scratch();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 9, sources: { repliesEnabled: false } }));
  fs.copyFileSync(path.join(fixtures, "replies", "greenhouse-rejection.eml"), path.join(dir, "inbox", "r.eml"));
  const settings = loadSettings(root, { ...env, SETTINGS_FILE: path.join(dir, "settings.json") });
  const { folder } = await run(settings, { bridge: false, today: "2026-10-17" });
  assert.ok(!fs.existsSync(path.join(folder, "replies", "found.json")));
});

// Sprint 8, I9: an application whose mail domain is not yet known is still found, by the company's own name.
import { companyToken } from "../src/inbox/watch.ts";
import { nameDomain } from "../src/inbox/senders.ts";

test("I9: the company's name as a domain label", () => {
  assert.equal(companyToken("Brightloop (via recruiter Jo)"), "brightloop");
  assert.equal(companyToken("Lending Loop"), "lendingloop");
  assert.equal(companyToken("Harbourline (formerly Quayside)"), "harbourline");
  assert.equal(companyToken("Acme Ltd"), "acme");
  assert.equal(companyToken("X"), null, "too short to be distinctive");
  assert.equal(nameDomain("brightloop.ai", "brightloop"), true);
  assert.equal(nameDomain("mail.lendingloop.com", "lendingloop"), true);
  assert.equal(nameDomain("acme.co.uk", "acme"), true);
  assert.equal(nameDomain("brightloop-careers.example", "brightloop"), false, "containing the name is not enough");
  assert.equal(nameDomain("gmail.com", "brightloop"), false);
});

test("I9: a reply from a watched company with no known domain is found by its name, and only from its own domain", () => {
  const watch: Watchlist = { written: "2026-10-20", entries: [{ cardId: "c-brightloop", company: "Brightloop (via recruiter Jo)", role: "PM, Content Quality", status: "applied", domains: [], recruiters: [] }] };
  const mail = (from: string) => parseEmail(`From: Barbara <${from}>\r\nTo: me@example.com\r\nSubject: Booking a call\r\nDate: Mon, 19 Oct 2026 10:00:00 +0100\r\nMessage-ID: <x1@${from.split("@")[1]}>\r\nAuthentication-Results: mx.example; dkim=pass header.d=${from.split("@")[1]}\r\nContent-Type: text/plain\r\n\r\nPlease book a time using this link.\r\n`);
  const c = replyCandidate(mail("barbara@brightloop.ai"), watch, SENDERS);
  assert.equal(c?.via, "company");
  assert.deepEqual(c?.cardIds, ["c-brightloop"]);
  assert.equal(c?.byName, true);
  assert.equal(c?.verified, true);
  assert.equal(replyCandidate(mail("hr@brightloop-careers.example"), watch, SENDERS), null, "a look-alike domain is not the company");
  assert.ok(searchTerms(watch, SENDERS).includes("brightloop"), "Bridge is asked for the name");
  const known: Watchlist = { written: "2026-10-21", entries: [{ ...watch.entries[0], domains: ["brightloop.ai"] }] };
  assert.ok(!searchTerms(known, SENDERS).includes("brightloop"), "once the domain is known, the name is not searched");
});

// Review findings, Sprint 8: a name match is never trusted like a known domain, and mail providers and placeholder names never match.
import { foundReply } from "../src/scout.ts";

test("I9 review: the user's own mail provider, and placeholder company names, never match by name", () => {
  assert.equal(nameDomain("notify.proton.me", companyToken("Proton")), false);
  assert.equal(nameDomain("pm.me", "pm"), false);
  assert.equal(companyToken("Confidential (via Ridge Search)"), null);
  assert.equal(companyToken("Product Company"), null);
  assert.equal(companyToken("Stealth Fintech"), null);
});

test("I9 review: a name match is carried into found.json, so part 2 can treat it as a suggestion", () => {
  const watch: Watchlist = { written: "2026-10-21", entries: [{ cardId: "c-fc", company: "Lending Loop", role: "Head of Product", status: "applied", domains: [], recruiters: [] }] };
  const email = parseEmail(`From: HR <hr@lendingloop.net>\r\nTo: me@example.com\r\nSubject: Your application\r\nDate: Mon, 19 Oct 2026 10:00:00 +0100\r\nMessage-ID: <x2@lendingloop.net>\r\nAuthentication-Results: mx.example; dkim=pass header.d=lendingloop.net\r\nContent-Type: text/plain\r\n\r\nWe will not be moving forward.\r\n`);
  const c = replyCandidate(email, watch, SENDERS);
  assert.equal(c?.byName, true);
  assert.equal(foundReply("r.eml", "2026-10-19", email, c!, false).byName, true);
});
