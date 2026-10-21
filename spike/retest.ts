// npm run spike:retest — the H5 model retest (Sprint 5c), run on the PC.
//
// The H13 spike tested two models on nine adverts and neither passed. This
// retest runs the real reader pipeline (gate, clean, extract with the tightened
// prompt, grounding check: src/reader/) over about 20 adverts, including more
// with published pay, for each model named or installed:
//
//   npm run spike:retest                        qwen2.5:14b, llama3.1:8b, qwen3:14b (those installed)
//   npm run spike:retest -- qwen2.5:14b gemma3:12b
//
// Adverts: the spike's own (data\spike\adverts\), plus other product roles from
// the job boards the spike found, preferring adverts that state pay. Saved to
// data\spike\retest\adverts\. Results: data\spike\retest-<date>.json and .md,
// which Claude grades against the adverts. Each model is unloaded after its turn.

import fs from "node:fs";
import path from "node:path";
import { spikeDir, today, writeJson } from "./common.ts";
import { textOf } from "../src/reader/text.ts";
import { gate, ground } from "../src/reader/check.ts";
import { extract, unload, available } from "../src/reader/model.ts";
import { cleanUntrusted } from "../src/untrusted.ts";
import { HOSTILE } from "./model.ts";

const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MODELS = ["qwen2.5:14b", "llama3.1:8b", "qwen3:14b"];
const UA = "JobScout/0.8 (personal job search; read-only)";

async function getJson(url: string): Promise<any> {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    return res.status === 200 ? await res.json() : null;
  } catch {
    return null;
  }
}

/** More product adverts from the boards the fetch spike found, pay-stating ones first. */
async function moreAdverts(dir: string, want: number): Promise<number> {
  const fetchFile = fs.readdirSync(spikeDir).filter((f) => /^fetch-.*\.json$/.test(f)).sort().at(-1);
  if (!fetchFile) return 0;
  const results = JSON.parse(fs.readFileSync(path.join(spikeDir, fetchFile), "utf8")).results as Array<{ attempts: Array<{ how: string; url: string; ok: boolean }> }>;
  const boards = [...new Set(results.flatMap((r) => r.attempts.filter((a) => a.ok && / API /.test(a.how)).map((a) => a.url)))];
  const found: Array<{ name: string; text: string; pay: boolean }> = [];
  for (const url of boards) {
    const j = await getJson(url);
    if (!j) continue;
    const jobs: Array<{ title: string; text: string }> = url.includes("greenhouse")
      ? (j.jobs ?? []).map((x: any) => ({ title: x.title, text: `${x.title}\n${x.location?.name ?? ""}\n${textOf(String(x.content ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))}` }))
      : url.includes("lever")
        ? (Array.isArray(j) ? j : []).map((x: any) => ({ title: x.text, text: [x.text, x.categories?.location, x.descriptionPlain, ...(x.lists ?? []).map((l: any) => `${l.text}\n${textOf(l.content ?? "")}`), x.additionalPlain, x.salaryRange ? `Salary: ${x.salaryRange.currency} ${x.salaryRange.min} to ${x.salaryRange.max} per ${x.salaryRange.interval}` : ""].filter(Boolean).join("\n") }))
        : url.includes("ashby")
          ? (j.jobs ?? []).map((x: any) => ({ title: x.title, text: [x.title, x.location, x.descriptionPlain ?? textOf(x.descriptionHtml ?? ""), x.compensation?.compensationTierSummary ? `Compensation: ${x.compensation.compensationTierSummary}` : ""].filter(Boolean).join("\n") }))
          : [];
    const slug = (/boards\/([^/]+)|postings\/([^/?]+)|job-board\/([^/?]+)/.exec(url) ?? []).slice(1).find(Boolean) ?? "board";
    for (const job of jobs.filter((x) => /product/i.test(x.title ?? "") && (x.text ?? "").length > 1500)) {
      found.push({ name: `${slug}-${String(job.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.txt`, text: `Source: ${slug}, ${job.title}\n\n${job.text}`, pay: /£|€|\$\s?\d|salary|compensation/i.test(job.text) });
    }
  }
  const pick = [...found.filter((f) => f.pay), ...found.filter((f) => !f.pay)].slice(0, want);
  for (const f of pick) fs.writeFileSync(path.join(dir, f.name), f.text.slice(0, 40000));
  return pick.length;
}

