// The watch list (backlog I1, Sprint 6a): the live applications whose replies
// the PC looks for. Part 2 writes data/watchlist.json at the end of each
// morning, from the board's Applied and In Conversation cards and the tracker,
// so the next morning's mail read knows which senders to search for. The PC
// never reads the board itself.

import fs from "node:fs";

export interface WatchEntry {
  cardId: string;
  company: string;
  role: string;
  status: "applied" | "conversation";
  /** The company's own mail domains, e.g. "northwind.example". */
  domains: string[];
  /** Recruiters' addresses, lower case. */
  recruiters: string[];
}

export interface Watchlist {
  written: string | null;
  entries: WatchEntry[];
  problem?: string;
}

const EMPTY: Watchlist = { written: null, entries: [] };

export function readWatchlist(file: string): Watchlist {
  if (!fs.existsSync(file)) return { ...EMPTY, problem: "No watch list yet (data\\watchlist.json): replies were looked for from hiring systems and LinkedIn only. Part 2 writes it each morning." };
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { written?: string; entries?: unknown[] };
    const entries: WatchEntry[] = [];
    for (const e of j.entries ?? []) {
      const x = e as Partial<WatchEntry>;
      if (typeof x?.cardId !== "string" || typeof x.company !== "string") continue;
      entries.push({
        cardId: x.cardId,
        company: x.company,
        role: typeof x.role === "string" ? x.role : "",
        status: x.status === "conversation" ? "conversation" : "applied",
        domains: (Array.isArray(x.domains) ? x.domains : []).filter((d): d is string => typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)),
        recruiters: (Array.isArray(x.recruiters) ? x.recruiters : []).filter((r): r is string => typeof r === "string" && r.includes("@")).map((r) => r.toLowerCase()),
      });
    }
    return { written: typeof j.written === "string" ? j.written : null, entries };
  } catch (err) {
    return { ...EMPTY, problem: `The watch list could not be read (${(err as Error).message}); replies were looked for from hiring systems and LinkedIn only.` };
  }
}

const GENERIC = new Set(["ltd", "limited", "inc", "plc", "llc", "gmbh", "group", "holdings", "the", "company", "co", "uk", "global", "via", "recruiter", "formerly", "client", "not", "named",
  // Words a placeholder company name is made of, never a company of its own (review, Sprint 8).
  "confidential", "unnamed", "stealth", "product", "products", "startup", "fintech", "agency", "consultancy", "hiring", "role"]);

/**
 * I9 (Sprint 8): a company's name as a mail-domain label, for a watched
 * application whose domain is not yet known. "Lending Loop" gives
 * "lendingloop", "Brightloop (via recruiter Jo)" gives "brightloop". Anything in
 * brackets is dropped. Null when nothing distinctive is left (under 4 letters).
 */
export function companyToken(company: string): string | null {
  const base = company.replace(/\([^)]*\)/g, " ").toLowerCase().normalize("NFKD");
  const words = base.split(/[^a-z0-9]+/).filter((w) => w && !GENERIC.has(w));
  const token = words.join("");
  return token.length >= 4 && token.length <= 40 ? token : null;
}
