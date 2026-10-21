# Decisions

Why Job Scout is built the way it is. Numbered so the backlog and reviews can refer to them.

## D1. Two halves: code to read and filter, Claude to score

Reading mail, parsing and applying fixed rules are mechanical and should behave the same every day, so they are code with tests. Judging fit against a career is not mechanical, so it is done by Claude following a written procedure (`_context\job-scout\SCOUT.md`) against a rubric the user can read and change. The hand-over between them is a folder of files, so either half can be run, checked or replaced on its own, and the scoring half can later run as a scheduled task.

## D2. Proton Mail Bridge, read-only

Proton Mail has no public API. Bridge exposes the mailbox over IMAP on the computer itself, which keeps the mail on the machine. Settled with the user on 14 Oct 2026. The client opens the folder with `EXAMINE` and fetches with `BODY.PEEK`, so it cannot change the mailbox or mark mail as read. Bridge's self-signed certificate is accepted only for a server on 127.0.0.1.

## D3. No runtime dependencies

As with the task app: Node runs the TypeScript directly, and everything the scout does is in `src\`, readable end to end. This meant writing a small IMAP client and email parser rather than using libraries. Both cover only what job alerts need, and both are tested, including against a stand-in Bridge server.

## D4. LinkedIn pages are not fetched automatically

LinkedIn's terms bar automated access, and Claude's web fetch tool refuses LinkedIn pages (checked 14 Oct 2026). The user accepted the risk of reading their own email, which is a different thing from fetching LinkedIn's site. So the scorer looks for the same advert on the company's own careers page (most roles are posted there too), and otherwise opens the LinkedIn page in the built-in browser when the user is present, or scores from the alert and says so. Revisit at the Sprint 1 review if too many roles end up scored from the alert alone.

## D5. Drop only on a clear failure

LinkedIn and hackajob already filter on the user's saved searches. A role wrongly dropped is never seen again; a role wrongly kept costs a minute of scoring. So a hard filter drops a role only when the alert clearly fails it, and anything unclear passes with a flag. Every drop is listed in `run.md` with its reason.

## D6. Seen-before is by run date

A role is "seen before" only if an earlier day's run saw it. Running twice in a morning gives the same answer, and a day's overlap in the look-back costs nothing.

## D7. Where things live

Code and config in `Projects\Job Scout` beside the task app, in git. The rubric, profile and procedure are Markdown in the `_context` vault, so the user and any agent can read them and the vault stays the master record. Run data (emails, roles, digests) is personal and stays in `data\`, outside git.

## D8. hackajob roles are keyed by company and title

hackajob's links are tracking redirects that differ in every email, so the same role would look new each time. A role's id is built from its company and title instead, and its link is unwrapped from the redirect so it opens the role directly. Settled after the first real run, 14 Oct 2026.

## D9. Drop other functions, keep plain titles with senior pay

From the first real run: titles with no product word that name another function (engineer, delivery, architect and so on) are dropped. A plain "Product Manager" title passes with a flag when its published pay clears the UK floor, since some companies title senior roles that way (Sierra, £150k–£300k).

## D10. Rubric v2: let near misses through with a flag

The user accepted all five back-test proposals on 14 Oct 2026. In the code: UK permanent pay within 10% of the floor passes with a flag (bonus or on-target earnings may clear it), and a role based abroad passes with a flag when it is remote or a consultancy, contract or fractional role. In the rubric: AI 10, Proof-point fit 25, threshold 60, Scope judged on its own terms for teaching, fractional and consultancy roles, and the Senior PM cap raised to 10 for a sole product owner. Same principle as D2: a wrongly dropped role costs more than one more role to score.

## D11. Warning signs and age are shown, never used to drop

The code reads what it can from the alert (agency poster, unnamed client, NDA, 200+ applicants, reposts, days since the alert) into `verdict.warnings`. They reach the scorer and the card. Only the scorer, reading the full advert, can drop a role as closed. LinkedIn's alerts carry no posting date or applicant count, so those come from the advert.

## D12. Carry-over lives in a file the scorer writes

Roles that clear the threshold but miss the cap go into `data\carryover.json`, written by the scoring step. The next run offers each again, at most twice, so a strong role on a busy day is delayed, not lost.

## D13. Folder links through a jobscout: address

Browsers will not open a local folder from a web page. The board's "Open folder" link uses a `jobscout:` address, registered for the local Windows account by `scripts\install-folder-links.ps1`, which runs `scripts\open-folder.ps1`. That script opens only an existing folder inside Professional development and refuses anything else. "Copy path" is the fallback.

## D14. The learning loop proposes; the user decides

The weekly and monthly reviews (vault `WEEKLY.md`) count, compare packs as built with packs as sent (`tools\pack_diff.py`, against `baseline.json`), and write proposals into `learning-log.md`. No agent changes the rubric, profile or banks without their acceptance.

## D15. Settings live on the board, and reach the PC through the scorer

The user asked for everything worth changing to be editable in the app. The board is the only screen, and a claude.ai page cannot write files on the local PC, so the settings are a document in the board's database. The morning run (which can reach both) reads them, scores with them at once, and copies them to `config\settings.json` for the next mail read. The cost is a day's delay on filter changes, stated in the dialog. The code treats the copy as an overlay with a per-field fall-back to the JSON files, so a bad value never stops a run. Schedule times stay out of Settings: changing them means changing a Windows task or a Claude scheduled task, which a web page should not do.

## D16. The Bridge password lives outside both shared folders, encrypted for one account

Claude's scheduled tasks can read the Job Scout and Professional development folders, and they read text written by strangers. A plain password in `.env` was one injected instruction away from leaking. Windows DPAPI encrypts it for the local Windows account on this PC with no extra software, and `%LOCALAPPDATA%` is outside both folders and outside Proton Drive sync. The cost: the password must be set again on a new PC or a new Bridge password, which the script makes a one-minute job.

## D17. Untrusted text is cleaned in code and handled as data in the procedure

No single defence stops prompt injection, so there are three layers: code removes instruction-like lines and caps lengths before the AI sees the alert; the procedure tells the AI to hold advert text between markers and report anything that addresses it; and the output checker (D18) catches what gets through. A removed line is reported and flagged rather than silently dropped, because an advert that tries to instruct a screener is itself a warning sign. The patterns were tested against ordinary advert wording so that "Experience with Claude, Copilot and Gemini" is kept.

## D18. Outputs are checked by code the AI cannot change

`tools\validate.py` uses only the Python standard library, so it runs in any Claude workspace without installing anything. It checks arithmetic and shape, not judgement: a score that does not add up, a card that is not a draft, or an extra field is stopped; whether a score is fair is still the user's call. The procedures forbid editing the checker to make an output pass.

## D19. One pause switch, on the board, honoured by every part

The board is the one screen the user uses, so the switch is there. Each part checks it first: the morning and weekly runs stop and say so, and copy it to the PC so the mail read stops the next day. Pausing loses nothing, because the mail read is read-only and the look-back starts from the last successful read.

## D20. An agent only where isolation, independence or on-demand use requires one (agreed 16 Oct 2026)

Splitting every skill into its own agent adds hand-offs, cost and failure points, and reads as over-engineering. So a step becomes an agent only when it reads untrusted text (isolation), judges another step's work (independence), or needs to be called by itself (on demand). That gives three specialists around the morning run (a local advert reader, a pack writer and an independent reviewer); reading mail, filtering, the ATS count and every format and output check stay as code. The shape is confirmed by a spike (H13) before the run is rebuilt.

## D21. Privacy tiers: each kind of data behind a boundary in the architecture (agreed 16 Oct 2026)

The mailbox is seen only by code on the PC, searching the alert senders read-only; raw copies live in the user's private store, not a folder the cloud can reach (H14). Adverts, the untrusted text, are read by a local model on the local PC with no tools, and only a checked job spec leaves the PC (H5). The career vault is seen only by the cloud writer and reviewer. The Bridge password is seen by nothing (D16). Code that never reads the inbox is the strongest guarantee, so the local model is used where it adds isolation, not as a substitute for data minimisation.

Update, 16 Oct 2026: from Sprint 6 (epic I, the application inbox) the mailbox tier widens by one step, agreed by the user. The code also fetches replies from companies, recruiters and hiring systems on their board or tracker, still read-only, and the local model reads them, so no email reaches the cloud. The scout may now change the status of their own cards, but only by the rules in I4, always logged, always with Undo.

## D22. Target employers change the order and the places, never the score (agreed 16 Oct 2026, B13)

The user wants Google and Microsoft roles never lost below the line or the cap. Boosting their scores would make every score less honest and the weekly comparison by score band meaningless. So a target role is read first, listed in its own digest section, and may take one of two places beyond the daily cap; one below the threshold gets a pack only if the user turns that on. The score is the rubric's, as for any other role.

## D23. Sources are one list, and the employer's own record wins (16 Oct 2026, B12)

Adding Google and Microsoft showed sources hard-coded in five places. They are now one list (`SOURCES` in `src\role.ts`) that the email kinds, source health and history follow, so the next source (B14's suggestions, say) needs a parser and one line. When the same role arrives from an employer's alert and a job board's, the employer's record is kept: its link opens the advert directly and needs no LinkedIn page.

## D24. Isolation comes from the PC, not from sub-agents (H13 spike, 16 Oct 2026)

The spike found that a scheduled run's sub-agents can be held to named tools only by a definition loaded when the session starts; the built-in types still have a shell, the web and the bridge to the PC. So the step that reads untrusted adverts runs on the PC, in Ollama, with no tools at all, which is stronger than any sub-agent setting. Sub-agents stay the tool for independence (H6), whose only output `validate.py` checks. G6 (a private repository) would make tool-limited agents possible later.

## D25. The cloud finds adverts, the PC reads them (H5, chosen by the user, 16 Oct 2026)

On its own the PC reached 9 of 119 roles through public job-board APIs. Given the addresses the morning run had found, it fetched all five of that day's adverts, in full where the cloud gets summaries. So the morning run finds each advert's address by search and stops; the PC fetches and reads it with the local model; the morning run scores from the checked spec. Because both models tested invented requirements for a page with no advert text, every page passes an input-quality gate first and every extracted requirement is checked against the advert's own words.


## D26. An independent reviewer whose evidence code can check (H6, agreed with the user, 16 Oct 2026)

The agent that writes a pack no longer has the last word on its own claims or its own ATS gaps. A second agent, given only the pack, the ATS result and the vault, judges every sentence of the CV Summary, highlights and letter. Its verdicts follow the positioning tiers, both ways: supported, compressed (the strongest accurate framing, which is good), unsupported, and hedged (a caveat the positioning rules say to drop), plus no-claim for letter sentences that say nothing about their record. A supported or compressed verdict must quote a vault line, and `validate.py claims` confirms the line is really there, so the review cannot pass on the reviewer's say-so. Unsupported lines go back to the writer once, then to the top of the user's sign-off list (their choice: a strong role should not arrive with no pack); hedges are suggestions only. The reviewer reads and never writes; code checks that the pack's files are unchanged after review. Where a scheduled run can load the `reviewer` agent definition from the repository (G6), it also has read-only tools.

## D27. Wider places, and any product title in a second market (the user, 17 Oct 2026)

On reading the first dropped list, the user widened the hard filters: they need not be London-based and would consider another major city for the right role, so a UK role anywhere passes, flagged when outside London or vague; target employers' roles in the EU pass; and in a second market, named in config, any product-related title passes whatever its seniority, since the user can be less choosy there. The one showstopper they named is a required language other than English. The filters still drop only clear failures; the scorer weighs the rest.

## D28. Replies are read on the PC; the scout moves a card only when it has earned it (Sprint 6a, the user, 17 Oct 2026)

Replies to applications are found by code and read by the local model on the PC, as the adverts are, so no email reaches the cloud: part 2 sees a summary of sender domain, type, company, role, dates and a quoted ask. Moving a card is the first change the scout makes to something the user owns, so it is earned in steps: until the model has passed their grading on their own replies, and always for the first 60-day look back, a move is a suggestion the user confirms; after that, a move is made only for a verified sender and a complete read, and is logged with Undo. The rules are fixed in code (`tools\replies.py`) and checked again before writing (`validate.py moves`): nothing moves backwards, a Draft or Archived card never moves, and a reply already acted on, undone or dismissed is never acted on again. Nothing is ever replied to, accepted or opened.

## D29. Assurance is measured, not asserted (Sprint 7, the user, 17 Oct 2026)

Four answers from the user set the bar. **Drift** is judged against their own labels on about 40 scored roles, and flagged at a drop of more than 10 points in agreement or any new false negative, since a role they would apply for that scores below the line is the one mistake he never sees; nothing changes automatically. **Red team** quarterly, by a reminder: the user runs the PC half, Claude the cloud half, never on real data, and every failure becomes a BUG row. **Retention** 90 days for adverts, specs and reply summaries, keeping those for roles he applied for; without the keep list nothing is deleted (fail safe). **Disclosure:** one approved answer, word for word in every pack. The reader's checked answers come from qwen2.5:14b's graded answers, so they measure drift in that model well and a new model less fairly: a new model that falls short is graded by hand before a decision. The evaluation set is kept in the vault, outside the 90-day rule, because it is frozen on purpose; its advert copies are cleaned of instructions and contact details. The risk register is organised by the NIST AI RMF functions and reviewed at every sprint close.

