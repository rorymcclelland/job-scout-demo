// npm run read-adverts — the advert reader on the PC (backlog H5b, Sprint 5c).
//
// The morning run (part 1, in the cloud) finds where each advert is published
// and writes data/runs/<date>/advert-urls.json. This, run by the Windows task
// "Job Scout reader" at 07:45, then for each address:
//
//   1. fetches the advert, politely and read-only (fetch.ts; never LinkedIn);
//   2. refuses pages without enough readable advert text (gate);
//   3. removes instruction-like lines (untrusted.ts);
//   4. has the local model, with no tools, copy the facts into a fixed shape;
//   5. keeps only the requirements and pay found in the advert's own words (ground);
//   6. writes specs/<id>.json and the cleaned advert to adverts/<id>.md.
//
// Then it unloads the model, so the graphics card can sleep, records its step
// in the ledger (H7), and writes specs/summary.json for the morning run's part
// 2. Nothing is sent anywhere but the advert sites and Ollama on this PC.
//
// Options: --date YYYY-MM-DD (default today), --no-wait

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { cleanUntrusted } from "./untrusted.ts";
import { appendEntry } from "./ledger.ts";
import { Fetcher, forbidden, type Fetch } from "./reader/fetch.ts";
import { closedNotice, gate, ground, type Grounding, type Spec } from "./reader/check.ts";
import { available, extract, modelDigest, ollamaVersion, unload } from "./reader/model.ts";
import { checkDigest } from "./reader/pin.ts";
import { localDate } from "./scout.ts";
import { readReplies } from "./read-replies.ts";

export interface SpecRecord {
  id: string;
  url: string;
  status: "ok" | "unreliable" | "not-readable" | "closed" | "failed";
  reason: string | null;
  via: string | null;
  model: string | null;
  chars: number;
  linesRemoved: number;
  seconds: number | null;
  spec: Spec | null;
  grounding: Grounding | null;
  readAt: string;
}

export interface ReaderSummary {
  date: string;
  status: "done" | "paused" | "disabled" | "no list";
  model: string;
  /** H8: the model's digest, so a change made by Ollama is seen. */
  modelDigest?: string | null;
  /** H19: the Ollama runtime version, since a new runtime can change answers from the same model. */
  ollamaVersion?: string | null;
  /** G9: adverts left for part 2 because the model was running too slowly. */
  skippedSlow?: number;
  useForScoring: boolean;
  counts: { listed: number; ok: number; unreliable: number; notReadable: number; closed: number; failed: number };
  medianSeconds: number | null;
  medianTokensPerSecond: number | null;
  warnings: string[];
  ledgerId: string | null;
}

export interface ReadOptions { today?: string; fetchFn?: Fetch; waitMs?: number; pollMs?: number; gapMs?: number }

/** G9: below this speed the model is on the processor; one advert there takes minutes. */
export const SLOW_TPS = 15;

