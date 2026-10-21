// npm run demo: the PC half of the safe demo (backlog H16, Sprint 8).
//
// Runs the real pipeline on made-up data only: the mail read on the demo's
// alert and reply emails (demo\emails), the advert reader on adverts served
// from demo\adverts, and the reply reader. Everything is written under
// data\demo\<date>\, with Bridge off, its own private store and its own
// settings (demo\settings.json). It never reads the mailbox, the real run
// folders, the private store or the vault, and it never reaches the internet:
// the only addresses it answers are the demo's own .example sites and Ollama
// on this PC. Claude's half (demo\DEMO.md) then scores the demo run and
// writes to the demo board, never the real one.
//
// Options: --date YYYY-MM-DD   --reset (delete data\demo and stop)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type Settings } from "./config.ts";
import { run, localDate } from "./scout.ts";
import { readAdverts, type ReaderSummary } from "./read-adverts.ts";
import { readReplies } from "./read-replies.ts";
import type { Fetch } from "./reader/fetch.ts";
import { secureDir } from "./secrets.ts";

const MARK = ".demo";

export interface DemoAdvert { company: string; title: string; url: string; file: string; hostile?: boolean }
export interface DemoRun {
  date: string;
  folder: string;
  roles: { found: number; toScore: number; dropped: number };
  adverts: { listed: number; read: number; notReadable: number; failed: number; status: ReaderSummary["status"]; warnings: string[] };
  replies: { found: number; read: number; status: string | null };
}

/** The real folders the demo must never touch. */
function realFolders(real: Settings): string[] {
  return [real.dataDir, path.join(real.dataDir, "runs"), real.emailStore, path.dirname(real.emailStore), real.contextDir].map((p) => path.resolve(p));
}

/** Test 1: the demo runs only inside data\demo, never in a real folder, and clears only folders it made. */
export function assertDemoFolder(base: string, real: Settings): void {
  const b = path.resolve(base);
  const home = path.resolve(real.dataDir, "demo");
  if (realFolders(real).includes(b) || !b.startsWith(home + path.sep)) throw new Error(`Demo refused: ${base} is not a folder under data\\demo.`);
  if (fs.existsSync(b) && fs.readdirSync(b).length && !fs.existsSync(path.join(b, MARK))) throw new Error(`Demo refused: ${base} exists and is not one of the demo's own folders.`);
}

