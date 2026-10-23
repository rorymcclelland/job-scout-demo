// npm run scout — the fetch-and-filter half of a Job Scout run.
//
//   1. Read new job-alert emails: from Proton Mail Bridge, and from any .eml
//      files dropped in data/inbox (useful before Bridge is set up, or to
//      re-run an old email).
//   2. Turn each email into role records (one per job).
//   3. Drop roles already on the tracker or seen in an earlier run.
//   4. Apply the hard filters, with a reason for every role dropped.
//   5. Write today's run folder, data/runs/YYYY-MM-DD/, for the scoring step.
//
// Scoring and the digest are the second half, done by Claude following
// _context/job-scout/SCOUT.md. This half needs no AI and sends nothing anywhere.
//
// Options:  --days N      look back N days instead of "since the last run"
//           --no-bridge   read only the .eml folder

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { fetchMessages } from "./imap.ts";
import { parseEmail } from "./mime.ts";
import { rolesFrom, type EmailKind } from "./parsers/index.ts";
import { mergeDuplicates, onTracker, readTracker, seenBefore, type SeenStore, type TrackerRow } from "./dedupe.ts";
import { ageInDays, judge, targetOf } from "./filters.ts";
import { SOURCES, sourceCounts, sourceName, type Role, type Verdict } from "./role.ts";
import { writeReport, type Health, type Judged } from "./report.ts";
import { cleanUntrusted, LIMITS } from "./untrusted.ts";
import { appendEntry, hashFile } from "./ledger.ts";
import { readWatchlist } from "./inbox/watch.ts";
import { replyCandidate, searchTerms, type Candidate } from "./inbox/senders.ts";
import { createHash } from "node:crypto";
import { pruneRuns } from "./retention.ts";
import { checkAll, staleAfterDays } from "./staleness.ts";

export interface RunOptions {
  days?: number;
  bridge: boolean;
  today?: string; // YYYY-MM-DD, for tests
  /** G4: read again even though today's run is already scored (npm run scout -- --force). */
  force?: boolean;
}