export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "-");
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export async function readAdverts(settings: Settings, opts: ReadOptions = {}): Promise<ReaderSummary> {
  const today = opts.today ?? localDate(new Date());
  const r = settings.reader;
  const blank = (status: ReaderSummary["status"], warnings: string[] = []): ReaderSummary => ({ date: today, status, model: r.model, useForScoring: r.useForScoring, counts: { listed: 0, ok: 0, unreliable: 0, notReadable: 0, closed: 0, failed: 0 }, medianSeconds: null, medianTokensPerSecond: null, warnings, ledgerId: null });
  if (settings.paused) return blank("paused", ["Paused in Settings: nothing was read."]);
  if (!r.enabled) return blank("disabled", ["The reader is switched off in Settings."]);

  const folder = path.join(settings.dataDir, "runs", today);
  const listFile = path.join(folder, "advert-urls.json");
  const deadline = Date.now() + (opts.waitMs ?? r.waitMinutes * 60_000);
  while (!fs.existsSync(listFile) && Date.now() < deadline) await new Promise((res) => setTimeout(res, opts.pollMs ?? 60_000));
  if (!fs.existsSync(listFile)) return writeSummary(folder, blank("no list", [`No list of advert addresses for ${today}: the morning run's first part has not run, or found none.`]));

  let list: Array<{ id: string; url: string }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(listFile, "utf8"));
    list = (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x.id === "string" && typeof x.url === "string").slice(0, 60);
  } catch { /* an unreadable list is treated as empty, and said so */ }
  const titles = new Map<string, string>();
  try {
    for (const c of JSON.parse(fs.readFileSync(path.join(folder, "candidates.json"), "utf8"))) titles.set(c.role.id, c.role.title);
  } catch { /* titles fall back to the spec's */ }

  const warnings: string[] = [];
  const installed = await available(settings.ollamaHost, opts.fetchFn);
  const modelReady = !!installed && (installed.includes(r.model) || installed.includes(`${r.model}:latest`));
  if (!installed) warnings.push(`Ollama is not answering at ${settings.ollamaHost}: no advert was read on the PC. Start Ollama (as your own Windows account).`);
  else if (!modelReady) warnings.push(`The model in Settings (${r.model}) is not installed: run "ollama pull ${r.model}".`);
  const digest = modelReady ? await modelDigest(settings.ollamaHost, r.model, opts.fetchFn) : null;
  const runtime = modelReady ? await ollamaVersion(settings.ollamaHost, opts.fetchFn) : null;
  const pin = checkDigest(settings.dataDir, r.model, digest, today, runtime);
  if (pin.warning) warnings.push(pin.warning);

  const fetcher = new Fetcher(opts.fetchFn, opts.gapMs ?? 1000);
  fs.mkdirSync(path.join(folder, "specs"), { recursive: true });
  fs.mkdirSync(path.join(folder, "adverts"), { recursive: true });
  const records: SpecRecord[] = [];
  const speeds: number[] = [];
  let slow: number | null = null; // G9: set once the model is seen running on the processor
  for (const { id, url } of list) {
    const rec: SpecRecord = { id, url, status: "not-readable", reason: null, via: null, model: null, chars: 0, linesRemoved: 0, seconds: null, spec: null, grounding: null, readAt: new Date().toISOString() };
    records.push(rec);
    const no = forbidden(url);
    if (no) { rec.reason = no; continue; }
    if (!modelReady) { rec.status = "failed"; rec.reason = "the local model was not available"; continue; }
    if (slow !== null) { rec.status = "failed"; rec.reason = `skipped: the local model was running at about ${Math.round(slow)} tokens a second (on the processor, not the graphics card), so this advert is left for part 2 to read in the cloud`; continue; }
    const got = await fetcher.advert(url);
    rec.via = got.via;
    if (!got.ok) { rec.reason = got.reason ?? "not fetched"; continue; }
    const title = titles.get(id) ?? "";
    const gone = closedNotice(got.text);
    if (gone) { rec.status = "closed"; rec.reason = `the advert says the job is closed: "${gone}"`; rec.chars = got.text.length; continue; }
    const g = gate(got.text, title || "product");
    if (!g.ok) { rec.reason = g.reason ?? "not an advert"; rec.chars = got.text.length; continue; }
    const clean = cleanUntrusted(got.text, 40_000);
    rec.chars = clean.text.length;
    rec.linesRemoved = clean.removed.length;
    fs.writeFileSync(path.join(folder, "adverts", `${safeId(id)}.md`), `Source: ${url}\nRead on the PC: ${today}, via ${got.via}\nNote: the advert's own text, with any instruction-like lines removed${clean.truncated ? " and cut at 40,000 characters" : ""}.\n\n<<<ADVERT ${id}\n${clean.text}\nADVERT>>>\n`);
    const x = await extract(settings.ollamaHost, r.model, clean.text, opts.fetchFn);
    rec.model = r.model;
    rec.seconds = x.seconds;
    if (x.tokensPerSecond) speeds.push(x.tokensPerSecond);
    if (x.tokensPerSecond !== null && x.tokensPerSecond < SLOW_TPS) slow = x.tokensPerSecond;
    if (!x.spec || !wellFormed(x.spec)) { rec.status = "failed"; rec.reason = x.error ?? "the model's answer did not have the expected shape"; continue; }
    const { spec, grounding } = ground(x.spec, clean.text);
    if (clean.removed.length) {
      spec.suspectedInjection = true;
      spec.injectionLines = [...spec.injectionLines, ...clean.removed.map((l) => l.line)].slice(0, 5);
    }
    rec.spec = spec;
    rec.grounding = grounding;
    rec.status = grounding.reliable ? "ok" : "unreliable";
    rec.reason = grounding.reliable ? null : `only ${grounding.mustHaves.kept} of ${grounding.mustHaves.kept + grounding.mustHaves.dropped.length} requirements were found in the advert's own words`;
  }
  for (const rec of records) fs.writeFileSync(path.join(folder, "specs", `${safeId(rec.id)}.json`), JSON.stringify(rec, null, 2));
  if (modelReady) await unload(settings.ollamaHost, r.model, opts.fetchFn);

  const tps = median(speeds);
  const skippedSlow = records.filter((x) => x.reason?.startsWith("skipped: the local model was running")).length;
  if (tps !== null && tps < SLOW_TPS) warnings.push(`The model ran at about ${Math.round(tps)} tokens a second: it is on the processor rather than the graphics card.${skippedSlow ? ` The reader stopped after the first advert and left ${skippedSlow} for part 2 to read in the cloud.` : ""} Check the graphics mode is Standard and that Ollama's log names the graphics card (library=CUDA), then restart Ollama (docs\\RUNBOOK.md).`);
  const count = (s: SpecRecord["status"]) => records.filter((x) => x.status === s).length;
  const counts = { listed: records.length, ok: count("ok"), unreliable: count("unreliable"), notReadable: count("not-readable"), closed: count("closed"), failed: count("failed") };
  const ledgerId = appendEntry(settings.dataDir, today, {
    agent: "reader", kind: "ai", where: "pc", model: r.model, version: digest ? `sha256:${digest.slice(0, 12)}` : null, at: new Date().toISOString(),
    instructions: {}, settingsVersion: settings.constraints.settingsVersion ?? null,
    inputs: { listed: records.length, useForScoring: r.useForScoring }, counts,
  });
  return writeSummary(folder, { date: today, status: "done", model: r.model, modelDigest: digest, ollamaVersion: runtime, skippedSlow, useForScoring: r.useForScoring, counts, medianSeconds: median(records.filter((x) => x.seconds !== null).map((x) => x.seconds!)), medianTokensPerSecond: tps, warnings, ledgerId });
}

