# Job Scout: five-minute demo script

A spoken walkthrough of Job Scout on made-up data. It follows one demo run from email to board. Backlog H17, Sprint 8.

**Before the meeting (about 15 minutes, not part of the five):**

1. On the PC, start Ollama, then run `npm run demo`. It prints how many roles it found and how many adverts it read.
2. Ask Claude: "run the Job Scout demo for today". Claude follows `demo\DEMO.md` and writes to the demo board only.
3. Open the demo board (the artifact you published from `demo/board/demo-board.html`) and the run folder `data\demo\<date>\`. Check the banner at the top of the board says it is the demo.

Everything shown is invented: the candidate (Sam Calder), every company and every address. No real data appears on screen.

## 0:00 to 0:45  The problem

> "Senior job searching is mostly reading. Every morning there are job alerts from several sites, most of them wrong for me. Job Scout reads them for me, scores each role against my own career record, and drafts the documents for the best ones. It never applies or replies for me: every decision stays with me."

Show: the demo board, with three earlier applications already on it.

## 0:45 to 1:45  The morning, in four parts

> "The work is split by what each part is trusted to see."

Show the architecture overview (`ARCHITECTURE-OVERVIEW.png`) and point to the four parts:

- **Mail read on the PC.** Plain code reads the alert emails. No AI. It removes duplicates and roles that fail the hard rules (level, place, pay).
- **Advert reader on the PC.** A small local model (Ollama) reads each advert. The advert text never leaves the PC at this step.
- **Scoring in the cloud.** Claude scores the roles against the career record, with a fixed checklist of eight criteria.
- **Packs.** For the best roles, Claude drafts a CV and covering letter, then a **separate reviewer** checks every claim against the record.

Show in the run folder: `demo-run.json` (roles found, roles dropped, adverts read).

## 1:45 to 3:00  Two attacks, both caught

> "Two of the demo emails and adverts are hostile on purpose. Strangers write job adverts and emails, so the system treats their text as data, never as instructions."

- **The hostile advert (Marlow Health).** It contains a hidden line telling the AI to give it a top score. Show the digest's Problems section: the line was found, removed and reported. The score uses only the real requirements.
- **The fake offer (Northgate Finance).** It offers a job and asks for bank details. Show the board: the reply has an amber warning, "check it is genuine before you answer". Job Scout never replies and never opens links in replies.

## 3:00 to 4:15  The result

Show the board:

- **Shortlisted roles** as Draft cards, each with a score, the main strength and the main gap.
- **Worth a look:** roles just under the line (55 to 59) are listed in the digest, so a near miss is not lost.
- **Replies:** the invitation is now a calendar event and a to-do; the rejection is a suggestion to move its card to Rejected, with Confirm and Dismiss: until the reply reader has passed my grading, nothing moves by itself.

Open the pack folder: the CV and letter, and the reviewer's notes. Point to the lines the reviewer left for the user to sign off.

> "The reviewer did not write the pack and does not see the writer's reasoning. It only checks each claim against the record. That separation is the point."

## 4:15 to 5:00  How it is kept honest

> "Every change is tested before it runs on real data."

- <!-- fact:code-tests -->166<!-- /fact --> automatic code tests and <!-- fact:tool-tests -->206<!-- /fact --> tool tests.
- A red-team test set of hostile adverts and emails, run after each change to the reader.
- An evaluation that compares the AI's scores with the user's own judgement.

Close with the boundaries: it never applies, never replies, never changes a document already sent, and the board belongs to the user alone.

## If something goes wrong

- **Ollama is not running:** the demo still runs and says the reader was skipped. Say so, and show the cloud reading the adverts from the demo folder instead.
- **The board is empty:** step 3 of `DEMO.md` adds the three earlier applications. Ask Claude to run it again.
- **Short of time:** skip the pack folder (3:00 to 4:15) and go straight to the boundaries.
