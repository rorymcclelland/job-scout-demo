// BUG-9 (Sprint 11): when the reader is stopped (Ctrl+C in its window, as on
// 23 Oct for an interview), say so in the run folder, so part 2 reports "stopped
// at 08:18" instead of guessing, and tomorrow's mail read knows the replies were
// not read and carries them forward (src/scout.ts, carryReplies).

import fs from "node:fs";
import path from "node:path";

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Writes a "stopped" summary for whichever of the two readers had not finished. */
export function markStopped(dataDir: string, today: string, model: string, at: Date = new Date()): string[] {
  const folder = path.join(dataDir, "runs", today);
  const written: string[] = [];
  const note = `The reader was stopped at ${hhmm(at)} before it finished.`;
  const specs = path.join(folder, "specs", "summary.json");
  if (!fs.existsSync(specs)) {
    fs.mkdirSync(path.dirname(specs), { recursive: true });
    fs.writeFileSync(specs, JSON.stringify({ date: today, status: "stopped", stoppedAt: at.toISOString(), model, useForScoring: false,
      counts: { listed: 0, ok: 0, unreliable: 0, notReadable: 0, closed: 0, failed: 0 }, medianSeconds: null, medianTokensPerSecond: null,
      warnings: [`${note} Part 2 reads the adverts in the cloud.`], ledgerId: null }, null, 2));
    written.push(specs);
  }
  const replies = path.join(folder, "replies", "summary.json");
  if (fs.existsSync(path.join(folder, "replies", "found.json")) && !fs.existsSync(replies)) {
    fs.writeFileSync(replies, JSON.stringify({ date: today, status: "stopped", stoppedAt: at.toISOString(), model, firstLook: false, grade: null,
      counts: {}, replies: [], warnings: [`${note} The replies were not read: tomorrow's mail read carries them forward (or run npm run read-replies before part 2 runs).`], ledgerId: null }, null, 2));
    written.push(replies);
  }
  return written;
}