function wellFormed(s: Spec): boolean {
  return !!s && typeof s === "object" && Array.isArray(s.mustHaves) && Array.isArray(s.niceToHaves) && Array.isArray(s.injectionLines) && typeof s.suspectedInjection === "boolean" && s.mustHaves.every((m) => typeof m === "string");
}

function writeSummary(folder: string, s: ReaderSummary): ReaderSummary {
  fs.mkdirSync(path.join(folder, "specs"), { recursive: true });
  fs.writeFileSync(path.join(folder, "specs", "summary.json"), JSON.stringify(s, null, 2));
  return s;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--date");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  readAdverts(loadSettings(root), { today: at >= 0 ? args[at + 1] : undefined, waitMs: args.includes("--no-wait") ? 0 : undefined })
    .then((s) => {
      console.log(`Job Scout reader, ${s.date}: ${s.status}. ${s.counts.ok} read, ${s.counts.unreliable} unreliable, ${s.counts.notReadable} not readable, ${s.counts.closed} closed, ${s.counts.failed} failed, of ${s.counts.listed}. Model ${s.model}${s.medianSeconds !== null ? `, about ${Math.round(s.medianSeconds)} s an advert` : ""}.`);
      for (const w of s.warnings) console.log(`Note: ${w}`);
    })
    .catch((err) => { console.error(`Job Scout reader failed: ${(err as Error).message}`); process.exitCode = 1; })
    // Sprint 6a (I2): then the replies to applications, whatever happened to the adverts.
    .then(() => readReplies(loadSettings(root), { today: at >= 0 ? args[at + 1] : undefined }))
    .then((s) => { if (s) console.log(`Replies: ${s.status}, ${s.replies.length} read.${s.warnings.length ? " " + s.warnings.join(" ") : ""}`); })
    .catch((err) => { console.error(`Job Scout replies failed: ${(err as Error).message}`); process.exitCode = 1; });
}
