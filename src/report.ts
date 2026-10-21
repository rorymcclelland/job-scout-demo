// Writes run.md: what was read, what was dropped and why, and what goes on to
// scoring. It is the page for checking the filters (Sprint 1 review check 2:
// "none you wanted is among the dropped").

import fs from "node:fs";
import { SOURCES, type Role, type Source, type Verdict } from "./role.ts";

export interface Judged {
  role: Role;
  verdict: Verdict;
  stage: "known" | "dropped" | "score";
  /** Days since the alert arrived (B7). */
  ageDays?: number | null;
  /** B13: the target employer this role's company matches. */
  target?: string;
  /** Set when a role that missed an earlier day's cap is offered again (C6). */
  carried?: { from: string; score: number; carries: number };
}

export interface Health {
  since: string;
  bridge: string;
  emails: Record<Source | "other", number>;
  rolesBySource: Record<Source | "other", number>;
  /** What a source's email said it left out, e.g. "showed 3 of 30" (B12). */
  notes?: string[];
  /** H14: the file names of the email copies in the private store, for share-email. */
  emailFiles?: string[];
  partial: number;
  problems: string[];
  /** Lines removed from alert text because they addressed an AI (H2). */
  untrusted: Array<{ role: string; line: string; why: string }>;
}

const cell = (s: string) => (s || "—").replace(/\|/g, "/").replace(/\n/g, " ");
const link = (r: Role) => (r.url ? `[open](${r.url})` : "—");
const pay = (r: Role) => (r.pay ? r.pay.text : "");

export function writeReport(file: string, today: string, judged: Judged[], h: Health, constraintsVersion: number | string): void {
  const by = (s: Judged["stage"]) => judged.filter((j) => j.stage === s);
  const toScore = by("score");
  const dropped = by("dropped");
  const known = by("known");

  const out: string[] = [];
  out.push(`# Job Scout run, ${today}`, "");
  out.push(`Looked back to ${h.since}. Proton Mail Bridge: ${h.bridge}. Constraints version ${constraintsVersion}.`, "");
  out.push(`**${judged.length} roles found**: ${toScore.length} to score, ${dropped.length} dropped by the filters, ${known.length} already known.`, "");
  const targets = toScore.filter((j) => j.target);
  if (targets.length) out.push(`**Target employers:** ${targets.length} to score (${[...new Set(targets.map((j) => j.target))].join(", ")}), listed first and read first.`, "");

  out.push(`## To score (${toScore.length})`, "");
  if (toScore.length) {
    out.push("| Role | Company | Place | Pay | Age | Flags | Warning signs | Link |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { role, verdict, ageDays, carried, target } of toScore) {
      const flags = [...(target ? [`Target employer (${target}).`] : []), ...(carried ? [`Carried over from ${carried.from} (scored ${carried.score}).`] : []), ...verdict.flags];
      out.push(`| ${cell(role.title)} | ${cell(role.company)} | ${cell(role.location)} | ${cell(pay(role))} | ${ageDays ?? "—"}d | ${cell(flags.join(" "))} | ${cell((verdict.warnings ?? []).join(" "))} | ${link(role)} |`);
    }
  } else out.push("Nothing new to score today.");
  out.push("");

  out.push(`## Dropped by the filters (${dropped.length})`, "", "Check none of these is one you wanted. If one is, the constraint or the parser needs changing: log it for the sprint review.", "");
  if (dropped.length) {
    out.push("| Role | Company | Place | Pay | Why | Link |", "| --- | --- | --- | --- | --- | --- |");
    for (const { role, verdict } of dropped) {
      out.push(`| ${cell(role.title)} | ${cell(role.company)} | ${cell(role.location)} | ${cell(pay(role))} | ${cell(verdict.reasons.join(" "))} | ${link(role)} |`);
    }
  }
  out.push("");

  out.push(`## Already known (${known.length})`, "");
  if (known.length) {
    out.push("| Role | Company | Why | Link |", "| --- | --- | --- | --- |");
    for (const { role, verdict } of known) out.push(`| ${cell(role.title)} | ${cell(role.company)} | ${cell(verdict.reasons.join(" "))} | ${link(role)} |`);
  }
  out.push("");

  out.push("## Source health", "");
  out.push("| Source | Emails read | Roles found |", "| --- | --- | --- |");
  for (const s of SOURCES) out.push(`| ${s.name} | ${h.emails[s.id] ?? 0} | ${h.rolesBySource[s.id] ?? 0} |`);
  out.push(`| Other senders (ignored) | ${h.emails.other} | — |`, "");
  for (const n of h.notes ?? []) out.push(`- ${n}`);
  if (h.notes?.length) out.push("");
  out.push(`Roles the parser could only partly read: ${h.partial}.`, "");
  if (h.emailFiles?.length) {
    out.push("## Emails read", "", `Kept on this PC only, in the private store. To let Claude see one (to fix a parser): \`npm run share-email -- ${today} <file>\`.`, "", h.emailFiles.map((f) => `\`${f}\``).join(", "), "");
  }
  out.push("## Untrusted text", "");
  if (h.untrusted.length) {
    out.push(`${h.untrusted.length} line${h.untrusted.length === 1 ? " was" : "s were"} removed from alert text before scoring, because they addressed an AI or tried to steer it. The roles they came from carry a warning sign.`, "");
    out.push("| Role | Why | Line removed |", "| --- | --- | --- |");
    for (const u of h.untrusted) out.push(`| ${cell(u.role)} | ${cell(u.why)} | ${cell(u.line.replace(/[<>`]/g, " "))} |`);
  } else out.push("Nothing instruction-like was found in the alert text.");
  out.push("");
  if (h.problems.length) {
    out.push("**Problems**", "");
    for (const p of h.problems) out.push(`- ${p}`);
    out.push("");
  }
  fs.writeFileSync(file, out.join("\n"));
}
