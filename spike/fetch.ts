// npm run spike:fetch — H13 question 3: how many adverts can the PC read itself?
//
// For the roles in the last two scored runs, it tries, politely and read-only:
//   1. the public job-board APIs (Greenhouse, Lever, Ashby, Workable), guessing
//      the company's board name from its name;
//   2. the address the morning run read the advert from (in adverts\*.md),
//      classed as a job board, a company site or an aggregator, checking
//      robots.txt first;
//   3. Google's and Microsoft's careers pages and Microsoft's job-search API
//      (N20: can the PC see Microsoft's full list, not just the email's three?).
// LinkedIn is never fetched. One request a second. Full advert texts it finds
// are saved to data\spike\adverts\ for the model test (npm run spike:model).
// Writes data\spike\fetch-<date>.json and .md. Sends nothing anywhere else.

import fs from "node:fs";
import path from "node:path";
import { dataDir, spikeDir, textOf, titleOverlap, today, writeJson } from "./common.ts";

const UA = "JobScout/0.6 (personal job search; read-only)";
const AGGREGATORS = /builtin|pitchme|grizzlypeak|arbeitnow|otta|welcometothejungle|glassdoor|indeed|jobgether|remoterocketship|himalayas|totaljobs|reed\.co|cv-library|adzuna|simplyhired|ziprecruiter|jooble|talent\.com|wellfound|workingnomads|weworkremotely|remotive|startup\.jobs|jobleads|efinancialcareers/i;
const JOB_BOARDS = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|teamtailor\.com|recruitee\.com|personio\.|bamboohr\.com|eightfold\.ai/i;

export interface Role { id: string; company: string; title: string; source: string; url: string; advertFrom: string | null }
export interface Attempt { how: string; url: string; status: number | null; ok: boolean; chars?: number; note?: string }
export interface Result { role: Role; reachable: "job-board API" | "job-board page" | "company site" | "aggregator" | "careers site" | "not reachable"; attempts: Attempt[]; saved?: string }

export function slugs(company: string): string[] {
  const base = company.toLowerCase().replace(/\(.*?\)/g, "").replace(/\b(ltd|limited|plc|inc|llc|uk|group|technologies|technology)\b/g, "").trim();
  const words = base.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return [...new Set([words.join(""), words.join("-"), words[0]])];
}

export function classify(url: string): "job board" | "aggregator" | "company site" | "linkedin" {
  if (/linkedin\.com/i.test(url)) return "linkedin";
  if (JOB_BOARDS.test(url)) return "job board";
  if (AGGREGATORS.test(url)) return "aggregator";
  return "company site";
}

let last = 0;
async function get(url: string): Promise<{ status: number | null; body: string }> {
  if (/linkedin\.com/i.test(url)) return { status: null, body: "" }; // never
  const wait = last + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, text/html;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(Number(process.env.SPIKE_TIMEOUT_MS || 15000)) });
    const body = (await res.text()).slice(0, 400_000);
    return { status: res.status, body };
  } catch (err) {
    return { status: null, body: String((err as Error).message) };
  }
}

const robotsCache = new Map<string, string>();
async function robotsAllows(url: string): Promise<boolean> {
  const u = new URL(url);
  if (!robotsCache.has(u.host)) {
    const r = await get(`${u.protocol}//${u.host}/robots.txt`);
    robotsCache.set(u.host, r.status === 200 ? r.body : "");
  }
  // The rules for all agents ("*"): a Disallow that prefixes the path blocks it.
  let applies = false;
  for (const line of robotsCache.get(u.host)!.split(/\r?\n/)) {
    const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "user-agent") applies = m[2].trim() === "*";
    else if (applies && m[2].trim() && u.pathname.startsWith(m[2].trim())) return false;
  }
  return true;
}

