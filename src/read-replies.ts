// npm run read-replies — the reply reader on the PC (backlog I2, Sprint 6a).
//
// The mail read (06:30) lists the replies it found in
// data/runs/<date>/replies/found.json and keeps the emails in the private
// store. This, run straight after the advert reader at 07:45 (or on its own),
// reads each one with the local model, checks what it says against the
// email's own words, and writes data/runs/<date>/replies/summary.json for part
// 2 (08:10) to match and act on. No email text leaves the PC beyond a short
// quoted ask; nothing is replied to, accepted or opened.
//
// Options: --date YYYY-MM-DD (default today)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { parseEmail } from "./mime.ts";
import { htmlToText } from "./html.ts";
import { cleanUntrusted } from "./untrusted.ts";
import { appendEntry } from "./ledger.ts";
import { available, chat, unload } from "./reader/model.ts";
import type { Fetch } from "./reader/fetch.ts";
import { codeWarnings, groundReply, parseIcs, REPLY_SCHEMA, REPLY_SYSTEM, type CalendarEvent, type GroundedReply, type ModelReply } from "./reader/reply.ts";
import type { FoundReply } from "./scout.ts";
import { localDate } from "./scout.ts";

export interface ReplyRecord extends Omit<FoundReply, "file" | "day"> {
  status: "ok" | "partial" | "failed" | "missing";
  reason: string | null;
  model: string | null;
  read: GroundedReply | null;
  calendar: CalendarEvent | null;
  links: boolean;
  warnings: string[];
  untrusted: string[];
  seconds: number | null;
}

export interface RepliesSummary {
  date: string;
  status: "done" | "paused" | "disabled" | "none found" | "stopped";
  model: string;
  firstLook: boolean;
  grade: { passed: boolean; date: string | null; right: number | null; of: number | null } ;
  counts: Record<string, number>;
  /** G11 (Sprint 10): the local model's tokens read and written, as Ollama reports them. */
  tokens?: { in: number; out: number };
  replies: ReplyRecord[];
  warnings: string[];
  ledgerId: string | null;
}

export interface ReplyOptions { today?: string; fetchFn?: Fetch }

