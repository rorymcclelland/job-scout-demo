// npm run eval:reader: the reader's evaluation (backlog H8, Sprint 7), on the PC.
//
// Runs the real reader pipeline (closed notice, gate, clean, extract with the
// local model, grounding check) over the evaluation adverts and scores each
// answer against its checked answer. Run it before changing the model or the
// reader's prompt, and whenever the morning run warns that the model's digest
// has changed.
//
//   npm run eval:reader                       the model in Settings
//   npm run eval:reader -- --model qwen3:14b  another installed model
//   npm run eval:reader -- --repeat 3         the whole set three times, to see
//                                             how much the answers vary (H19)
//   npm run eval:reader -- --saved <file>     score answers saved by the H5
//                                             retest (data\spike\retest-*.json)
//                                             without running a model
//
// The set lives in the vault: _context\job-scout\eval\reader\expected.json
// and adverts\. Results: data\eval\reader-<date>-<model>.json and
// data\eval\reader-latest.json, which the full evaluation (EVAL.md) reads.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { closedNotice, gate, ground } from "./reader/check.ts";
import { available, extract, modelDigest, ollamaVersion, unload } from "./reader/model.ts";
import { scoreReader, type ExpectedAdvert, type ReaderAnswer, type ReaderScore } from "./reader/eval.ts";
import { cleanUntrusted } from "./untrusted.ts";
import { localDate } from "./scout.ts";
import type { Fetch } from "./reader/fetch.ts";

export interface ReaderEval extends ReaderScore {
  date: string;
  model: string;
  digest: string | null;
  /** H19: the Ollama runtime version the answers came from. */
  ollama?: string | null;
  set: string;
  /** The model whose graded answers the checked requirements came from. */
  checkedWith: string | null;
  source: "model" | "saved";
  /** Lines the code removed before the model saw them (the hostile advert). */
  linesRemoved: number;
  medianSeconds: number | null;
  bar: number;
  passed: boolean;
  /** H19: with --repeat, each run's figure, and the adverts whose verdict changed between runs. */
  runs?: Array<{ right: number; of: number }>;
  unstable?: string[];
}

export function evalDir(s: Settings): string {
  return path.join(s.contextDir, "job-scout", "eval", "reader");
}

export function loadSet(dir: string): { set: string; checkedWith: string | null; adverts: ExpectedAdvert[] } {
  const j = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
  return { set: String(j.set ?? "reader set"), checkedWith: typeof j.checkedWith === "string" ? j.checkedWith : null, adverts: j.adverts as ExpectedAdvert[] };
}

/** The reader's steps, exactly as the morning run takes them, on text already on disk. */
export async function readOne(s: Settings, model: string, name: string, raw: string, fetchFn?: Fetch): Promise<ReaderAnswer & { seconds: number | null; removed: number }> {
  const title = (/^Source: [^,]+, (.+)$/m.exec(raw)?.[1] ?? "product").trim();
  const text = raw.replace(/^Source:.*\n+/, "");
  if (closedNotice(text)) return { advert: name, status: "closed", spec: null, seconds: null, removed: 0 };
  const g = gate(text, title || "product");
  if (!g.ok) return { advert: name, gate: g.reason ?? "not an advert", spec: null, seconds: null, removed: 0 };
  const clean = cleanUntrusted(text, 40_000);
  const x = await extract(s.ollamaHost, model, clean.text, fetchFn);
  if (!x.spec) return { advert: name, error: x.error ?? "no answer", spec: null, seconds: x.seconds, removed: clean.removed.length };
  return { advert: name, spec: ground(x.spec, clean.text).spec, seconds: x.seconds, removed: clean.removed.length };
}

