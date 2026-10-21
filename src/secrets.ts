// Where the Bridge credentials live (backlog H1).
//
// The Claude scheduled tasks can reach the Job Scout and Professional
// development folders, and they read untrusted text (adverts, emails). So the
// Bridge password must not sit in either folder. scripts\set-bridge-password.ps1
// stores it outside them, in %LOCALAPPDATA%\JobScout\:
//
//   bridge.env              BRIDGE_USER and the other non-secret Bridge settings
//   bridge-password.dpapi   the password, encrypted with Windows DPAPI for the owner's
//                           Windows account: unreadable to anyone else, and
//                           useless if copied to another machine
//
// A password still found in .env is used, with a warning in run.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type Decrypt = (file: string) => string;

export function secureDir(env: NodeJS.ProcessEnv): string {
  return env.JOB_SCOUT_SECURE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "JobScout");
}

/** KEY=VALUE lines; blank lines and # comments ignored. Only BRIDGE_* keys are taken. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(BRIDGE_[A-Z_]+)\s*=\s*(.*)$/);
    if (!m || m[1] === "BRIDGE_PASSWORD") continue; // never from a plain file here
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Windows DPAPI, through PowerShell's own SecureString commands: no modules, no admin. */
export const dpapiDecrypt: Decrypt = (file) => {
  if (process.platform !== "win32") throw new Error("the stored Bridge password can only be read on Windows");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$s = (Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}').Trim() | ConvertTo-SecureString`,
    "$p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true }).trim();
};

export interface BridgeCredentials {
  env: Record<string, string>;
  password: string | null;
  /** Where the password came from, for run.md. */
  from: "secure store" | ".env" | "none";
  problem: string | null;
}

export function bridgeCredentials(env: NodeJS.ProcessEnv, decrypt: Decrypt = dpapiDecrypt): BridgeCredentials {
  const dir = secureDir(env);
  let stored: Record<string, string> = {};
  const envFile = path.join(dir, "bridge.env");
  if (fs.existsSync(envFile)) stored = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  const merged = { ...stored };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("BRIDGE_") && k !== "BRIDGE_PASSWORD" && v) merged[k] = v;

  const plain = env.BRIDGE_PASSWORD?.trim();
  const pwFile = path.join(dir, "bridge-password.dpapi");
  if (fs.existsSync(pwFile)) {
    try {
      const pw = decrypt(pwFile);
      const problem = plain ? "The Bridge password is also still in .env, inside a folder Claude's scheduled tasks can reach. Delete that line (or run scripts\\set-bridge-password.ps1 again)." : null;
      return { env: merged, password: pw || null, from: "secure store", problem };
    } catch (err) {
      if (plain) return { env: merged, password: plain, from: ".env", problem: `The stored Bridge password could not be read (${(err as Error).message}), so the one in .env was used. Run scripts\\set-bridge-password.ps1 again.` };
      return { env: merged, password: null, from: "none", problem: `The stored Bridge password could not be read (${(err as Error).message}). Run scripts\\set-bridge-password.ps1 again.` };
    }
  }
  if (plain) {
    return { env: merged, password: plain, from: ".env", problem: "The Bridge password is in .env, inside a folder Claude's scheduled tasks can reach. Run scripts\\set-bridge-password.ps1 once to move it out of reach (backlog H1)." };
  }
  return { env: merged, password: null, from: "none", problem: null };
}