async function tryApis(role: Role, attempts: Attempt[]): Promise<{ text: string; url: string } | null> {
  for (const slug of slugs(role.company)) {
    const apis: Array<[string, string, (j: any) => Array<{ title: string; text: string; url: string }>]> = [
      ["greenhouse", `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, (j) => (j.jobs ?? []).map((x: any) => ({ title: x.title, text: textOf(String(x.content ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")), url: x.absolute_url }))],
      ["lever", `https://api.lever.co/v0/postings/${slug}?mode=json`, (j) => (Array.isArray(j) ? j : []).map((x: any) => ({ title: x.text, text: [x.descriptionPlain, ...(x.lists ?? []).map((l: any) => `${l.text}\n${textOf(l.content ?? "")}`), x.additionalPlain].filter(Boolean).join("\n"), url: x.hostedUrl }))],
      ["ashby", `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, (j) => (j.jobs ?? []).map((x: any) => ({ title: x.title, text: x.descriptionPlain ?? textOf(x.descriptionHtml ?? ""), url: x.jobUrl }))],
      ["workable", `https://apply.workable.com/api/v1/widget/accounts/${slug}`, (j) => (j.jobs ?? []).map((x: any) => ({ title: x.title, text: "", url: x.url }))],
    ];
    for (const [name, url, pick] of apis) {
      const r = await get(url);
      let jobs: Array<{ title: string; text: string; url: string }> = [];
      if (r.status === 200) { try { jobs = pick(JSON.parse(r.body)); } catch { /* not JSON */ } }
      const match = jobs.map((x) => ({ x, s: titleOverlap(x.title ?? "", role.title) })).sort((a, b) => b.s - a.s)[0];
      const ok = !!match && match.s >= 0.7;
      attempts.push({ how: `${name} API (${slug})`, url, status: r.status, ok, note: r.status === 200 ? `${jobs.length} jobs on the board${match ? `; best title match ${match.s.toFixed(2)}: ${match.x.title}` : ""}` : undefined });
      if (ok) return { text: match.x.text || "", url: match.x.url || url };
      if (r.status === 200) break; // the board exists under this name; the role is not on it
    }
  }
  return null;
}

async function tryPage(url: string, how: string, role: Role, attempts: Attempt[]): Promise<string | null> {
  if (!(await robotsAllows(url))) {
    attempts.push({ how, url, status: null, ok: false, note: "robots.txt disallows it" });
    return null;
  }
  const r = await get(url);
  const text = r.status === 200 ? textOf(r.body) : "";
  const words = role.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const mentions = words.filter((w) => text.toLowerCase().includes(w)).length;
  const ok = r.status === 200 && text.length > 1500 && mentions >= Math.min(2, words.length);
  attempts.push({ how, url, status: r.status, ok, chars: text.length, note: r.status === 200 && !ok ? (text.length <= 1500 ? "page has little text (likely built by script)" : "title not found on the page") : undefined });
  return ok ? text : null;
}

function rolesFromRuns(): Role[] {
  const runs = path.join(dataDir, "runs");
  const days = fs.readdirSync(runs).filter((d) => fs.existsSync(path.join(runs, d, "scores.json"))).sort().slice(-2);
  const roles = new Map<string, Role>();
  for (const day of days) {
    const dir = path.join(runs, day);
    for (const s of JSON.parse(fs.readFileSync(path.join(dir, "scores.json"), "utf8"))) {
      let advertFrom: string | null = null;
      if (s.advert && fs.existsSync(path.join(dir, s.advert))) {
        const m = /^Source:\s*(\S+)/m.exec(fs.readFileSync(path.join(dir, s.advert), "utf8"));
        advertFrom = m ? m[1] : null;
      }
      roles.set(s.id, { id: s.id, company: s.company, title: s.title, source: s.site, url: s.url ?? "", advertFrom });
    }
  }
  return [...roles.values()];
}

export async function main(): Promise<void> {
  const roles = rolesFromRuns().slice(0, Number(process.env.SPIKE_LIMIT || 1000));
  const extra: Role[] = [];
  // Google and Microsoft (B12, N20): their own pages, from the sample alerts.
  extra.push({ id: "google:careers", company: "Google", title: "Careers search page", source: "google", url: "https://www.google.com/about/careers/applications/jobs/results", advertFrom: null });
  extra.push({ id: "microsoft:careers", company: "Microsoft", title: "Careers search page", source: "microsoft", url: "https://jobs.careers.microsoft.com/global/en/search", advertFrom: null });
  const results: Result[] = [];
  fs.mkdirSync(path.join(spikeDir, "adverts"), { recursive: true });
  for (const role of [...roles, ...extra.slice(0, process.env.SPIKE_LIMIT ? 0 : 2)]) {
    console.log(`Checking ${role.company}, ${role.title}`);
    const attempts: Attempt[] = [];
    let reachable: Result["reachable"] = "not reachable";
    let text: string | null = null;
    if (role.source === "google" || role.source === "microsoft") {
      text = await tryPage(role.url, `${role.source} careers page`, role, attempts);
      if (text) reachable = "careers site";
    } else {
      const api = await tryApis(role, attempts);
      if (api) { reachable = "job-board API"; text = api.text; }
      if (!text && role.advertFrom && classify(role.advertFrom) !== "linkedin") {
        const kind = classify(role.advertFrom);
        text = await tryPage(role.advertFrom, `the page the morning run read (${kind})`, role, attempts);
        if (text) reachable = kind === "job board" ? "job-board page" : kind === "aggregator" ? "aggregator" : "company site";
      }
    }
    const r: Result = { role, reachable, attempts };
    if (text && text.length > 400) {
      r.saved = `adverts/${role.id.replace(/[^a-z0-9-]+/gi, "-")}.txt`;
      fs.writeFileSync(path.join(spikeDir, r.saved), `Source: ${role.company}, ${role.title}\n\n${text.slice(0, 40000)}`);
    }
    results.push(r);
  }
  // N20: can the PC see Microsoft's full list of matches?
  const msApis: Attempt[] = [];
  for (const url of [
    "https://microsoft.eightfold.ai/api/apply/v2/jobs?domain=microsoft.com&query=product%20manager&location=United%20Kingdom&start=0&num=10",
    "https://gcsservices.careers.microsoft.com/search/api/v1/search?q=product%20manager&lc=United%20Kingdom&l=en_us&pg=1&pgSz=20",
  ]) {
    const r = await get(url);
    let n: number | null = null;
    try { const j = JSON.parse(r.body); n = j.count ?? j.positions?.length ?? j.operationResult?.result?.totalJobs ?? null; } catch { /* not JSON */ }
    msApis.push({ how: "Microsoft job search", url, status: r.status, ok: r.status === 200 && n !== null, note: n !== null ? `${n} jobs reported` : undefined });
  }

  const count = (k: Result["reachable"]) => results.filter((r) => r.reachable === k).length;
  const out = { date: today(), roles: results.length, byKind: Object.fromEntries((["job-board API", "job-board page", "company site", "aggregator", "careers site", "not reachable"] as const).map((k) => [k, count(k)])), saved: results.filter((r) => r.saved).length, microsoftSearch: msApis, results };
  writeJson(path.join(spikeDir, `fetch-${out.date}.json`), out);
  const md = [`# Spike: what the PC can fetch, ${out.date}`, "", `${out.roles} roles from the last two scored runs, plus one Google and one Microsoft role.`, "", "| Reached through | Roles |", "| --- | --- |",
    ...Object.entries(out.byKind).map(([k, v]) => `| ${k} | ${v} |`), "", `Full advert text saved for ${out.saved} (data\\spike\\adverts\\).`, "",
    "## Microsoft's job search (N20)", "", ...msApis.map((a) => `- ${a.url}: ${a.status ?? "no answer"}${a.note ? `, ${a.note}` : ""}`), "",
    "## Each role", "", "| Role | Company | Result | Tried |", "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.role.title} | ${r.role.company} | ${r.reachable} | ${r.attempts.map((a) => `${a.how}: ${a.status ?? "-"}${a.ok ? " ok" : ""}${a.note ? ` (${a.note})` : ""}`).join("; ").replace(/\|/g, "/")} |`)];
  fs.writeFileSync(path.join(spikeDir, `fetch-${out.date}.md`), md.join("\n"));
  console.log(`\nDone. ${JSON.stringify(out.byKind)}. Saved ${out.saved} adverts. Report: data\\spike\\fetch-${out.date}.md`);
}

if (process.argv[1]?.endsWith("fetch.ts")) main().catch((e) => { console.error(e); process.exitCode = 1; });
