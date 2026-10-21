// Settings, read from .env (see .env.example) with sensible defaults, plus the
// two JSON files in config/ that hold the owner's decisions.

import fs from "node:fs";
import path from "node:path";
import type { Constraints } from "./filters.ts";
import type { ImapSettings } from "./imap.ts";
import { applySettings, readerSettings, READER_DEFAULTS, type BoardSettings, type ReaderSettings } from "./settings.ts";
import { bridgeCredentials, secureDir, type Decrypt } from "./secrets.ts";
import type { ReplySender } from "./inbox/senders.ts";

export interface Sources {
  /** "source" names a parser in SOURCES; a sender with no parser yet is read and counted as "other". */
  senders: Array<{ source: string; from: string }>;
  firstRunLookbackDays: number;
  /** Sprint 6a (I1): hiring systems' mail domains, and LinkedIn for its application updates. */
  replySenders?: ReplySender[];
  replies?: { enabled: boolean; firstLookDays: number };
}

export interface Settings {
  root: string; // the Job Scout folder
  /** Where constraints.json and sources.json were read from (config/, or the tests' own copy). */
  configDir: string;
  dataDir: string; // runs, seen list, state: personal data, never in git
  contextDir: string; // the vault: _context in Professional development
  emlFolder: string; // .eml files to read instead of, or as well as, Bridge
  /**
   * H14: where copies of the emails read are kept, outside every synced folder
   * (%LOCALAPPDATA%\JobScout\emails), so the cloud never sees a raw email.
   */
  emailStore: string;
  /** Days a copy is kept before it is deleted (H14). */
  emailDays: number;
  /** Days adverts, specs and reply summaries are kept in run folders, except roles applied for (H10). */
  runDays: number;
  /** Leave .eml files in the inbox folder after reading them (the tests set this). */
  keepInboxFiles: boolean;
  imap: ImapSettings | null; // null when Bridge is not configured
  constraints: Constraints;
  sources: Sources;
  /** What config/settings.json changed, for run.md; empty when there is none. */
  settingsApplied: string[];
  /** A problem reading config/settings.json, reported in run.md. */
  settingsProblem: string | null;
  /** How many times a role that missed the cap is offered again (C6). */
  carryOverMax: number;
  /** H5: the advert reader on the PC. */
  reader: ReaderSettings;
  /** Where Ollama listens (H5). */
  ollamaHost: string;
  /** True when the board's Settings say the scout is paused (H4). */
  paused: boolean;
  /** Where the Bridge password came from, and any warning about it (H1). */
  credentialSource: "secure store" | ".env" | "none";
  credentialProblem: string | null;
}

/** The vault sits beside the Job Scout folder: <projects>\\Professional development\\_context. */
const defaultContext = (root: string) => path.resolve(root, "..", "Professional development", "_context");

export function loadSettings(root: string, env: NodeJS.ProcessEnv = process.env, decrypt?: Decrypt): Settings {
  // JOB_SCOUT_CONFIG_DIR lets the tests use their own fixed configuration (H22), whatever the owner's is.
  const configDir = env.JOB_SCOUT_CONFIG_DIR || process.env.JOB_SCOUT_CONFIG_DIR || path.join(root, "config");
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(configDir, file), "utf8"));
  const dataDir = path.resolve(root, env.DATA_DIR || "data");

  // The password comes from the secure store outside the shared folders (H1).
  const cred = bridgeCredentials(env, decrypt);
  const b = cred.env;
  const user = b.BRIDGE_USER?.trim();
  const password = cred.password;
  const imap: ImapSettings | null = user && password
    ? {
        host: b.BRIDGE_HOST || "127.0.0.1",
        port: Number(b.BRIDGE_PORT || 1143),
        security: (b.BRIDGE_SECURITY as ImapSettings["security"]) || "starttls",
        user,
        password,
        folder: b.BRIDGE_FOLDER || "INBOX",
      }
    : null;

  return {
    root,
    dataDir,
    configDir,
    contextDir: env.CONTEXT_DIR || defaultContext(root),
    emlFolder: path.resolve(root, env.EML_FOLDER || path.join("data", "inbox")),
    emailStore: env.EMAIL_STORE || path.join(secureDir(env), "emails"),
    emailDays: 30,
    runDays: Number(env.RUN_DAYS) > 0 ? Number(env.RUN_DAYS) : 90,
    keepInboxFiles: env.KEEP_INBOX_FILES === "1",
    ollamaHost: env.OLLAMA_HOST || "http://127.0.0.1:11434",
    imap,
    credentialSource: cred.from,
    credentialProblem: cred.problem,
    ...withBoardSettings(root, read("constraints.json"), withReplyDefaults(read("sources.json")), env.SETTINGS_FILE),
  };
}

/** Older sources.json files have no reply settings: replies are then off. */
function withReplyDefaults(s: Sources): Sources {
  return {
    ...s,
    replySenders: Array.isArray(s.replySenders) ? s.replySenders.filter((x) => typeof x?.system === "string" && typeof x?.domain === "string") : [],
    replies: { enabled: s.replies?.enabled !== false && Array.isArray(s.replySenders), firstLookDays: s.replies?.firstLookDays ?? 60 },
  };
}

/** Lay config/settings.json (copied from the board's Settings each morning) over the JSON files. */
function withBoardSettings(root: string, constraints: Constraints, sources: Sources, override?: string) {
  // SETTINGS_FILE=none ignores the board's settings (the tests use it, so they
  // check the code against the files, whatever the owner has set on the board).
  const file = override && override !== "none" ? path.resolve(root, override) : path.join(root, "config", "settings.json");
  if (override === "none" || !fs.existsSync(file)) return { constraints, sources, settingsApplied: [] as string[], settingsProblem: null, carryOverMax: 2, paused: false, reader: { ...READER_DEFAULTS } };
  let parsed: BoardSettings | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BoardSettings;
  } catch (err) {
    return { constraints, sources, settingsApplied: [] as string[], settingsProblem: `config/settings.json could not be read (${(err as Error).message}), so the defaults in constraints.json and sources.json were used.`, carryOverMax: 2, paused: false, reader: { ...READER_DEFAULTS } };
  }
  const out = applySettings(constraints, sources, parsed);
  return { constraints: out.constraints, sources: out.sources, settingsApplied: out.applied, settingsProblem: null, carryOverMax: out.carryOverMax, paused: parsed?.control?.paused === true, reader: readerSettings(parsed) };
}