export async function readReplies(settings: Settings, opts: ReplyOptions = {}): Promise<RepliesSummary> {
  const today = opts.today ?? localDate(new Date());
  const r = settings.reader;
  const folder = path.join(settings.dataDir, "runs", today, "replies");
  const grade = readGrade(settings.dataDir, r.model);
  const blank = (status: RepliesSummary["status"], warnings: string[] = []): RepliesSummary => ({ date: today, status, model: r.model, firstLook: false, grade, counts: {}, replies: [], warnings, ledgerId: null });
  if (settings.paused) return blank("paused", ["Paused in Settings: no reply was read."]);
  const foundFile = path.join(folder, "found.json");
  if (!fs.existsSync(foundFile)) return blank("none found");
  const found = JSON.parse(fs.readFileSync(foundFile, "utf8")) as { firstLook: boolean; replies: FoundReply[] };
  if (!found.replies?.length) return write(folder, { ...blank("done"), firstLook: !!found.firstLook });

  const warnings: string[] = [];
  const installed = await available(settings.ollamaHost, opts.fetchFn);
  const modelReady = !!installed && (installed.includes(r.model) || installed.includes(`${r.model}:latest`));
  if (!installed) warnings.push(`Ollama is not answering at ${settings.ollamaHost}: no reply was read on the PC, so none can move a card today.`);
  else if (!modelReady) warnings.push(`The model in Settings (${r.model}) is not installed: run "ollama pull ${r.model}".`);
  if (!r.enabled) warnings.push("The local reader is switched off in Settings, so replies are listed but not read.");

  const records: ReplyRecord[] = [];
  const tokens = { in: 0, out: 0 };
  for (const f of found.replies.slice(0, 50)) {
    const { file, day, ...rest } = f;
    const rec: ReplyRecord = { ...rest, status: "missing", reason: null, model: null, read: null, calendar: null, links: false, warnings: [], untrusted: [], seconds: null };
    records.push(rec);
    const src = path.join(settings.emailStore, day, file);
    if (!fs.existsSync(src)) { rec.reason = "the email is no longer in the private store"; continue; }
    const email = parseEmail(fs.readFileSync(src).toString("latin1"));
    const body = (email.text || htmlToText(email.html)).trim();
    const whole = `Subject: ${email.subject}\nFrom: ${email.from}\n\n${body}`;
    rec.links = /https?:\/\//i.test(body);
    rec.calendar = parseIcs(email.calendar ?? "");
    rec.warnings.push(...codeWarnings(whole));
    const clean = cleanUntrusted(whole, 12_000);
    rec.untrusted = clean.removed.map((x) => x.line.slice(0, 160));
    if (clean.removed.length) rec.warnings.push(`instruction-like text removed (${clean.removed.length} line${clean.removed.length === 1 ? "" : "s"})`);
    if (!r.enabled || !modelReady) { rec.status = "failed"; rec.reason = "the local model was not available"; continue; }
    const x = await chat<ModelReply>(settings.ollamaHost, r.model, REPLY_SYSTEM, `<<<EMAIL\n${clean.text}\nEMAIL>>>`, REPLY_SCHEMA, opts.fetchFn);
    rec.model = r.model;
    rec.seconds = x.seconds;
    tokens.in += x.tokensIn ?? 0; tokens.out += x.tokensOut ?? 0;
    if (!x.value || typeof x.value.type !== "string") { rec.status = "failed"; rec.reason = x.error ?? "the model's answer did not have the expected shape"; continue; }
    const g = groundReply(x.value, clean.text, email.date);
    if (x.value.suspectedInjection) {
      const lines = (x.value.injectionLines ?? []).filter((l) => typeof l === "string" && clean.text.toLowerCase().includes(l.toLowerCase().slice(0, 40)));
      if (lines.length && !rec.untrusted.length) rec.warnings.push("the model saw instruction-like text");
      rec.untrusted.push(...lines.map((l) => l.slice(0, 160)));
    }
    rec.read = g;
    rec.status = g.partial ? "partial" : "ok";
    rec.reason = g.partial ? `not found in the email: ${g.dropped.join("; ")}`.slice(0, 280) : null;
  }
  if (modelReady && r.enabled) await unload(settings.ollamaHost, r.model, opts.fetchFn);

  const counts: Record<string, number> = { listed: records.length };
  for (const rec of records) {
    counts[rec.status] = (counts[rec.status] ?? 0) + 1;
    if (rec.read) counts[rec.read.type] = (counts[rec.read.type] ?? 0) + 1;
  }
  const ledgerId = appendEntry(settings.dataDir, today, {
    agent: "reply-reader", kind: "ai", where: "pc", model: r.model, version: null, at: new Date().toISOString(),
    instructions: {}, settingsVersion: settings.constraints.settingsVersion ?? null,
    inputs: { listed: records.length, firstLook: !!found.firstLook, gradePassed: grade.passed }, counts,
  });
  return write(folder, { date: today, status: "done", model: r.model, firstLook: !!found.firstLook, grade, counts, tokens, replies: records, warnings, ledgerId });
}

/** The grading result (Q6): moves are only made once the model has passed, and only on replies graded after that. */
export function readGrade(dataDir: string, model?: string): RepliesSummary["grade"] {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(dataDir, "replies-grade.json"), "utf8"));
    // A pass is for the model that was graded: a new model starts with suggestions again.
    const sameModel = !model || g.model === model;
    return { passed: g.passed === true && sameModel, date: g.date ?? null, right: g.right ?? null, of: g.of ?? null };
  } catch {
    return { passed: false, date: null, right: null, of: null };
  }
}

function write(folder: string, s: RepliesSummary): RepliesSummary {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "summary.json"), JSON.stringify(s, null, 2));
  return s;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--date");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  readReplies(loadSettings(root), { today: at >= 0 ? args[at + 1] : undefined })
    .then((s) => {
      const n = (k: string) => s.counts[k] ?? 0;
      console.log(`Job Scout replies, ${s.date}: ${s.status}. ${s.replies.length} read: ${n("rejection")} rejections, ${n("invitation")} invitations, ${n("assessment")} assessments, ${n("offer")} offers, ${n("request")} requests, ${n("follow-up")} follow-ups, ${n("other")} other; ${n("partial")} partial, ${n("failed")} failed.`);
      for (const w of s.warnings) console.log(`Note: ${w}`);
    })
    .catch((err) => { console.error(`Job Scout replies failed: ${(err as Error).message}`); process.exitCode = 1; });
}
