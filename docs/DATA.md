# Job Scout: data reference

_Version 0.16.0 · 23 October 2026_

Every file and record the system reads or writes. Paths are relative to the folder that holds the Job Scout folder (the projects folder) unless they start with the Job Scout folder's own names.

## Configuration

### Bridge credentials (`%LOCALAPPDATA%\JobScout\`, outside every synced folder)

Written by `scripts\set-bridge-password.ps1`, readable only by the local Windows account, and out of reach of Claude's scheduled tasks.

| File | Holds |
| --- | --- |
| `bridge.env` | `BRIDGE_USER` and any other `BRIDGE_*` setting below. A `BRIDGE_PASSWORD` line here is ignored |
| `bridge-password.dpapi` | The Bridge password, encrypted with Windows DPAPI: only the local Windows account on this PC can decrypt it |

`JOB_SCOUT_SECURE_DIR` moves the folder (the tests use it).

### `.env` (Job Scout folder, never in git; optional since 0.5.0)

The keys below may still be set here; `BRIDGE_*` values here override `bridge.env`. A `BRIDGE_PASSWORD` here is used only when the secure store has none, and every `run.md` then warns about it.

| Key | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_USER`, `BRIDGE_PASSWORD` | none | The mailbox user and the password **Bridge** generates (not the Proton password). Without both, only `data\inbox` is read |
| `BRIDGE_HOST`, `BRIDGE_PORT` | `127.0.0.1`, `1143` | Where Bridge listens |
| `BRIDGE_SECURITY` | `starttls` | `starttls`, `ssl` or `none` |
| `BRIDGE_FOLDER` | `INBOX` | The folder the alerts arrive in |
| `CONTEXT_DIR` | `Professional development\_context` | The vault, for `applications.md` |
| `EML_FOLDER` | `data\inbox` | `.eml` files read on every run |
| `DATA_DIR` | `data` | Where runs and state go (tests point this elsewhere) |

### `config\settings.json` (written by the scoring run)

A copy of the board's Settings document (below), without its change log. The code lays its pay, warning, place, level and sender values, and `scoring.carryOverMax`, over `constraints.json` and `sources.json`, field by field: a missing or invalid value is ignored and the file's own value stands. A file that cannot be parsed is reported in `run.md` and ignored. `run.md` and `status.json` (`settingsVersion`) say which settings version the run used. Set `SETTINGS_FILE=none` in the environment to ignore it (the tests do).

### `config\sources.json`

`senders`: the From addresses searched, each with its source (`linkedin`: `jobalerts-noreply@linkedin.com`, `jobs-noreply@linkedin.com`, `jobs-listings@linkedin.com`; `hackajob`: `hackajob`; since 0.6.0, `google`: `careers-noreply@google.com` and `microsoft`: `careers.microsoft.com`). The sources with a parser are listed once, in `SOURCES` in `src\role.ts`; a sender under any other source name is read and counted as "other". `firstRunLookbackDays`: 7.

### `config\constraints.json` (version 3)

| Group | Holds |
| --- | --- |
| `targets` | Target employers (0.6.0, B13): `companies` (Google, Microsoft), `packBelowLine` (false), `extraPlaces` (2) |
| `level` | Leadership words, product words, other kinds of work (fractional, mentor and so on) with the context words that make them relevant, below-floor words, non-product roles, and `hardwareWords` (0.6.0, B11: dropped in every market) |
| `locations` | London places, UK places, an optional second market (`second`, named by `secondName`), remote-maybe-UK words, places elsewhere, and `openFromAbroad` (consultancy, contract, fractional and similar, which let a role abroad pass with a flag) |
| `pay` | `ukPermanentMinGBPPerYear` (the UK floor), `ukPermanentTolerance` 0.10, `ukContractMinGBPPerDay` (the day-rate floor), an optional `secondMin` and no fractional floor, `hoursPerDay`, rough currency conversions |
| `warnings` | `staleAfterDays` 21, agency words, unnamed-client words, NDA words, `applicantsWarnAt` 200 |

## Run data (`data\`, never in git)

### `data\runs\<date>\`

A role scored on request (H15, 0.13.0) has its own folder, `data\runs\<date>-req-<n>\`, with the same files for one role: its id is `request:<slug>` and its site `request`. Retention prunes it by its date. The demo (H16) writes the same files under `data\demo\<date>\runs\<date>\`, in a folder marked `.demo`, with `demo-run.json` (roles, adverts read, replies read) beside it; `npm run demo -- --reset` deletes only folders with that mark.

| File | Written by | Contents |
| --- | --- | --- |
| `provisional.json` | Claude, part 1 | `[{ id, provisional, readAdvert }]`: the provisional scores, and which roles were chosen for reading (0.8.0) |
| `advert-urls.json` | Claude, part 1 | `[{ id, url, foundBy, provisional }]`: where each chosen advert is published; checked by `validate.py urls` (https only, never LinkedIn, within the per-run limit) `foundBy` is one of careers page, job board, aggregator, alert (B16, 0.9.0) |
| `specs\<id>.json` | Reader (PC) | `{ id, url, status (ok, unreliable, not-readable, closed, failed), reason, via, model, chars, linesRemoved, seconds, spec, grounding, readAt }`. `spec`: title, company, location, workplace, employment, pay, mustHaves, niceToHaves, responsibilities, reportsTo, suspectedInjection, injectionLines. `grounding`: what the check kept and dropped. Checked by `validate.py jobspec` before use |
| `specs\summary.json` | Reader (PC) | Counts, the model, median time and speed, warnings (Ollama not running, model missing, running slowly, runtime changed), the ledger id; `ollamaVersion` (0.13.0, H19) and `skippedSlow`, the adverts left for part 2 when the model ran below 15 tokens a second (G9); `tokens: { in, out }`, the model's own counts (0.15.0, G11) |
| `staleness.json` | Mail read (PC), 06:30 | E16 (0.15.0): `{ checked, staleAfterDays, settingsVersion, packs: [{ pack, folder, level, reasons, built }], problems }`, every pack folder in Professional development and one folder down (0.16.0, BUG-8) compared with what its `pack.json` says it was built from; cards are matched by `folder`. Hashes and reasons only |
| `adverts\<id>.md` | Reader (PC) or Claude | The advert's text, between `<<<ADVERT` and `ADVERT>>>`: from the PC (cleaned, full text) or, where the PC could not read it, from Claude's reading |
| `run.md` "Emails read" | Code | The file names of the emails read (0.7.0). The emails themselves are kept only in the private store on the PC, `%LOCALAPPDATA%\JobScout\emails\<date>\`, for 30 days (H14); `npm run share-email -- <date> <file>` copies one to `data\shared-emails\` for a parser fix |
| `roles.json` | Code | Every role found, as judged records (below) |
| `candidates.json` | Code | The judged records with `stage: "score"` only |
| `run.md` | Code | Human-readable report: to score (with age, flags and warnings), dropped with reasons, already known, source health, problems |
| `status.json` | Code | `{ finished, bridge, ok, problems[], missed[] (0.16.0, G4: mornings with no run since the last), counts: { found, score, carried } }`. `ok` is false only when Bridge failed |
| `adverts\<source>-<id>.md` | Claude | The advert as read, with source URL and date |
| `digest.md` | Claude | The ranked digest: shortlist with per-criterion scores, below the line, dropped on reading |
| `scores.json` | Claude | One object per scored role (below) |
| `replies\found.json` | Code (PC), 06:30 | Sprint 6a (I1). `{ date, since, firstLook, read, watch: { written, entries }, replies: [{ id (r- and 12 hex), file, day, date, via (hiring-system, company, recruiter, linkedin), system, domain, cardIds, verified (DKIM), firstLook, thread: { id, parents } (hashes), carriedFrom (0.16.0: the morning it was first found, when carried forward unread, BUG-9) }] }`. No subject, no body: the emails are in the private store |
| `replies\summary.json` | Reply reader (PC), 07:45 | Sprint 6a (I2). `{ date, status, model, firstLook, grade: { passed, date, right, of }, counts, replies: [ the found fields, plus status (ok, partial, failed, missing), reason, read: { type, company, role, dates: [{ what, asWritten, date, time }], ask (a quote, 200 characters at most), askBy, partial, dropped }, calendar: { start, end, zone, organiserDomain, method }, links, warnings, untrusted ] }`. Checked by `validate.py replies`. From 0.15.0 also `tokens: { in, out }` (G11); from 0.16.0 `status: "stopped"` with `stoppedAt` when the reader was stopped by hand (BUG-9) |
| `replies\matched.json` | Claude, part 2 | Sprint 6a (I3, I4). The output of `tools\replies.py match`: `{ date, gradePassed, firstLook, counts, items: [{ replyId, cardId, type, action (move, suggest, log, unmatched, skip, unread), from, to, note, offer, ask, askBy, dates, calendar, warnings }], patches: [{ cardId, patch: { status?, log, suggestions? } }] }`. Checked by `validate.py moves` before any patch is written |

**Judged record** (`roles.json`, `candidates.json`):

```
{
  "role": {
    "id": "linkedin:4475346422" | "hackajob:<company>-<title>",
    "source": "linkedin" | "hackajob",
    "title", "company", "location",
    "workplace": "remote" | "hybrid" | "onsite" | null,
    "pay": { "min", "max", "currency", "period", "text" } | null,
    "url", "notes": [], "excerpt",
    "email": { "subject", "date", "messageId" },
    "parse": "full" | "partial"
  },
  "verdict": { "kept", "reasons": [], "flags": [], "warnings": [], "market": "uk" | "second" | "unknown" },
  "stage": "known" | "dropped" | "score",
  "ageDays": 2,
  "carried": { "from": "2026-10-14", "score": 66, "carries": 1 }   // only on carried roles
}
```

**Score record** (`scores.json`): `id`, `title`, `company`, `url`, `site`, `location`, `pay`, `posted`, `alerted`, `applicants`, `score`, `criteria` (`name`, `points`, `max`, `rationale`), `why`, `gaps`, `warnings`, `lead`, `advert` (saved file or null), `carried`, `shortlisted`, `band` (`shortlist`, `look` for the worth-a-look band from `scoring.lookBand` to just under the threshold, or `below`; 0.13.0, C9), `rubricVersion`. The 14 October 2026 file predates `site`, `alerted` and `carried`.

### Files across runs

| File | Contents |
| --- | --- |
| `data\seen.json` | `{ "<role id>": { firstSeen, title, company } }`. A role seen on an earlier day is "known"; the same company and a 90% title match under a new id is a repost |
| `data\state.json` | `{ lastRun, inboxLastRun (Sprint 6a), history: [{ date, <source>: emails, ... }] }` (last 14 runs; one count per source in `SOURCES`), for the look-back date and source health |
| `data\carryover.json` | Written by Claude each run: `[{ role, score, runDate, carries }]` for roles over the threshold that missed the cap |
| `data\metrics.csv` | `date,emails,roles_found,scored,relevant,shortlisted,rubric_version`, one line per scored run. `relevant` counts new roles at or over the threshold before the cap |
| `data\weekly\<year>-W<week>.md` | The weekly summary |
| `data\watchlist.json` | Sprint 6a (I1): written by part 2 each morning with `tools\replies.py watchlist`. `{ written, entries: [{ cardId, company, role, status (applied, conversation), domains, recruiters }] }`: the live applications whose replies tomorrow's mail read looks for. An entry with no domain matches a sender whose domain label is the company's name; part 2 lists such entries under Problems (`noDomain`, 0.13.0, I9) |
| `data\replies.csv` | Sprint 6a (I6): `date,found,read,moved,suggested,logged,unmatched,rejection,invitation,assessment,offer,request,follow-up,other`, one line per run with replies |
| `data\replies-grade.json` | Sprint 6a (I2): `npm run grade-replies` writes `{ date, model, right, of, confusions, passed, wrong }`. Until `passed` is true for the model in Settings, every move is a suggestion. The sheet the user marks is in the private store, `%LOCALAPPDATA%\JobScout\grading\replies.csv`, because it holds subjects |
| `data\keep.json` | Sprint 7 (H10): written by part 2 each morning with `tools\replies.py keep`. `{ written, roles: [card scoutIds], cards: [card ids] }` for every card Applied, In Conversation or Rejected. The mail read keeps these roles' adverts and specs, and replies matched to these cards, past 90 days; without the file it deletes nothing |
| `data\reader-model.json` | Sprint 7 (H8): the local model's digest as last seen, `{ <model>: { digest, since, previous, ollamaVersion } }` (the runtime version from 0.13.0, H19); a change gives a warning in `specs\summary.json` (which also carries `modelDigest`), and the reader's ledger entry carries `version: sha256:<12 characters>` |
| `data\eval\reader-<date>-<model>.json`, `reader-latest.json` | Sprint 7 (H8): `npm run eval:reader` results: right, of, rate, wrong (with reasons), digest, passed |
| `data\redteam\<date>\` | Sprint 7 (H9): `npm run redteam`'s scratch folders, `results.json` (each case, each check, its layer and result) and `cloud\<case>.json` for the cloud half. Safe to delete |
| `data\inbox\` | `.eml` files to read once: each is removed after a successful run reads it, and its copy kept in the private store (0.7.0, N21) |
| `data\ledger\<date>.json` | The audit trail (H7, 0.7.0): `{ date, entries }`, one entry per step of every run that day: `id` (`<date>.<agent>.<n>`), `agent` (scout, orchestrator, writer, reviewer, weekly), `kind` (code or ai), `where` (pc or cloud), `model`, `version` (the code's), `at`, `instructions` (file name to a 16-character SHA-256 of the file with line endings made \n), `settingsVersion`, `inputs`, `counts`. `scores.json`, `pack.json` and cards carry the `ledger` id of the step that wrote them; `status.json` carries the code's as `ledgerId` |
| `data\shared-emails\` | Emails you chose to show Claude with `npm run share-email` (delete after the fix) |
| `data\spike\` | The H13 spike's reports and the adverts it fetched (0.7.0; for the spike only) |
| `data\scout.log` | Output of the Windows task |

### Governance fields in a run (0.5.0)

- `status.json`: `untrustedLinesRemoved` (lines removed from alerts), `credentialSource` (`secure store`, `.env` or `none`).
- `run.md`: an **Untrusted text** section listing each removed line, the role it came from and why; a credential warning in Problems when the password is still in `.env`.
- A paused run writes no run folder at all.

## Packs (`Professional development\<Company> - <Role>\`)

| File | Contents |
| --- | --- |
| `job-spec.md` | The advert as read, with source, alert date, place, pay |
| `fit-and-gap-analysis.md` | Verdict, why it is worth it, fit by the advert's asks, gaps with honest adjacency, warning signs, decisions taken, prepared answers needed, items for the user's sign-off, positioning check |
| `<Name> - CV - <label>.docx/.pdf/.md` | The CV: generic master with Summary, three highlights and location changed |
| `<Name> - covering letter - <label>.docx/.pdf/.md` | The letter, one page |
| `form-answers.md` | Likely form questions and suggested answers, drafts marked |
| `baseline.json` | `{ "cv": [paragraphs], "letter": [paragraphs] }` as built, for `pack_diff.py` |
| `pack.json` | `{ id, company, role, score, built, folder, files[], checks, builtFrom }`, written last: a folder without it is unfinished. `builtFrom` (E16, required from 23 October 2026): `{ version: 1, built, settingsVersion, files: { cvBase, letterBase, careerNotes, highlights, formAnswers: { path (inside Professional development), kind (file or folder), hash } }, advert: { mustHaves, pay, place, closes, hash } }`; `advert` required from 24 October 2026 (E17) |

A rebuilt pack (E15) is a new folder, `<Company> - <Role> (rebuilt <date>)`, beside the old one.

## Board cards

Collection `applications` in the Application Pipeline artifact. The user's own cards use the first group only.

| Field | Meaning |
| --- | --- |
| `company`, `role`, `blurb`, `next`, `notes`, `link` | What the card shows; `link` is the advert |
| `status` | `draft`, `applied`, `conversation`, `rejected`, `archived` |
| `applied` | Date stamped when moved to Applied |
| `log` | `[{ at, text }]` history. From Sprint 6a the scout adds reply entries `{ at, by: "scout", replyId, type, emailDate, thread, move?: { from, to }, suggest?: { from, to }, text }`, and the user's choices add `{ by: "user" (older entries: the owner's name), undo | confirmed | dismissed: <replyId>, text }`; these cannot be removed on the board |
| `suggestions` | Sprint 6a (I4): `[{ replyId, type, from, to, emailDate, note }]`, moves the scout suggests; Confirm or Dismiss removes one |
| `updated` | Last change |
| `source` | `"scout"` on scout cards |
| `scoutId` | The role id; one card per role |
| `score`, `rubricVersion`, `runDate` | The score, the rubric that produced it, the run |
| `pack` | `Professional development\<folder>`; Open folder and Copy path are built from it |
| `site`, `alerted`, `posted`, `applicants` | Source, alert date, posting date and applicants when the advert shows them |
| `warnings` | Warning signs to check |
| `cvFormat` | `"two-page"` |
| `snoozeUntil` | Hidden until this date |
| `archivedReason`, `archivedAt` | Why and when the user passed; read by the weekly and monthly reviews |
| `staleness` | E16: `{ level (fresh, probably, stale), reasons[], checked }`, written by part 2 on Draft cards only |
| `rebuild` | E15: `{ requested, reason, by: "user" }`, written by the user's Rebuild pack; cleared by the run when it rebuilds, or by Cancel |
| `rebuilt` | E15: `{ folder, built, cause (request or advert), reason }`, a rebuilt pack waiting for the user's choice; cleared by Use the rebuilt pack (which sets `pack`) or Dismiss |

## The Inbox and Calendar collections (Sprint 6b, board v20)

Created by part 2 with `tools\replies.py docs` (create-only, checked by `validate.py docs`); changed only by the user on the board.

| Collection | Id | Fields |
| --- | --- | --- |
| `replies` | the reply's id | `replyId, cardId, company, role, domain, date, type, action (move, suggest, log, unmatched, unread), note, offer, seen, source, created`; the board adds `linkedBy` when the user links an unmatched reply |
| `todos` | the reply's id, or random for their own | `replyId, cardId, company, role, domain, ask, askBy, done, doneAt, source (scout or user), created` |
| `events` | the reply's id with `-c` (calendar file), `-1` to `-6` (proposed slots) or `-d` (deadline); random for their own | `replyId, cardId, company, role, domain, kind (confirmed, proposed, deadline), start (wall time or date), end, zone, zoneAssumed, title, asWritten, group, source, created`; the board adds `chosen` |

## The run log (`runs`, G11, board v23)

One document per morning run, id the run's date, written by part 2 last (`tools\runlog.py build`, checked by `validate.py runlog`); the board only reads it. Fields: `date, status (done, partial, failed, none), found, toScore, dropped, known, analysed, shortlisted, worthALook, packs, advertsRead, minutes, steps, localTokens {in, out}, cloudTokens {in, out}, cost, currency, perShortlisted (empty when nothing was shortlisted), estimated (the fields that are estimates), method, backfilled, ledger[]`. A morning with no run (G4) has `status: "none"` and nil counts. Counts, minutes and local tokens are exact; `cloudTokens`, `cost` and `perShortlisted` are estimates by method 1 (`runlog.py`, `METHOD`).

## Board settings (`settings/current`)

One document in the board's database, edited in the Settings dialog and read by the morning run.

| Field | Meaning (default) |
| --- | --- |
| `version`, `rubricVersion`, `updated`, `changes` | Raised on every save; `rubricVersion` rises when any scoring value changes; `changes` holds the last 20 saves as `{ at, text }` |
| `scoring.weights` | `scope` 20, `proof` 25, `ai` 10, `mustHaves` 15, `odds` 10, `engagement` 10, `company` 5, `pay` 5; must total 100 |
| `scoring.threshold`, `dailyCap`, `carryOverMax`, `readAdvertFrom` | 60, 5, 2, 45 |
| `scoring.seniorPmCap`, `seniorPmSoleOwnerCap` | 5, 10 (Scope points) |
| `filters.ukPermanentMin`, `ukPermanentTolerancePct`, `ukContractMinPerDay` | 110000, 10, 750 |
| `filters.secondMin`, `fractionalMin` | null (no floor) |
| `filters.hoursPerDay`, `eurToGbp`, `usdToGbp` | 8, 0.85, 0.75 |
| `warnings.staleAfterDays`, `applicantsWarnAt`, `recruiterWords`, `unnamedClient`, `nda` | 21, 200, and the word lists |
| `markets.*`, `level.*` | The place and level word lists from `constraints.json` |
| `sources.senders`, `firstRunLookbackDays` | The senders (six since 0.6.0, with Google's and Microsoft's), 7 |
| `targets.companies`, `extraPlaces`, `packBelowLine` | Google and Microsoft, 2, false (B13) |
| `reader.enabled`, `model`, `useForScoring`, `waitMinutes` | true, qwen2.5:14b, false (until a model passes the retest), 30 (H5) |
| `level.hardwareWords` | Hardware and semiconductor words, dropped in every market (B11) |
| `packs.letterMinWords`, `letterMaxWords`, `cvLocationUk`, `cvLocationSecond` | 350, 450, London, the second market's city |
| `packs.rebuildsPerRun`, `staleAfterDays` | 2 (E15), 7 (E16) |
| `costs.inputPerMillion`, `outputPerMillion`, `currency` | 5, 25, USD: the prices the run log's cost estimate uses (G11) |
| `control.paused` | false. When true the mail read, the morning run and the weekly run all stop before doing anything (Sprint 4, H4) |
| `control.advertsPerRun` | 20: the most adverts the morning run reads in full |

## The tracker (`_context\applications.md`)

The master record. The code reads every Markdown table row (`| Company | Role | Status | ... |`) to de-duplicate. Scout roles sit in the **Scouted** table until the user applies (row moves to the main table) or archives (status `Archived`); the morning run keeps those rows in step with the board.


## The evaluation set (`_context\job-scout\eval\`, H8, 0.12.0)

`label-sheet.csv` (id, run, title, company, location, score then, shortlisted then, applied, link, your label, reason), `inputs\<id>.json` (`{ id, run, role, advert (cleaned, or null), removed, scoredThen }`, frozen once written), `reader\expected.json` and `reader\adverts\` (the reader's set: per advert, `pay` or null, `refuse`, `closed`, and each requirement as words that must all appear in one of the model's requirements), `baseline.json`, `latest.json` and `reports\<date>.md`.

## The reviewer's files (H6, 0.9.0)

| File | Written by | What |
| --- | --- | --- |
| `claims.json` (pack folder) | Claude, part 2, from the reviewer's answer | `{ pack, reviewer (ledger id), round (1 or 2), claims: [{ where (summary, highlight-1 to 3, letter), sentence, verdict (supported, compressed, unsupported, hedged, no-claim), source: { file, quote } or null, reason }], ats: [{ term, status (covered or gap), line, note }] }`. Checked by `validate.py claims`, which confirms each quote is in the vault file it names. Listed in `pack.json` |
| `reviewFlags` (board card) | Claude, part 2 | The number of lines the reviewer left unsupported after one revision: "N to sign off" on the card |
| `_context\job-scout\REVIEW.md` | The user's vault | The reviewer's procedure |
| `_context\job-scout\review-evals\` | The user's vault | The reviewer's hand-check cases (they hold their letter text, so never in the repository); scored with `tools\review_eval.py` |
