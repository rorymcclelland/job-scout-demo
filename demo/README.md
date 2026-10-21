# Job Scout demo

A safe demo of the whole system on made-up data (backlog H16, Sprint 8). Nothing here is real: the candidate, every company and every person are invented, and every company, person and advert address ends in `.example`, which no real site can use (the alert emails keep LinkedIn's and hackajob's own link formats, which lead to no real role).

The candidate, **Sam Calder**, is a lightly disguised version of the owner's own record, so the story stays realistic: names, employers, dates and figures are all changed. The same honesty rules apply as for real use: no barred claims, and nothing presented as achieved that the record calls a plan. A test (`test/demo.test.ts`) refuses any real employer, client or the owner's own name anywhere in this folder.

| Folder | What |
| --- | --- |
| `candidate\` | The demo vault: about, positioning, candidate profile and four career notes |
| `documents\` | The base CV and covering letter the pack builder edits (made by `make_documents.py`) |
| `emails\` | Three job alerts (two LinkedIn, one hackajob) and three replies: an invitation with a calendar file, a rejection, and a fake offer asking for bank details |
| `adverts\` | Six adverts served to the reader from this folder, one of them hostile; `index.json` maps each role to its address |
| `settings.json` | The demo's settings, laid over the real defaults |
| `watchlist.json`, `applications.md` | The demo's three earlier applications, so the replies have cards to match |
| `board-seed.json` | Those three cards, for the demo board |
| `DEMO.md` | Claude's half of the demo, on the demo board only |

**Run it:** `npm run demo` on the PC (Ollama running for the local reader; without it the demo still runs and says the reader was skipped). It writes only under `data\demo\<date>\`, never the real run folders, private store, vault or mail. `npm run demo -- --reset` clears it. Then ask Claude: "run the Job Scout demo for today" (DEMO.md). The five-minute walkthrough is `docs\DEMO-SCRIPT.md`.
