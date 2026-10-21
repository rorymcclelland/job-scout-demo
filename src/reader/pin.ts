// Model pinning (backlog H8, Sprint 7). The reader names its model
// (qwen2.5:14b), but Ollama can replace a model under the same name. Each run
// records the digest it used in data\reader-model.json; when it differs from
// the last one, the run warns, so the evaluation is re-run before the new
// model is trusted. Nothing is blocked: the warning is the control.

import fs from "node:fs";
import path from "node:path";

export interface PinRecord {
  model: string;
  digest: string;
  since: string;
  previous?: { digest: string; since: string } | null;
  /** H19: the Ollama runtime version last seen with this model, and when it was first seen. */
  ollama?: string | null;
  ollamaSince?: string | null;
  ollamaPrevious?: string | null;
}

export function checkDigest(dataDir: string, model: string, digest: string | null, today: string, ollama: string | null = null): { warning: string | null; record: PinRecord | null } {
  if (!digest) return { warning: null, record: null };
  const res = checkModel(dataDir, model, digest, today);
  if (!ollama || !res.record || res.warning) {
    if (ollama && res.record) saveRuntime(dataDir, model, ollama, today);
    return res;
  }
  const rec = res.record;
  if (!rec.ollama) { saveRuntime(dataDir, model, ollama, today); return res; }
  if (rec.ollama === ollama) return res;
  const was = rec.ollama;
  saveRuntime(dataDir, model, ollama, today);
  return {
    warning: `Ollama itself was updated (version ${was} is now ${ollama}). The model ${model} is unchanged, but a new runtime can change what it writes: run "npm run eval:reader" before relying on what it reads.`,
    record: { ...rec, ollama, ollamaSince: today, ollamaPrevious: was },
  };
}

function saveRuntime(dataDir: string, model: string, ollama: string, today: string): void {
  const file = path.join(dataDir, "reader-model.json");
  let all: Record<string, PinRecord> = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  const rec = all[model];
  if (!rec || rec.ollama === ollama) return;
  all[model] = { ...rec, ollama, ollamaSince: today, ollamaPrevious: rec.ollama ?? null };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

function checkModel(dataDir: string, model: string, digest: string, today: string): { warning: string | null; record: PinRecord | null } {
  const file = path.join(dataDir, "reader-model.json");
  let all: Record<string, PinRecord> = {};
  let unreadable = false;
  if (fs.existsSync(file)) {
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { unreadable = true; }
  }
  const last = all[model];
  if (last && last.digest === digest) return { warning: null, record: last };
  const record: PinRecord = { model, digest, since: today, previous: last ? { digest: last.digest, since: last.since } : null };
  all[model] = record;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  const warning = unreadable
    ? `The record of the local model's digest (data\\reader-model.json) could not be read, so a change to ${model} cannot be ruled out: run "npm run eval:reader" to check it. The digest is now recorded afresh.`
    : last
    ? `The local model ${model} has changed since ${last.since} (digest ${last.digest.slice(0, 12)} is now ${digest.slice(0, 12)}): Ollama updated it in place. Run "npm run eval:reader" before relying on what it reads, and grade the reply reader again (npm run grade-replies -- --make).`
    : null;
  return { warning, record };
}