export function demoAdverts(root: string): DemoAdvert[] {
  const j = JSON.parse(fs.readFileSync(path.join(root, "demo", "adverts", "index.json"), "utf8")) as { adverts: DemoAdvert[] };
  return j.adverts;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The demo's only way out: its own .example sites, served from demo\adverts,
 * and Ollama on this PC. Every other address is refused, so the demo cannot
 * reach the internet or any real site, whatever an advert or email says.
 */
export function demoFetch(root: string, ollamaHost: string, inner: Fetch = fetch): Fetch {
  const ads = demoAdverts(root);
  const ollama = new URL(ollamaHost).host;
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host === ollama) return inner(url, init);
    if (u.hostname.endsWith(".example")) {
      if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
      const ad = ads.find((a) => a.url === `${u.origin}${u.pathname}`);
      if (!ad) return new Response("Not found", { status: 404 });
      return new Response(fs.readFileSync(path.join(root, "demo", "adverts", ad.file), "utf8"), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    throw new Error(`the demo reaches no address outside its own made-up sites (${u.hostname})`);
  };
}

export function demoSettings(root: string, base: string, real: Settings): Settings {
  for (const d of ["inbox", "store", "context", "secure"]) fs.mkdirSync(path.join(base, d), { recursive: true });
  const s = loadSettings(root, {
    SETTINGS_FILE: path.join(root, "demo", "settings.json"), DATA_DIR: base, EMAIL_STORE: path.join(base, "store"),
    EML_FOLDER: path.join(base, "inbox"), CONTEXT_DIR: path.join(base, "context"), JOB_SCOUT_SECURE_DIR: path.join(base, "secure"),
    OLLAMA_HOST: real.ollamaHost,
  });
  // Belt and braces: never mail, replies on, the reader's model as in the demo settings.
  return { ...s, imap: null, sources: { ...s.sources, replies: { enabled: true, firstLookDays: 60 } } };
}

export async function runDemo(real: Settings, opts: { today?: string; fetchFn?: Fetch } = {}): Promise<DemoRun> {
  const today = opts.today ?? localDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`Demo refused: ${today} is not a date (YYYY-MM-DD).`);
  const root = real.root;
  const base = path.join(real.dataDir, "demo", today);
  assertDemoFolder(base, real);
  // Test 5: running twice the same day starts clean.
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, MARK), "Folder made by npm run demo: made-up data only. Safe to delete.\n");
  const s = demoSettings(root, base, real);
  const src = path.join(root, "demo");
  for (const f of fs.readdirSync(path.join(src, "emails")).filter((f) => f.endsWith(".eml"))) fs.copyFileSync(path.join(src, "emails", f), path.join(s.emlFolder, f));
  fs.copyFileSync(path.join(src, "watchlist.json"), path.join(base, "watchlist.json"));
  fs.copyFileSync(path.join(src, "applications.md"), path.join(s.contextDir, "applications.md"));

  const out = await run(s, { bridge: false, today });
  const candidates = JSON.parse(fs.readFileSync(path.join(out.folder, "candidates.json"), "utf8")) as Array<{ role: { id: string; title: string; company: string } }>;
  // Part 1's job in the morning (finding each advert's address) is the demo's index here.
  const ads = demoAdverts(root);
  const urls = candidates
    .map((c) => ({ c, ad: ads.find((a) => norm(a.company) === norm(c.role.company) && norm(a.title) === norm(c.role.title)) }))
    .filter((x) => x.ad)
    .map(({ c, ad }) => ({ id: c.role.id, url: ad!.url, foundBy: "careers page" }));
  fs.writeFileSync(path.join(out.folder, "advert-urls.json"), JSON.stringify(urls, null, 2));

  const fetchFn = demoFetch(root, s.ollamaHost, opts.fetchFn);
  const reader = await readAdverts(s, { today, fetchFn, waitMs: 0, gapMs: 0 });
  const replies = await readReplies(s, { today, fetchFn });
  const found = path.join(out.folder, "replies", "found.json");
  const foundN = fs.existsSync(found) ? (JSON.parse(fs.readFileSync(found, "utf8")).replies ?? []).length : 0;
  const status = JSON.parse(fs.readFileSync(path.join(out.folder, "status.json"), "utf8")) as { counts?: Record<string, number> };
  const result: DemoRun = {
    date: today,
    folder: out.folder,
    roles: { found: status.counts?.found ?? candidates.length, toScore: candidates.length, dropped: status.counts?.dropped ?? 0 },
    adverts: { listed: reader.counts.listed, read: reader.counts.ok + reader.counts.unreliable, notReadable: reader.counts.notReadable, failed: reader.counts.failed, status: reader.status, warnings: reader.warnings },
    replies: { found: foundN, read: replies?.replies?.length ?? 0, status: replies?.status ?? null },
  };
  fs.writeFileSync(path.join(base, "demo-run.json"), JSON.stringify(result, null, 2));
  return result;
}

/** --reset: delete data\demo, but only the folders the demo made. */
export function resetDemo(real: Settings): number {
  const home = path.join(real.dataDir, "demo");
  if (!fs.existsSync(home)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(home)) {
    const p = path.join(home, d);
    if (fs.existsSync(path.join(p, MARK))) { fs.rmSync(p, { recursive: true, force: true }); n++; }
  }
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--date");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // The demo never reads the private store: load the settings with an empty secure folder
  // (so no Bridge credentials are read), keeping the real store's path only to refuse it.
  const real = { ...loadSettings(root, { ...process.env, BRIDGE_PASSWORD: "", JOB_SCOUT_SECURE_DIR: path.join(root, "data", "demo", ".no-secrets") }), emailStore: path.join(secureDir(process.env), "emails") };
  if (args.includes("--reset")) {
    console.log(`Job Scout demo: ${resetDemo(real)} demo folder(s) deleted.`);
  } else {
    runDemo(real, { today: at >= 0 ? args[at + 1] : undefined })
      .then((r) => {
        console.log(`Job Scout demo, ${r.date} (made-up data only): ${r.roles.toScore} roles to score; ${r.adverts.read} of ${r.adverts.listed} adverts read on this PC; ${r.replies.read} of ${r.replies.found} replies read.`);
        for (const w of r.adverts.warnings) console.log(`Note: ${w}`);
        console.log(`Folder: ${r.folder}\nNext: ask Claude to "run the Job Scout demo for ${r.date}" (demo\\DEMO.md). It writes to the demo board only.`);
      })
      .catch((err) => { console.error(`Job Scout demo failed: ${(err as Error).message}`); process.exitCode = 1; });
  }
}
