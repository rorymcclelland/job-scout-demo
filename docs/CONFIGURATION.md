# Job Scout: configuration reference

_Version 0.16 · 23 October 2026 · what can be changed, where, and when it takes effect_

Every value that steers Job Scout lives in one of five places. This page says which, who reads it and when a change takes effect. Field-by-field formats and defaults are in [DATA](DATA.md#configuration). Terms are explained in the [glossary](GLOSSARY.md).

## Where settings live

| Place | Holds | Changed by | Read by | Takes effect |
| --- | --- | --- | --- | --- |
| **Board Settings** (`settings/current` in the board's database) | Scoring weights, threshold, the worth-a-look band (`scoring.lookBand`, default 55, below the threshold), caps; pay floors; places; level and warning words; senders; target employers; reader model; letter length; CV location line; pause switch; adverts per run; rebuilt packs a run and when a pack is probably stale (`packs.rebuildsPerRun`, `packs.staleAfterDays`); the prices for the run log's cost estimate (`costs.*`) | The user, in the Settings dialog. Checked on entry, versioned, logged. No AI can write it | Parts 1 and 2 (at once); the PC code through `config\settings.json` | Scoring: the next morning run. Filters and senders: the mail read after that (one day later) |
| **`config\settings.json`** | A copy of the board's settings, without the change log | Part 1 or 2 only, when the board's version changes. Never edit by hand | The 06:30 mail read, laid over the two files below | The next mail read |
| **`config\constraints.json`, `config\sources.json`** | The defaults the code falls back on when a setting is missing or invalid | The user or Claude, in a sprint, with tests | The mail read | The next mail read |
| **The vault** (`_context\job-scout\`) | How each criterion is scored (`rubric.md`); what the scout knows about the user (`candidate-profile.md`); approved form answers; the agents' instructions | The user, or Claude with their approval | The cloud agents | The next run. Run the evaluations first (OPERATIONS) |
| **`config\boards.json`** | The real and demo boards' artifact ids, so the demo can never write to the real board (`validate.py demoboard`) | The user | Claude's demo half; the export's scan | At once |
| **The second market** (`locations.second`, `secondName`, `pay.secondMin`, `level.secondNotProduct` in `config\constraints.json`; board fields `markets.second`, `filters.secondMin`, `packs.cvLocationSecond`) | An optional second country where roles pass with its own places, pay floor and level words. Unset, there is none | The user, on the board or in a sprint | The mail read; part 2 for the CV location line | The next mail read |
| **Private export files** (`config\private-names.txt`, `public-allowlist.txt`, `public-replace.txt`, `own-domains.txt`) | What the public copy may hold, and the names, bylines and domains it must not (H22). Never exported | The user, or Claude in a sprint | `npm run export`; `own-domains.txt` also by `tools\replies.py` | The next export |
| **Private store** (`%LOCALAPPDATA%\JobScout`) | Bridge user name and encrypted password; Bridge host, port and folder | The user only, with `scripts\set-bridge-password.ps1` | The mail read | The next mail read |

## Schedules

Shown in Settings but not set there.

| Schedule | Default | To change |
| --- | --- | --- |
| Wake, mail read, reader (Windows tasks) | 06:25, 06:30, 07:45 | Edit and re-run `scripts\install-schedule.ps1` |
| Part 1, part 2, weekly summary (Claude scheduled tasks) | 07:23, 08:10 daily; 08:50 Mondays (Europe/London) | Ask Claude to change the scheduled task |
| Red-team reminder | 08:47 on 2 January, April, July and October | Ask Claude to change the scheduled task |

## Changes that need extra care

| Change | Before | After |
| --- | --- | --- |
| Reader model (`reader.model`) | `npm run eval:reader` with the new model | Grade the reply reader again; update the [agent catalogue](AGENTS.md) and [system card](SYSTEM-CARD.md) |
| Scoring weights, threshold or the rubric's anchors | Run `EVAL.md` | Record the result; the rubric version rises by itself |
| An agent's instructions (`SCOUT.md`, `PACK.md`, `REVIEW.md`) | Run the relevant evaluation | Check the ledger shows the new instructions hash |
| Demo settings (`demo\settings.json`) | Nothing: used only by `npm run demo` and `demo\DEMO.md` | Never copied to the real board or `config\` |
| Pause | Nothing | Every part stops before doing anything; untick to resume. Nothing is lost |
