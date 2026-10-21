// npm run check-bridge — confirms the scout can read your mail through
// Proton Mail Bridge, without fetching any email content.
// Prints your folders and how many alert emails each sender sent in 7 days.
// To look for other senders over 30 days, in your reading folder and All Mail:
//   npm run check-bridge -- careers-noreply@google.com careers.microsoft.com

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./config.ts";
import { checkConnection } from "./imap.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = loadSettings(root);

if (!settings.imap) {
  console.log("Bridge is not set up yet: run scripts\\set-bridge-password.ps1 once, with the user name and password from Bridge's mailbox settings.");
  if (settings.credentialProblem) console.log(settings.credentialProblem);
  process.exitCode = 1;
} else {
  const s = settings.imap;
  const extra = process.argv.slice(2).filter((a) => a.trim() !== "");
  const senders = extra.length > 0 ? extra : settings.sources.senders.map((x) => x.from);
  const days = extra.length > 0 ? 30 : 7;
  checkConnection(s, senders, days, extra.length > 0 ? ["All Mail"] : [])
    .then(({ folders, counts }) => {
      console.log(`Connected to Bridge at ${s.host}:${s.port} as ${s.user} (password from the ${settings.credentialSource}).`);
      if (settings.credentialProblem) console.log(`Note: ${settings.credentialProblem}`);
      console.log(`Folders: ${folders.join(", ")}`);
      console.log(`Reading folder "${s.folder}". Matching emails in the last ${days} days (counts only, nothing opened):`);
      for (const c of counts) console.log(`  ${c.folder} | ${c.sender}: ${c.count}`);
      if (counts.every((c) => c.count === 0)) {
        console.log("None found. If your job alerts are filed into another folder, set BRIDGE_FOLDER in .env to that folder's name from the list above.");
      }
    })
    .catch((err) => {
      console.error(`Could not read mail through Bridge: ${(err as Error).message}`);
      console.error("Check Bridge is open and signed in, and that the password stored by scripts\\set-bridge-password.ps1 is the Bridge password (not your Proton password).");
      process.exitCode = 1;
    });
}
