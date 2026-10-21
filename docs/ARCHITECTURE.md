# Job Scout: architecture

_Version 0.9.0 · 17 October 2026_

## Shape: two halves and a hand-off

The system is split where judgement starts.

1. **The code half** (`npm run scout`, this folder) does everything that can be done mechanically and checked by tests: read mail, parse, de-duplicate, apply the hard filters, flag warning signs, and write a run folder. It uses no AI, sends nothing anywhere and has no runtime dependencies.
2. **The judgement half** is Claude following written procedures in the vault (`Professional development\_context\job-scout\`): score against the rubric, read adverts, write the digest, build packs and cards, and once a week summarise and propose. Claude works on the local PC only through file tools (list, stage, commit), so it cannot run commands there; anything that needs running (`build_pack.py`, `weekly.py`, `pack_diff.py`) runs in Claude's own workspace on copies.

The run folder, `data\runs\<date>\`, is the hand-off: the code writes `status.json`, `run.md` and `candidates.json`; Claude reads them and adds `digest.md`, `scores.json` and `adverts\`.

```
┌──────────── Local PC ──────────────────────────────────────────────┐
│ Proton Mail Bridge (IMAP on 127.0.0.1)                            │
│        │ read-only: EXAMINE, UID SEARCH, BODY.PEEK                 │
│        ▼                                                           │
│ Job Scout code ── data\runs\<date>\ ── data\seen.json, state.json  │
│  (Windows tasks 06:30, 07:45) ▲ │   Ollama (local model, no tools) │
│                              │  ▼                                  │
│ Professional development\    │ files staged and committed by Claude│
│   _context\job-scout\*.md ───┘  (procedures, rubric, profile, banks)│
│   _context\applications.md      (tracker, master record)           │
│   <Company> - <Role>\           (packs)                            │
└────────────────────────────────────────────────────────────────────┘
        ▲ remote-device file tools          ▲ ArtifactData
┌───────┴──── Claude (scheduled tasks) ─────┴────────────────────────┐
│ Part 1 07:23 · Part 2 08:10 daily · Weekly summary 08:50 Mondays  │
│ workspace: build_pack.py, weekly.py, pack_diff.py, LibreOffice     │
└────────────────────────────────────────────────────────────────────┘
        │ db collection "applications"
        ▼
  Application Pipeline board (claude.ai artifact, private to the user)
```

## The code half

| Module | Job |
| --- | --- |
| `src/scout.ts` | The run, start to finish. Collects raw mail (Bridge and `data\inbox\*.eml`), parses, merges same-day duplicates, de-duplicates against the tracker and the seen list, filters, adds carry-over, records source health, writes the run folder and state |
| `src/imap.ts` | A minimal read-only IMAP client. STARTTLS or SSL; Bridge's self-signed certificate accepted only for a server on this computer; 60-second read timeout; the password is never echoed in errors |
| `src/mime.ts`, `src/html.ts` | Email to text: multipart, quoted-printable, base64, encoded words; HTML to text with links kept as `{{url}}` |
| `src/parsers/` | LinkedIn alert layouts (text, HTML, "jobs you may be interested in" cards) hackajob's "Archer" emails, and Google's and Microsoft's careers alerts (0.6.0) into `Role` records; tracking links unwrapped. `src/role.ts` holds `SOURCES`, the one list of sources the rest follows |
| `src/pay.ts` | Pay ranges from text: currency, period, min and max |
| `src/filters.ts` | The hard filters (level, location, pay) with a reason for every drop, flags for anything unclear, and warning signs and age (never a reason to drop) |
| `src/dedupe.ts` | Tracker matching (company words plus 60% title overlap), seen-before and repost detection, same-day merging |
| `src/report.ts` | `run.md`: what was read, scored, dropped and why, and source health |
| `src/config.ts` | Settings from `config\*.json`, the board's `settings.json` overlay, and the Bridge credentials; reports the pause switch |
| `src/secrets.ts` | Where the Bridge credentials come from (H1): `%LOCALAPPDATA%\JobScout`, the password decrypted with Windows DPAPI; a password still in `.env` works but is reported |
| `src/untrusted.ts` | Alert text is data (H2): caps each field's length and removes lines that talk to an AI, try to override instructions, steer a score or ask for data to be sent; each removal is reported |
| `src/read-adverts.ts`, `src/reader/` | The advert reader on the PC (H5, 0.8.0): fetches each address from part 1's `advert-urls.json` (public job-board APIs first, robots.txt respected, never LinkedIn), refuses pages without enough readable advert text, cleans with `untrusted.ts`, has the local model (Ollama, no tools, fixed JSON shape) copy the facts, keeps only the requirements and pay found in the advert's own words, writes `specs\<id>.json`, unloads the model and adds its ledger entry |
| `src/check-bridge.ts` | `npm run check-bridge`: connects, lists folders, counts alert emails, reads no content |

### Run sequence

0. If the settings say the scout is paused (`control.paused`), stop: read nothing, write no run folder, leave the seen list and `state.json` as they are.
1. Work out the look-back date: the day before the last successful run (seven days on the first run, or `--days N`).
2. Fetch from Bridge (if set up) and read `.eml` files from `data\inbox`. Copy every email into the private store on this PC, `%LOCALAPPDATA%\JobScout\emails\<date>\` (H14, 0.7.0), never into the run folder the cloud reads; copies are deleted after 30 days, and an inbox file is removed from the inbox once a run has read it. `npm run share-email` copies one chosen email out when a parser needs fixing.
3. Parse into roles; clean each title, company, location, note and excerpt with `untrusted.ts`; merge duplicates across alerts the same day. A role that had lines removed keeps its place in the run but carries the warning "Instruction-like text was removed from the alert".
4. Each role is **known** (on the tracker or seen in an earlier run), **dropped** (fails a hard filter, with the reason) or **to score** (with flags and warnings).
5. Add carried-over roles from `data\carryover.json` (at most two carries each).
6. Check source health: a source that has sent before but sent nothing for two runs is reported.
7. Write `roles.json`, `candidates.json`, `run.md` and `status.json`. Only if the fetch succeeded, mark roles as seen and advance `state.json`, so a failed fetch never loses mail.

## The judgement half

| Procedure (vault) | Run by | Produces |
| --- | --- | --- |
| `SCOUT.md` | Morning scheduled task | Scores, digest, carry-over, metrics line, tracker sync, then PACK.md for the shortlist |
| `PACK.md` | Within the morning run | Pack folder, Draft card, Scouted row |
| `REVIEW.md` | The reviewer, a sub-agent of part 2, once per pack (H6, 0.9.0) | `claims.json`: every sentence of the CV Summary, highlights and letter judged against the career notes, and the ATS gaps judged; checked by `validate.py claims` |
| `WEEKLY.md` | Monday scheduled task | Weekly summary; monthly learning proposals |
| `rubric.md` (v3) | Read by SCOUT.md | Weights, anchors, threshold 60, cap 5 |
| `candidate-profile.md` | Read by SCOUT.md and PACK.md | Targets, proof points by theme, known gaps, barred claims |
| `form-answers.md`, `highlight-proposals.md` | PACK.md | Form answers per pack; highlights waiting for approval |
| `learning-log.md` | WEEKLY.md | Proposals waiting for the user |

**The reviewer (H6, D26).** The writer does not have the last word on its own claims. After a pack builds, part 2 gives a second agent only the pack's CV and letter, `ats.json`, `REVIEW.md` and the career notes, never the writer's spec or reasoning, and runs one per pack in parallel. Where the scheduled run can load `.claude/agents/reviewer.md` from the private repository (G6) the reviewer has read-only tools; either way it writes nothing, and `validate.py claims` checks its quotes against the vault and that the pack's files are unchanged. Unsupported lines go back to the writer once, then to the user's sign-off list.

`tools/build_pack.py` edits copies of the user's own documents (the two-page base CV and a previous letter), so a pack always looks like their. It changes only the Summary, the three highlights and the location line, exports PDF with LibreOffice, writes Markdown and `baseline.json`, and fails the build if the CV is not exactly two pages with Google starting page two, if the letter runs past one page, or if an em dash or barred claim appears.

## Settings

Everything that used to be fixed in files and is worth changing is edited in the board's **Settings** dialog and stored as one document, `settings/current`, in the board's database. The dialog validates each value (ranges, whole numbers, weights totalling 100, caps within the Scope weight, a sensible letter range), raises the settings version on every save and the rubric version when a scoring value changes, and keeps a change log.

```
Board Settings ──save──▶ settings/current (board database)
                              │ read each morning (SCOUT.md step 0)
                              ▼
          Claude morning run: scores with the weights, threshold and caps at once;
          builds packs with the letter range and CV location
                              │ writes when the version changes
                              ▼
          Job Scout\config\settings.json ──▶ next 06:30 mail read: floors, places,
                                              words, senders, carry-over limit
```

The code treats `settings.json` as an overlay: field by field, anything missing or invalid falls back to `constraints.json` and `sources.json`, so a bad setting can never stop the mail being read. The Windows and Claude schedule times are shown in Settings but not set there: changing them means re-running the Windows script or asking Claude to change a scheduled task.

## The board

The Application Pipeline is a claude.ai artifact (private to the user) with a shared database collection, `applications`. The scout writes only its own Draft cards (ids `scout-…`). The page renders the scout's fields (score, source, age, warnings, pack) and offers Archive with a reason, Snooze 7 days, stage changes and Open folder / Copy path. Text is always set with `textContent`, and only `http(s)` advert links become links. Fields are listed in [DATA](DATA.md#board-cards).

**Open folder.** Browsers will not open a local folder from a web page, so the link is `jobscout:open?folder=<name>`. `scripts\install-folder-links.ps1` registers that address for the local Windows account only; `scripts\open-folder.ps1` handles it and opens a folder only if it exists inside Professional development, refusing `..`, drive letters and odd characters. Copy path is the fallback.

## Replies to applications (Sprint 6a, 0.10.0)

The same privacy tiers as the adverts (D21, D28). Code on the PC finds the replies (`src\inbox\`: hiring systems' mail domains, LinkedIn's application updates, and the companies and recruiters on `data\watchlist.json`), judging each sender by address and DKIM, read-only. The local model reads each one with no tools (`src\read-replies.ts`, `src\reader\reply.ts`), and code keeps only what is in the email's own words and reads calendar files itself. Part 2 sees only `replies\summary.json`: it matches each reply to a card and decides what to do with `tools\replies.py`, checks every board patch with `validate.py moves`, writes exactly those patches, and writes tomorrow's watch list. Until the reader passes the user's grading (`npm run grade-replies`), and always for the first 60-day look back, a move is a suggestion he confirms on the card; after that a verified, fully-read reply moves the card by fixed rules, logged with Undo. See `docs\WORKFLOW-MAP.md` for where this sits in their day.

## Scheduling

| What | When | Where | Catch-up |
| --- | --- | --- | --- |
| Windows task "Job Scout wake" (`scripts\keep-awake.ps1`) | 06:25 daily | Local PC, mains power only | Wakes the PC and keeps it awake until about 08:55 (G7); never on battery, no catch-up |
| Windows task "Job Scout" (`npm run scout`) | 06:30 daily | Local PC | Start-when-available: runs on wake. Also finds replies to applications (Sprint 6a) |
| Claude task "Job Scout morning run" (part 1) | 07:23 daily, Europe/London | Claude, bound to the local PC | Provisional scores and advert addresses for the most recent run folder |
| Windows task "Job Scout reader" (`npm run read-adverts`) | 07:45 daily | Local PC | Runs on wake; waits up to `reader.waitMinutes` for part 1; then reads the replies (`read-replies`) |
| Claude task "Job Scout scoring" (part 2) | 08:10 daily, Europe/London | Claude, bound to the local PC | Scores the most recent unscored run folder; reads in the cloud what the PC could not |
| Claude task "Job Scout weekly summary" | 08:50 Mondays | Claude, bound to the local PC | The next Monday covers the next week |

The Claude tasks need the PC awake with the Claude desktop app open; they send a push notification, and say in one line when the PC could not be reached (they cannot catch up on wake).

## Governance (Sprint 4, 15 October 2026)

The AI half reads text written by strangers and can reach two folders on the local PC, so four guardrails contain what it can do. They follow the risk review agreed on 15 October 2026 (backlog Epic H).

| Guardrail | Risk it addresses | How |
| --- | --- | --- |
| **H1 Secrets out of reach** | A manipulated or mistaken run reads the Bridge password from the Job Scout folder | `scripts\set-bridge-password.ps1` stores the user name in `%LOCALAPPDATA%\JobScout\bridge.env` and the password in `bridge-password.dpapi`, encrypted with DPAPI for the local Windows account, in a folder only he can open, outside both folders the scheduled tasks reach. It tests Bridge, then offers to delete `.env`. `src/secrets.ts` reads only from there; a password left in `.env` still works but is reported in every `run.md` |
| **H2 Text is data** | Prompt injection: an advert or email that tells the AI to score it 100, change its rules or send data somewhere | Code removes instruction-like lines and caps lengths before anything reaches the AI, reports each removal under "Untrusted text" in `run.md`, and turns it into a warning sign. SCOUT.md tells the AI to hold advert text between markers, treat it as material to assess, and report anything that addresses it |
| **H3 Check before writing** | A malformed or manipulated output reaching the user's board or files | `tools\validate.py` (standard library only) checks every `scores.json`, `carryover.json`, `pack.json` and board card before it is written: fields and types, the eight criteria within their weights and adding up to the score, the rubric version, threshold and daily cap, draft-only cards with a fixed field list, no duplicates, no em dashes, no instruction-like text in what the AI wrote. A failure writes nothing and goes into the digest's Problems |
| **H4 Pause and limits** | A run misbehaving while the user is away, or more reading and writing than a morning needs | A pause switch and an adverts-per-run limit on the board (Settings, Control). The morning and weekly runs check it first and stop; the code stops at the next mail read; the board shows a Paused line until it is switched off |

What Sprint 4 could not change: the Claude scheduled tasks still reach both folders in full (the packs and the vault need them) and carry the Claude_Docs and Claude_Code_Remote connectors. Folders and connectors cannot be changed from a conversation; the user can remove a connector a task does not need in the task's own settings.

## Safety and privacy

- **Mail:** read only, enforced twice (`EXAMINE` and `BODY.PEEK`); a test asserts no mailbox-changing command is ever sent. The Bridge password lives outside the project, encrypted for the local Windows account (H1).
- **Personal data:** run data, emails and the seen list stay in `data\`, which git ignores. The code sends nothing to any service. The Claude half does copy files from the PC into Claude's own cloud workspace to work on them (the run folder, the vault notes it needs, the user's base CV and letter, pack folders for the monthly review), and writes the board through the artifact's database. That workspace is private to the user's account and temporary; the board is private to them.
- **Retention (H10, Sprint 7):** copies of emails are deleted from the private store after 30 days (H14). Adverts, specs and reply summaries in run folders are deleted after 90 days by the 06:30 mail read (`src\retention.ts`), except for the roles the user applied for, listed each morning by part 2 in `data\keep.json`. Without that list nothing is deleted. Digests, scores and ledgers are kept: they name companies and job titles, not people. Board cards never carry a contact's name, email address or phone number; `validate.py card` refuses the last two.

### What reaches Claude's workspace, and what never does

| Data | Where it lives | Reaches the cloud? |
| --- | --- | --- |
| Bridge password and user name | `%LOCALAPPDATA%\JobScout`, encrypted for the local Windows account | **Never.** No task can reach the folder |
| Raw emails (alerts and replies) | Private store, `%LOCALAPPDATA%\JobScout\emails`, 30 days | **Never.** Only parsed, cleaned role records and reply summaries leave the PC |
| Role records from alerts (title, company, location, pay, link) | `data\runs\<date>\roles.json`, `candidates.json` | Yes, for scoring |
| Advert text the reader fetched | `data\runs\<date>\adverts\`, 90 days unless applied for | Yes, cleaned, for scoring and packs |
| Specs the local model wrote | `data\runs\<date>\specs\`, 90 days unless applied for | Yes, for scoring, packs and the ATS match |
| Reply summaries (type, company, role, dates, an ask of 200 characters at most) | `data\runs\<date>\replies\summary.json`, 90 days unless applied for | Yes, to match replies to cards. Sender addresses stay on the PC as domains and hashes (`found.json`) |
| The user's vault notes, base CV and letter, tracker | `Professional development\_context` | Yes, the notes each step needs |
| Packs (CV, letter, fit-and-gap, form answers) | `Professional development\<company - role>` | Written there by the cloud |
| Board, inbox, to-dos, calendar | The Application Pipeline artifact's database | Yes: the board lives in the user's Claude account, private to them |
| Grading sheet for the reply reader | Private store | **Never** |
| Red-team cases (H9) | `test\redteam\`, made-up text only | The cloud half reads the scratch outputs, never real data |

- **LinkedIn:** pages are never fetched automatically (terms and robots.txt); adverts are read from companies' own careers pages or other public listings.
- **Honesty:** packs follow `shared\positioning.md`; barred claims and em dashes fail the build; new wording about the user's work is listed for their sign-off in each fit-and-gap analysis.
- **Folder links:** the handler opens folders only, only inside Professional development, and runs nothing else.