export async function run(settings: Settings, opts: RunOptions): Promise<{ folder: string; judged: Judged[]; health: Health; paused?: boolean; alreadyScored?: boolean }> {
  const today = opts.today ?? localDate(new Date());
  // Paused in the board's Settings (H4): read nothing, write nothing, and leave
  // the last-run date alone so the first run after un-pausing catches up.
  if (settings.paused) {
    const health: Health = { since: "", bridge: "paused", emails: sourceCounts(), rolesBySource: sourceCounts(), partial: 0, problems: ["Paused in Settings: no mail was read."], untrusted: [] };
    return { folder: "", judged: [], health, paused: true };
  }
  // G4 (Sprint 11): once part 2 has scored today's run (its digest exists), a second
  // mail read the same day would rewrite the scored run's files. It reads nothing and
  // leaves the last-run date alone, so tomorrow's read looks back far enough.
  const scoredFolder = path.join(settings.dataDir, "runs", today);
  if (!opts.force && isScored(scoredFolder)) {
    const health: Health = { since: "", bridge: "not run", emails: sourceCounts(), rolesBySource: sourceCounts(), partial: 0, problems: [`Today's run (${today}) is already scored, so nothing was read. Tomorrow's run picks up anything new; use --force to read again now.`], untrusted: [] };
    return { folder: scoredFolder, judged: [], health, alreadyScored: true };
  }
  const state = readJson<{ lastRun?: string; inboxLastRun?: string; history?: Array<{ date: string } & Record<string, number | string>> }>(
    path.join(settings.dataDir, "state.json"), {});
  const since = sinceDate(today, state.lastRun, opts.days ?? null, settings.sources.firstRunLookbackDays);

  const health: Health = { since, bridge: "not configured", emails: sourceCounts(), rolesBySource: sourceCounts(), partial: 0, problems: [], untrusted: [], notes: [], emailFiles: [] };
  if (settings.settingsProblem) health.problems.push(settings.settingsProblem);
  // G4: mornings with no run since the last one.
  const missed = missedDays(settings.dataDir, state.lastRun, today);
  if (missed.length) health.problems.push(`No run on ${missed.join(", ")}: the PC was off or asleep. Alerts from those days were read now; replies too.`);
  if (settings.credentialProblem) health.problems.push(settings.credentialProblem);
  const folder = path.join(settings.dataDir, "runs", today);
  fs.mkdirSync(folder, { recursive: true });
  // H14: email copies live in the private store on this PC, never in the run
  // folder the cloud can read. Older copies are moved there once, and copies
  // past the retention period are deleted.
  const store = path.join(settings.emailStore, today);
  const moved = moveOldCopies(settings.dataDir, settings.emailStore);
  const expired = expireCopies(settings.emailStore, today, settings.emailDays);
  health.notes!.push(`Copies of the emails read are kept only on this PC, in the private store, for ${settings.emailDays} days${moved ? `; ${moved} older cop${moved === 1 ? "y was" : "ies were"} moved there from the run folders` : ""}${expired ? `; ${expired} day${expired === 1 ? "'s" : "s'"} copies past that were deleted` : ""}.`);
  // H10: other people's words in old run folders (adverts, specs, reply
  // summaries) go after runDays, except for roles the owner applied for.
  try {
    health.notes!.push(pruneRuns(settings.dataDir, today, settings.runDays).note);
  } catch (err) {
    health.problems.push(`Old run folders could not be tidied (${(err as Error).message}); nothing else was affected.`);
  }

  // 1. Collect raw emails.
  const raws: Array<{ name: string; raw: string; inbox?: string; replySearch?: boolean }> = [];
  if (opts.bridge && settings.imap) {
    try {
      const msgs = await fetchMessages(settings.imap, settings.sources.senders.map((s) => s.from), new Date(since + "T00:00:00"));
      for (const m of msgs) raws.push({ name: `bridge-${m.uid}.eml`, raw: m.raw });
      health.bridge = `read ${msgs.length} email${msgs.length === 1 ? "" : "s"}`;
    } catch (err) {
      health.bridge = "failed";
      health.problems.push(`Proton Mail Bridge: ${(err as Error).message.replace(/\.?$/, ".")} Is Bridge running, and are BRIDGE_USER and BRIDGE_PASSWORD in .env the Bridge credentials (not your Proton password)? Nothing from this run is marked as seen, so the next run reads the same days again.`);
    }
  } else if (opts.bridge) {
    health.problems.push("Proton Mail Bridge is not set up yet (no BRIDGE_USER / BRIDGE_PASSWORD in .env), so only the .eml folder was read.");
  } else {
    health.bridge = "skipped (--no-bridge)";
  }
  // 1b. Replies to applications (I1, Sprint 6a): a second read-only search,
  // from the hiring systems and the companies and recruiters on the watch list.
  const watch = readWatchlist(path.join(settings.dataDir, "watchlist.json"));
  const replySenders = settings.sources.replySenders ?? [];
  const repliesOn = settings.sources.replies?.enabled === true && replySenders.length > 0;
  const firstLook = !state.inboxLastRun;
  const replySince = sinceDate(today, state.inboxLastRun, firstLook ? (settings.sources.replies?.firstLookDays ?? 60) : null, 60);
  let replyFetch: "not read" | "read" | "failed" = "not read";
  if (repliesOn) {
    if (watch.problem) health.notes!.push(watch.problem);
    if (opts.bridge && settings.imap && health.bridge !== "failed") {
      try {
        const known = new Set(raws.map((r) => r.name));
        const msgs = await fetchMessages(settings.imap, searchTerms(watch, replySenders), new Date(replySince + "T00:00:00"));
        for (const m of msgs) if (!known.has(`bridge-${m.uid}.eml`)) raws.push({ name: `reply-${m.uid}.eml`, raw: m.raw, replySearch: true });
        replyFetch = "read";
      } catch (err) {
        replyFetch = "failed";
        health.problems.push(`Replies could not be read from Bridge (${(err as Error).message}); the next run looks back over the same days.`);
      }
    }
  }
  fs.mkdirSync(settings.emlFolder, { recursive: true }); // so it is there to drop files into
  {
    for (const f of fs.readdirSync(settings.emlFolder).filter((f) => f.toLowerCase().endsWith(".eml")).sort()) {
      raws.push({ name: `file-${f}`, raw: fs.readFileSync(path.join(settings.emlFolder, f)).toString("latin1"), inbox: path.join(settings.emlFolder, f) });
    }
  }

  // 2. Parse. Keep a copy of each email in the private store, so a parsing
  //    mistake can be reproduced and fixed later (npm run share-email).
  let roles: Role[] = [];
  const replies: FoundReply[] = [];
  const seenIds = new Set<string>();
  fs.mkdirSync(store, { recursive: true });
  for (const { name, raw, replySearch } of raws) {
    const email = parseEmail(raw);
    if (email.messageId && seenIds.has(email.messageId)) continue;
    if (email.messageId) seenIds.add(email.messageId);
    // A reply (I1) is kept in the private store and listed for the reader; it
    // is never parsed for roles. Anything the reply search brought back that is
    // not a reply is not kept at all.
    const cand: Candidate | null = repliesOn ? replyCandidate(email, watch, replySenders) : null;
    if (cand) {
      if (email.date && email.date.slice(0, 10) < replySince && !name.startsWith("file-")) continue;
      fs.writeFileSync(path.join(store, name), raw, "latin1");
      health.emailFiles!.push(name);
      replies.push(foundReply(name, today, email, cand, firstLook));
      continue;
    }
    if (replySearch) continue;
    fs.writeFileSync(path.join(store, name), raw, "latin1");
    health.emailFiles!.push(name);
    if (email.date && email.date.slice(0, 10) < since && name.startsWith("bridge-")) continue;
    const { kind, roles: found, note } = rolesFrom(email);
    health.emails[kind as EmailKind]++;
    if (note) health.notes!.push(`${sourceName(kind)}, "${email.subject}": ${note}`);
    for (const r of found) {
      health.rolesBySource[r.source]++;
      if (r.parse === "partial") health.partial++;
    }
    // hackajob also sends tips and account notices, so an empty hackajob email
    // is normal; an empty LinkedIn alert means the layout has changed.
    if (kind !== "hackajob" && kind !== "other" && found.length === 0) health.problems.push(`No roles found in "${email.subject}" (${name}): the parser may need updating.`);
    roles.push(...found);
  }
  // Untrusted text (H2): cap it and remove lines that address an AI, before
  // anything reaches the scoring step. What was removed becomes a warning sign.
  const tainted = new Map<string, number>();
  roles = roles.map((r) => {
    const removed: Array<{ line: string; why: string }> = [];
    const clean = (text: string, max: number) => {
      const c = cleanUntrusted(text, max);
      removed.push(...c.removed);
      return c.text;
    };
    const out: Role = {
      ...r,
      title: clean(r.title, LIMITS.title),
      company: clean(r.company, LIMITS.company),
      location: clean(r.location, LIMITS.location),
      notes: r.notes.map((n) => clean(n, LIMITS.note)).filter((n) => n.trim() !== ""),
      excerpt: clean(r.excerpt, LIMITS.excerpt),
      // BUG-1 (found by the red team, RT10, 17 Oct 2026): the subject is kept on
      // the role and read by the cloud, so it is cleaned like every other field.
      email: { ...r.email, subject: clean(r.email.subject, LIMITS.title) },
    };
    if (removed.length) {
      tainted.set(r.id, removed.length);
      for (const x of removed) health.untrusted.push({ role: `${r.title || "?"}, ${r.company || "?"}`, line: x.line, why: x.why });
    }
    return out;
  });
  roles = mergeDuplicates(roles);

  // 3 and 4. De-duplicate, then filter.
  const trackerPath = path.join(settings.contextDir, "applications.md");
  let tracker: TrackerRow[] = [];
  if (fs.existsSync(trackerPath)) tracker = readTracker(fs.readFileSync(trackerPath, "utf8"));
  else health.problems.push(`Tracker not found at ${trackerPath}, so roles already applied for could not be removed.`);

  const seenPath = path.join(settings.dataDir, "seen.json");
  const seen = readJson<SeenStore>(seenPath, {});

  const judged: Judged[] = roles.map((role) => {
    const row = onTracker(role, tracker);
    if (row) return { role, verdict: known(`Already on the tracker: ${row.company}, ${row.role} (${row.status}).`), stage: "known" };
    const prior = seenBefore(role, seen, today);
    if (prior) {
      const why = prior.repost ? `Looks like a repost of a role first seen on ${prior.entry.firstSeen}.` : `Seen in an earlier run (${prior.entry.firstSeen}).`;
      return { role, verdict: known(why), stage: "known" };
    }
    const verdict = judge(role, settings.constraints, today);
    const n = tainted.get(role.id);
    if (n) verdict.warnings.push(`Instruction-like text was removed from the alert (${n} line${n === 1 ? "" : "s"}): treat this role's advert with care.`);
    return { role, verdict, stage: verdict.kept ? "score" : "dropped", ageDays: ageInDays(role, today) };
  });

  // Carry-over (C6): roles that cleared the threshold on an earlier day but
  // missed the cap. The scoring step writes data/carryover.json; each is offered
  // again until it has been carried carryOverMax times (two unless the board's
  // settings say otherwise), unless it is now on the tracker.
  const carryPath = path.join(settings.dataDir, "carryover.json");
  const carry = readJson<CarryEntry[]>(carryPath, []);
  for (const c of carry) {
    if (!c?.role?.id || (c.carries ?? 0) >= settings.carryOverMax || c.runDate >= today) continue;
    if (onTracker(c.role, tracker)) continue;
    const verdict = judge(c.role, settings.constraints, today);
    if (!verdict.kept) continue;
    const entry: Judged = { role: c.role, verdict, stage: "score", ageDays: ageInDays(c.role, today), carried: { from: c.runDate, score: c.score, carries: (c.carries ?? 0) + 1 } };
    const at = judged.findIndex((j) => j.role.id === c.role.id);
    if (at >= 0) judged[at] = entry;
    else judged.push(entry);
  }

  // Target employers (B13): marked, and put first so the scorer reads their
  // adverts before the per-run limit is reached. Order is otherwise unchanged.
  for (const j of judged) {
    const t = targetOf(j.role.company, settings.constraints);
    if (t) j.target = t;
  }
  judged.sort((a, b) => Number(!!b.target && b.stage === "score") - Number(!!a.target && a.stage === "score"));

  // Source health (B9): a source that has sent alerts before but sent none on
  // this run and the previous one is more likely broken than quiet.
  const history = (state.history ?? []).filter((h) => h.date !== today);
  const prev = history.at(-1);
  const sent = (h: Record<string, unknown> | undefined, src: string) => (typeof h?.[src] === "number" ? (h[src] as number) : 0);
  for (const { id: src, name } of SOURCES) {
    const everSent = history.some((h) => sent(h, src) > 0);
    if (health.emails[src] === 0 && prev && sent(prev, src) === 0 && everSent) {
      health.problems.push(`No ${name} emails for two runs in a row. Check the ${name} alerts are still switched on, and that Bridge is reading the folder they arrive in.`);
    }
  }
  const today_: { date: string } & Record<string, number | string> = { date: today };
  for (const { id } of SOURCES) today_[id] = health.emails[id];
  const nextHistory = [...history, today_].slice(-14);

  // BUG-9 (Sprint 11): replies found on an earlier morning but never read (the
  // reader was stopped, or failed) are carried into today's list, so they are not lost.
  if (repliesOn) {
    const carried = carryReplies(settings.dataDir, today, replies, settings.emailStore);
    if (carried.length) {
      replies.push(...carried);
      health.notes!.push(`Replies carried forward unread from earlier mornings: ${carried.length} (${[...new Set(carried.map((c) => c.carriedFrom))].join(", ")}).`);
    }
  }

  // 5. Write the run.
  if (repliesOn) {
    writeJson(path.join(folder, "replies", "found.json"), {
      date: today, since: replySince, firstLook, read: replyFetch,
      watch: { written: watch.written, entries: watch.entries.length },
      replies,
    });
    const by = (v: string) => replies.filter((r) => r.via === v).length;
    health.notes!.push(`Replies to applications: ${replies.length} found since ${replySince}${replies.length ? ` (hiring systems ${by("hiring-system")}, companies ${by("company")}, recruiters ${by("recruiter")}, LinkedIn ${by("linkedin")}; ${replies.filter((r) => !r.verified).length} unverified)` : ""}${firstLook ? "; this is the first look back, so every move will be a suggestion" : ""}. Only their sender domains are listed here; the emails stay in the private store.`);
  }
  fs.writeFileSync(path.join(folder, "roles.json"), JSON.stringify(judged, null, 2));
  fs.writeFileSync(path.join(folder, "candidates.json"), JSON.stringify(judged.filter((j) => j.stage === "score"), null, 2));
  const rules = settings.constraints.settingsVersion
    ? `${settings.constraints.version}, with the board's settings version ${settings.constraints.settingsVersion}`
    : settings.constraints.version;
  writeReport(path.join(folder, "run.md"), today, judged, health, rules);

  // A failed fetch must not lose mail (QA, 14 Oct 2026): when Bridge failed,
  // nothing is marked as seen and the last-run date and source history stay
  // as they were, so the next run looks back over the same days and the
  // scorer, which stops on a failed status, has lost nothing.
  const fetchFailed = health.bridge === "failed";
  if (!fetchFailed) {
    // H14 (N21): a file dropped in the inbox folder is read once, then kept
    // only in the private store, so it is not read again or left where the
    // cloud can see it.
    if (!settings.keepInboxFiles) {
      for (const r of raws) if (r.inbox && fs.existsSync(r.inbox)) fs.rmSync(r.inbox);
    }
    for (const { role } of judged) {
      seen[role.id] ??= { firstSeen: today, title: role.title, company: role.company };
    }
    writeJson(seenPath, seen);
    const inboxLastRun = repliesOn && replyFetch !== "failed" && (replyFetch === "read" || !opts.bridge || !settings.imap) ? today : state.inboxLastRun;
    writeJson(path.join(settings.dataDir, "state.json"), { ...state, lastRun: today, history: nextHistory, ...(inboxLastRun ? { inboxLastRun } : {}) });
  }
  // The audit trail (H7): what the code did, with which rules, in the day's ledger.
  const counts = { replies: replies.length, found: judged.length, score: judged.filter((j) => j.stage === "score").length, dropped: judged.filter((j) => j.stage === "dropped").length, known: judged.filter((j) => j.stage === "known").length, carried: judged.filter((j) => j.carried).length, target: judged.filter((j) => j.stage === "score" && j.target).length };
  const ledgerId = appendEntry(settings.dataDir, today, {
    agent: "scout", kind: "code", where: "pc", model: null, version: codeVersion(settings.root), at: new Date().toISOString(),
    instructions: Object.fromEntries(["constraints.json", "sources.json", "settings.json"].map((f) => [`config/${f}`, hashFile(path.join(f === "settings.json" ? path.join(settings.root, "config") : settings.configDir, f)) ?? "none"])),
    settingsVersion: settings.constraints.settingsVersion ?? null,
    inputs: { since, bridge: health.bridge, emails: health.emails },
    counts,
  });
  // E16 (Sprint 10): how fresh each pack is, from what it was built from. Read-only;
  // part 2 puts the result on Draft cards. A failure here never stops the run.
  try {
    writeJson(path.join(folder, "staleness.json"), checkAll(path.dirname(settings.contextDir), {
      today, staleAfterDays: staleAfterDays(path.join(settings.root, "config")), settingsVersion: settings.constraints.settingsVersion ?? null,
    }));
  } catch (e) {
    health.problems.push(`Pack staleness was not checked: ${(e as Error).message}`);
  }
  // The scoring step reads this first, so a failed fetch is reported rather than
  // mistaken for a quiet day (G1).
  writeJson(path.join(folder, "status.json"), {
    ledgerId,
    finished: new Date().toISOString(),
    bridge: health.bridge,
    ok: health.bridge !== "failed",
    settingsVersion: settings.constraints.settingsVersion ?? null,
    untrustedLinesRemoved: health.untrusted.length,
    credentialSource: settings.credentialSource,
    problems: health.problems,
    missed,
    counts,
    targets: settings.constraints.targets ?? null,
  });

  return { folder, judged, health };
}

