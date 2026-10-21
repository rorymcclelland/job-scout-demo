// npm run share-email -- <date> <file>   (for example: 2026-10-17 bridge-123.eml)
//
// H14: copies of the emails read are kept only on this PC, in the private
// store (%LOCALAPPDATA%\JobScout\emails\<date>\), where Claude cannot see
// them. When a parser needs fixing, this copies one email you choose into
// data\shared-emails\ for Claude to read. Nothing is shared unless you run it.
// run.md lists the file names of each run's emails under "Emails read".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./config.ts";

export function shareEmail(store: string, dataDir: string, day: string, file: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("The date must look like 2026-10-17.");
  if (!/^[\w.@+-]+\.eml$/i.test(file) || file.includes("..")) throw new Error("Give the email's file name as run.md lists it, for example bridge-123.eml.");
  const from = path.join(store, day, file);
  if (!fs.existsSync(from)) throw new Error(`No email ${file} from ${day} in the private store (copies are kept for 30 days).`);
  const to = path.join(dataDir, "shared-emails", `${day}-${file}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [day, file] = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const s = loadSettings(root);
  try {
    const to = shareEmail(s.emailStore, s.dataDir, day ?? "", file ?? "");
    console.log(`Copied to ${to}. Tell Claude it is there; delete it once the parser is fixed.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
