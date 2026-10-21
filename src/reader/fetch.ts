// Fetching an advert on the PC (H5b, Sprint 5c). Read-only, polite, never LinkedIn.
//
//   - LinkedIn pages are never fetched (its terms; D4), nor anything not https.
//   - robots.txt is respected for every page fetched directly.
//   - One request a second; 15-second timeout; at most 400 KB read.
//   - Where the address is a Greenhouse, Lever or Ashby job page, the board's
//     public API is used instead, which gives the advert's own text.

import { textOf } from "./text.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Fetched {
  ok: boolean;
  text: string;
  via: "greenhouse API" | "lever API" | "ashby API" | "page" | "none";
  status: number | null;
  reason?: string;
}

const UA = "JobScout/0.8 (personal job search; read-only)";

export function forbidden(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "not a web address"; }
  if (u.protocol !== "https:") return "not https";
  if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return "LinkedIn pages are never fetched";
  return null;
}

/** The public API address for a job-board page, if it is one we know. */
export function apiFor(url: string): { via: Fetched["via"]; api: string; id: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const p = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/i.test(u.hostname)) {
    const i = p.indexOf("jobs");
    const id = u.searchParams.get("gh_jid") ?? (i >= 0 ? p[i + 1] : undefined);
    const board = p[0] === "embed" ? u.searchParams.get("for") : p[0];
    if (board && id && /^\d+$/.test(id)) return { via: "greenhouse API", api: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`, id };
  }
  if (/^jobs\.(eu\.)?lever\.co$/i.test(u.hostname) && p.length >= 2) {
    const eu = /\.eu\./i.test(u.hostname) ? ".eu" : "";
    return { via: "lever API", api: `https://api${eu}.lever.co/v0/postings/${p[0]}/${p[1]}?mode=json`, id: p[1] };
  }
  if (/^jobs\.ashbyhq\.com$/i.test(u.hostname) && p.length >= 2) {
    return { via: "ashby API", api: `https://api.ashbyhq.com/posting-api/job-board/${p[0]}?includeCompensation=true`, id: p[1] };
  }
  return null;
}

export class Fetcher {
  private last = 0;
  private robots = new Map<string, string>();
  private fetchFn: Fetch;
  private gapMs: number;
  constructor(fetchFn: Fetch = fetch, gapMs = 1000) {
    this.fetchFn = fetchFn;
    this.gapMs = gapMs;
  }

  private async get(url: string): Promise<{ status: number | null; body: string }> {
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    try {
      const res = await this.fetchFn(url, { headers: { "User-Agent": UA, Accept: "application/json, text/html;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      return { status: res.status, body: (await res.text()).slice(0, 400_000) };
    } catch (err) {
      return { status: null, body: (err as Error).message };
    }
  }

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    if (!this.robots.has(u.host)) {
      const r = await this.get(`${u.protocol}//${u.host}/robots.txt`);
      this.robots.set(u.host, r.status === 200 ? r.body : "");
    }
    let applies = false;
    for (const line of this.robots.get(u.host)!.split(/\r?\n/)) {
      const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i);
      if (!m) continue;
      if (m[1].toLowerCase() === "user-agent") applies = m[2].trim() === "*";
      else if (applies && m[2].trim() && u.pathname.startsWith(m[2].trim())) return false;
    }
    return true;
  }

  async advert(url: string): Promise<Fetched> {
    const no = forbidden(url);
    if (no) return { ok: false, text: "", via: "none", status: null, reason: no };
    const api = apiFor(url);
    if (api) {
      const r = await this.get(api.api);
      if (r.status === 200) {
        try {
          const j = JSON.parse(r.body);
          let text = "";
          if (api.via === "greenhouse API") text = `${j.title ?? ""}\n${j.location?.name ?? ""}\n${textOf(String(j.content ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))}`;
          if (api.via === "lever API") text = [j.text, j.categories?.location, j.descriptionPlain, ...(j.lists ?? []).map((l: { text: string; content: string }) => `${l.text}\n${textOf(l.content ?? "")}`), j.additionalPlain, j.salaryRange ? `Salary: ${j.salaryRange.currency} ${j.salaryRange.min} to ${j.salaryRange.max} per ${j.salaryRange.interval}` : ""].filter(Boolean).join("\n");
          if (api.via === "ashby API") {
            const job = (j.jobs ?? []).find((x: { id?: string; jobUrl?: string }) => x.id === api.id || String(x.jobUrl ?? "").includes(api.id));
            if (job) text = [job.title, job.location, job.descriptionPlain ?? textOf(job.descriptionHtml ?? ""), job.compensation?.compensationTierSummary ? `Compensation: ${job.compensation.compensationTierSummary}` : ""].filter(Boolean).join("\n");
          }
          if (text.trim()) return { ok: true, text, via: api.via, status: 200 };
        } catch { /* fall through to the page */ }
      }
    }
    if (!(await this.allowed(url))) return { ok: false, text: "", via: "none", status: null, reason: "the site's robots.txt asks automated readers to stay out" };
    const r = await this.get(url);
    if (r.status !== 200) return { ok: false, text: "", via: "page", status: r.status, reason: r.status === null ? `no answer (${r.body.slice(0, 80)})` : `the site answered ${r.status}` };
    return { ok: true, text: textOf(r.body), via: "page", status: 200 };
  }
}