export async function main(): Promise<void> {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const installed = await available(OLLAMA);
  if (!installed) { console.error(`Ollama is not answering at ${OLLAMA}. Start it (as your own Windows account) and try again.`); process.exitCode = 1; return; }
  const has = (m: string) => installed.includes(m) || installed.includes(`${m}:latest`);
  const models = (asked.length ? asked : DEFAULT_MODELS).filter(has);
  const missing = (asked.length ? asked : DEFAULT_MODELS).filter((m) => !has(m));
  if (missing.length) console.log(`Not installed, so skipped: ${missing.join(", ")} (ollama pull <name> to include).`);
  if (!models.length) { process.exitCode = 1; return; }

  const dir = path.join(spikeDir, "retest", "adverts");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.join(spikeDir, "adverts")).filter((f) => f.endsWith(".txt"))) fs.copyFileSync(path.join(spikeDir, "adverts", f), path.join(dir, f));
  if (fs.readdirSync(dir).length < 20) console.log(`Fetched ${await moreAdverts(dir, 22 - fs.readdirSync(dir).length)} more adverts from the job boards.`);
  fs.writeFileSync(path.join(dir, "zz-hostile-test.txt"), `Source: test, Head of Product, Platform\n\n${HOSTILE}\n${"Acme Robotics builds developer platforms for robotics teams across Europe. ".repeat(20)}`);
  const adverts = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort().slice(0, 24).map((name) => {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const title = (/^Source: [^,]+, (.+)$/m.exec(raw)?.[1] ?? "").trim();
    return { name, title, text: raw.replace(/^Source:.*\n+/, "") };
  });

  const runs: unknown[] = [];
  for (const model of models) {
    console.log(`Model ${model}`);
    await extract(OLLAMA, model, "Product Manager, Example Ltd, London. Requirements: 5 years in product."); // load it
    for (const a of adverts) {
      const g = gate(a.text, a.title || "product");
      if (!g.ok) { runs.push({ model, advert: a.name, gate: g.reason }); console.log(`  ${a.name}: not read (${g.reason})`); continue; }
      const clean = cleanUntrusted(a.text, 40000);
      const x = await extract(OLLAMA, model, clean.text);
      const checked = x.spec ? ground(x.spec, clean.text) : null;
      runs.push({ model, advert: a.name, seconds: x.seconds, tokensPerSecond: x.tokensPerSecond, error: x.error, linesRemoved: clean.removed.length, raw: x.spec, grounded: checked?.spec ?? null, grounding: checked?.grounding ?? null });
      console.log(`  ${a.name}: ${x.error ? "FAILED " + x.error.slice(0, 60) : checked!.grounding.reliable ? "ok" : "unreliable"} in ${x.seconds.toFixed(1)}s`);
    }
    await unload(OLLAMA, model);
  }
  const out = { date: today(), models, adverts: adverts.map((a) => a.name), runs };
  writeJson(path.join(spikeDir, `retest-${out.date}.json`), out);
  const rows = models.map((m) => {
    const r = (runs as any[]).filter((x) => x.model === m && !x.gate);
    const ok = r.filter((x) => !x.error);
    const secs = ok.map((x) => x.seconds).sort((a: number, b: number) => a - b);
    const tps = ok.map((x) => x.tokensPerSecond).filter(Boolean).sort((a: number, b: number) => a - b);
    const dropped = ok.reduce((n: number, x: any) => n + (x.grounding?.mustHaves.dropped.length ?? 0), 0);
    return `| ${m} | ${ok.length} of ${r.length} | ${ok.filter((x: any) => x.grounding?.reliable).length} | ${dropped} | ${secs.length ? secs[Math.floor(secs.length / 2)].toFixed(1) : "-"} | ${tps.length ? tps[Math.floor(tps.length / 2)].toFixed(1) : "-"} |`;
  });
  fs.writeFileSync(path.join(spikeDir, `retest-${out.date}.md`), [`# H5 model retest, ${out.date}`, "", `${adverts.length} adverts (one a hostile test).`, "", "| Model | Answered | Passed the grounding check | Requirements dropped as not in the advert | Seconds per advert | Tokens a second |", "| --- | --- | --- | --- | --- | --- |", ...rows, "", "Claude grades each answer against its advert next (bar: 9 of 10 right on must-haves and pay, after the checks)."].join("\n"));
  console.log(`\nDone. Report: data\\spike\\retest-${out.date}.md`);
}

if (process.argv[1]?.endsWith("retest.ts")) main().catch((e) => { console.error(e); process.exitCode = 1; });