export async function evalReader(s: Settings, opts: { model?: string; saved?: string; today?: string; fetchFn?: Fetch; repeat?: number } = {}): Promise<ReaderEval | { problem: string }> {
  const today = opts.today ?? localDate(new Date());
  const dir = evalDir(s);
  if (!fs.existsSync(path.join(dir, "expected.json"))) return { problem: `No evaluation set at ${dir}\\expected.json.` };
  const { set, checkedWith, adverts } = loadSet(dir);
  const model = opts.model ?? s.reader.model;
  let answers: ReaderAnswer[] = [];
  let digest: string | null = null;
  let runtime: string | null = null;
  const runs: Array<{ right: number; of: number }> = [];
  const verdicts = new Map<string, Set<boolean>>();
  let removed = 0;
  const secs: number[] = [];
  if (opts.saved) {
    const j = JSON.parse(fs.readFileSync(opts.saved, "utf8"));
    answers = (j.runs as Array<{ model: string; advert: string; gate?: string; error?: string; grounded?: ReaderAnswer["spec"]; linesRemoved?: number }>)
      .filter((x) => x.model === model)
      .map((x) => { removed += x.linesRemoved ?? 0; return { advert: x.advert, gate: x.gate ?? null, error: x.error ?? null, spec: x.grounded ?? null }; });
    if (!answers.length) return { problem: `No saved answers from ${model} in ${opts.saved}.` };
  } else {
    const installed = await available(s.ollamaHost, opts.fetchFn);
    if (!installed) return { problem: `Ollama is not answering at ${s.ollamaHost}. Start it (as your own Windows account) and try again.` };
    if (!installed.includes(model) && !installed.includes(`${model}:latest`)) return { problem: `${model} is not installed: run "ollama pull ${model}".` };
    digest = await modelDigest(s.ollamaHost, model, opts.fetchFn);
    runtime = await ollamaVersion(s.ollamaHost, opts.fetchFn);
    const asked = opts.repeat ?? 1;
    if (!Number.isFinite(asked) || asked < 1) return { problem: `--repeat needs a number from 1 to 5 (got ${opts.repeat}).` };
    const times = Math.min(5, Math.floor(asked));
    for (let n = 1; n <= times; n++) {
      if (times > 1) console.log(`Run ${n} of ${times}`);
      answers = [];
      removed = 0;
      for (const a of adverts) {
        const file = path.join(dir, "adverts", a.advert);
        if (!fs.existsSync(file)) continue; // reported as missing by the score
        const got = await readOne(s, model, a.advert, fs.readFileSync(file, "utf8"), opts.fetchFn);
        removed += got.removed;
        if (got.seconds !== null) secs.push(got.seconds);
        answers.push(got);
        console.log(`  ${a.advert}: ${got.gate ? "refused by the gate" : got.status === "closed" ? "closed" : got.error ? "FAILED" : "read"}`);
      }
      const one = scoreReader(adverts, answers);
      runs.push({ right: one.right, of: one.of });
      const bad = new Set(one.wrong.map((w) => w.advert));
      for (const a of adverts) { if (!verdicts.has(a.advert)) verdicts.set(a.advert, new Set()); verdicts.get(a.advert)!.add(!bad.has(a.advert)); }
    }
    await unload(s.ollamaHost, model, opts.fetchFn);
  }
  const score = scoreReader(adverts, answers);
  const bar = 0.9;
  secs.sort((a, b) => a - b);
  const unstable = [...verdicts].filter(([, v]) => v.size > 1).map(([k]) => k);
  const allPass = runs.every((r) => r.of > 0 && r.right / r.of >= 0.9);
  const result: ReaderEval = {
    ...score, date: today, model, digest, ollama: runtime, set, checkedWith, source: opts.saved ? "saved" : "model", linesRemoved: removed,
    medianSeconds: secs.length ? Math.round(secs[Math.floor(secs.length / 2)] * 10) / 10 : null,
    bar, passed: score.of > 0 && score.right / score.of >= bar && score.missing.length === 0 && allPass,
    ...(runs.length > 1 ? { runs, unstable } : {}),
  };
  const out = path.join(s.dataDir, "eval");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `reader-${today}-${model.replace(/[^a-z0-9.]+/gi, "-")}.json`), JSON.stringify(result, null, 2));
  if (model === s.reader.model) fs.writeFileSync(path.join(out, "reader-latest.json"), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const val = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  evalReader(loadSettings(root), { model: val("--model"), saved: val("--saved"), repeat: val("--repeat") ? Number(val("--repeat")) : undefined })
    .then((r) => {
      if ("problem" in r) { console.log(r.problem); process.exitCode = 1; return; }
      console.log(`\nReader evaluation, ${r.date}: ${r.model}${r.digest ? ` (digest ${r.digest.slice(0, 12)})` : ""}${r.ollama ? `, Ollama ${r.ollama}` : ""}: ${r.right} of ${r.of} right (${r.rate}%), bar 9 in 10: ${r.passed ? "PASSED" : "NOT PASSED"}.`);
      if (r.runs) console.log(`Runs: ${r.runs.map((x) => `${x.right} of ${x.of}`).join(", ")}. Verdict changed between runs for: ${r.unstable?.length ? r.unstable.join(", ") : "none"}.`);
      console.log(`Refused by the gate as expected: ${r.refusedAsExpected}. Instruction lines removed before the model saw them: ${r.linesRemoved}.`);
      for (const w of r.wrong) {
        console.log(`  ${w.advert}: ${w.problems.join("; ")}`);
        if (w.got) console.log(`    the model's requirements: ${w.got.map((g) => `"${g.slice(0, 90)}"`).join(" | ")}`);
      }
      if (r.missing.length) console.log(`  Missing from the set's adverts folder: ${r.missing.join(", ")}`);
      if (!r.passed && r.checkedWith && r.model !== r.checkedWith) console.log("A different model may word requirements differently from the checked answers: ask Claude to grade the misses before deciding (EVAL.md).");
    })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