function codeVersion(root: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function known(reason: string): Verdict {
  return { kept: false, reasons: [reason], flags: [], warnings: [], market: "unknown" };
}

/**
 * H14: move email copies left in data/runs/<date>/emails by versions before
 * 0.7.0 into the private store, and remove those folders. Returns how many.
 */
export function moveOldCopies(dataDir: string, storeRoot: string): number {
  const runs = path.join(dataDir, "runs");
  if (!fs.existsSync(runs)) return 0;
  let n = 0;
  for (const day of fs.readdirSync(runs)) {
    const old = path.join(runs, day, "emails");
    if (!fs.existsSync(old) || !fs.statSync(old).isDirectory()) continue;
    const to = path.join(storeRoot, day);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(old)) {
      fs.copyFileSync(path.join(old, f), path.join(to, f));
      n++;
    }
    fs.rmSync(old, { recursive: true, force: true });
  }
  return n;
}

/** H14: delete the store's day folders older than `days`. Returns how many days went. */
export function expireCopies(storeRoot: string, today: string, days: number): number {
  if (!fs.existsSync(storeRoot)) return 0;
  const cutoff = new Date(today + "T12:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const limit = cutoff.toISOString().slice(0, 10);
  let n = 0;
  for (const d of fs.readdirSync(storeRoot)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < limit) {
      fs.rmSync(path.join(storeRoot, d), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** One reply found (I1): no email text, only where it came from and hashes for threading. */
export interface FoundReply {
  id: string;
  /** BUG-9: the morning it was first found, when it was carried forward unread. */
  carriedFrom?: string;
  file: string;
  day: string;
  date: string;
  via: Candidate["via"];
  system: string | null;
  domain: string;
  cardIds: string[];
  verified: boolean;
  /** I9: matched only because the sender's domain is the company's name (never trusted to move a card or be learned). */
  byName?: boolean;
  firstLook: boolean;
  thread: { id: string; parents: string[] };
}

const h12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function foundReply(file: string, day: string, email: ReturnType<typeof parseEmail>, c: Candidate, firstLook: boolean): FoundReply {
  return {
    id: "r-" + h12(email.messageId || `${file}:${email.date}`),
    file, day, date: email.date,
    via: c.via, system: c.system, domain: c.domain, cardIds: c.cardIds, verified: c.verified, ...(c.byName ? { byName: true } : {}), firstLook,
    thread: { id: email.messageId ? h12(email.messageId) : "", parents: [email.inReplyTo ?? "", ...(email.references ?? [])].filter(Boolean).map(h12) },
  };
}

/** One line of data/carryover.json, written by the scoring step (SCOUT.md). */
export interface CarryEntry {
  role: Role;
  score: number;
  runDate: string;
  carries?: number;
}

/** Since the day before the last run (a day's overlap costs nothing: de-duplication catches it). */
export function sinceDate(today: string, lastRun: string | undefined, days: number | null, firstRunDays: number): string {
  const back = (d: string, n: number) => {
    const t = new Date(d + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() - n);
    return t.toISOString().slice(0, 10);
  };
  if (days !== null) return back(today, days);
  if (lastRun) return back(lastRun, 1);
  return back(today, firstRunDays);
}

/** G4: a run part 2 has scored. A digest written after a failed mail read (SCOUT.md step 1 asks
 *  for one, then a re-run) does not count, nor does one older than the run's status.json. */
export function isScored(folder: string): boolean {
  const digest = path.join(folder, "digest.md");
  const statusFile = path.join(folder, "status.json");
  if (!fs.existsSync(digest)) return false;
  if (!fs.existsSync(statusFile)) return true;
  const status = readJson<{ ok?: boolean }>(statusFile, {});
  if (status.ok === false) return false;
  return fs.statSync(digest).mtimeMs >= fs.statSync(statusFile).mtimeMs;
}

/** G4: the days after the last run and before today that have no run folder (at most 14). */
export function missedDays(dataDir: string, lastRun: string | undefined, today: string): string[] {
  if (!lastRun || !/^\d{4}-\d{2}-\d{2}$/.test(lastRun) || lastRun >= today) return [];
  const out: string[] = [];
  const d = new Date(`${lastRun}T12:00:00Z`);
  for (let i = 0; i < 60 && out.length < 14; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.toISOString().slice(0, 10);
    if (day >= today) break;
    if (!fs.existsSync(path.join(dataDir, "runs", day))) out.push(day);
  }
  return out;
}

const CARRY_DAYS = 7;
const CARRY_MAX = 20;

/** Replies found in the last week that part 2 has not yet acted on (BUG-9): their run's reader was
 *  stopped or failed, or they were read by hand after part 2 had scored the day. Acted on means
 *  listed in a `replies\\matched.json` as anything but unread. The week counts from the morning a
 *  reply was first found, and a reply whose email has left the private store is not carried. */
export function carryReplies(dataDir: string, today: string, already: FoundReply[], store?: string): FoundReply[] {
  const runs = path.join(dataDir, "runs");
  const start = new Date(`${today}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - CARRY_DAYS);
  const from = start.toISOString().slice(0, 10);
  let days: string[] = [];
  try { days = fs.readdirSync(runs).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d < today).sort(); } catch { return []; }
  const read = new Set<string>();
  const unread: FoundReply[] = [];
  for (const d of days) {
    const found = readJson<{ replies?: FoundReply[] }>(path.join(runs, d, "replies", "found.json"), {});
    const matched = readJson<{ items?: Array<{ replyId?: string; action?: string }> }>(path.join(runs, d, "replies", "matched.json"), {});
    for (const x of matched.items ?? []) if (x?.replyId && x.action !== "unread") read.add(x.replyId);
    for (const f of found.replies ?? []) if (f?.id && f.file && f.day) unread.push({ ...f, carriedFrom: f.carriedFrom ?? d });
  }
  const have = new Set(already.map((x) => x.id));
  const out: FoundReply[] = [];
  for (const f of unread) {
    if (read.has(f.id) || have.has(f.id) || (f.carriedFrom ?? "") < from) continue;
    if (store && !fs.existsSync(path.join(store, f.day, f.file))) continue;
    have.add(f.id);
    out.push(f);
    if (out.length >= CARRY_MAX) break;
  }
  return out;
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Run from the command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const daysAt = args.indexOf("--days");
  const opts: RunOptions = {
    bridge: !args.includes("--no-bridge"),
    days: daysAt >= 0 ? Number(args[daysAt + 1]) : undefined,
    force: args.includes("--force"),
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  run(loadSettings(root), opts)
    .then(({ folder, judged, health, paused, alreadyScored }) => {
      if (alreadyScored) {
        console.log(`Job Scout: ${health.problems[0]}`);
        return;
      }
      if (paused) {
        console.log("Job Scout is paused in the board's Settings: no mail was read. Un-pause it there; the next run catches up.");
        return;
      }
      const count = (s: string) => judged.filter((j) => j.stage === s).length;
      console.log(`Job Scout: looked back to ${health.since}. Bridge: ${health.bridge}.`);
      console.log(`Emails: ${SOURCES.map((s) => `${health.emails[s.id]} ${s.name}`).join(", ")}, ${health.emails.other} other.`);
      console.log(`Roles: ${judged.length} found, ${count("known")} already known, ${count("dropped")} dropped by the filters, ${count("score")} to score.`);
      for (const p of health.problems) console.log(`Problem: ${p}`);
      console.log(`Report: ${path.join(folder, "run.md")}`);
      if (count("score") > 0) console.log("Next: ask Claude to score today's Job Scout run.");
    })
    .catch((err) => {
      console.error(`Job Scout failed: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
