# Job Scout: building an application pack

How an agent turns a shortlisted role into a pack the user can review and send. Runs after [SCOUT.md](SCOUT.md) has written `scores.json`. **The user reviews every pack before anything is sent; nothing here applies, submits or contacts anyone.**

## The folder

One folder per role (in the demo: `data/demo/<date>/packs/<Company> - <Role>/`). Write the files in this order; **`pack.json` is written last**, and a folder without it is an unfinished pack.

| File | What |
| --- | --- |
| `job-spec.md` | The advert as read, with source, date, place, pay and applicants: adverts are taken down |
| `fit-and-gap-analysis.md` | A one-line verdict; why it is worth it; where the fit is strong, by the advert's own asks; the gaps with the honest adjacency; "For your sign-off"; reviewer suggestions; the ATS table |
| CV and letter | `.docx`, `.pdf` and `.md`, built by `tools/build_pack.py` |
| `form-answers.md` | The likely form questions, answered from the approved answers; anything not approved under "Check before using". Always the approved AI-use answer, word for word |
| `ats.json`, `claims.json` | The ATS match and the reviewer's judgement |
| `pack.json` | `{ "id", "company", "role", "score", "built", "files", "checks", "ledger" }` |

## The CV

Built from a copy of the candidate's base CV. **Change only three things:** the Summary (tailored, about the same length), the **three** Selected Highlights (ordered for this reader, no company twice, worded from the experience section), and the place on the contact line. Experience, titles, dates and employers never change.

## The letter

One page, within the settings' word range (350 to 450 by default). Open on the advert's own language and the candidate's least common relevant story; one paragraph per strong match; name the real gap plainly with the adjacency; close with place and availability. British spelling, short sentences, no em dashes.

## Build and verify

0. **Record the step:** `python3 tools/ledger.py add <date>.json --agent writer --model <model id> --where cloud --instructions PACK.md --settings settings.json --input orchestrator=<its id> --count packs=<n>`.
1. **Write a spec** and run `python3 tools/build_pack.py spec.json`. The spec names the candidate, their contact line and page two's first entry (`name`, `contact`, `pageTwoStartsWith`; there are no defaults), the base documents, the Summary, highlights and letter, and `letterWords` from the settings. It fails if the CV is not exactly two pages, page two does not start with the named entry, the letter runs over a page or outside the word range, or a barred phrase or em dash appears.
2. **Fix and rebuild** until it passes. If only the word count fails, revise once and rebuild with `"letterRevised": true`; a count still out of range then goes to "For your sign-off".
3. **The AI-use answer:** `python3 tools/validate.py disclosure form-answers.md --bank <the approved answers>`. Record `"disclosure": "pass"` in `pack.json`.
4. **ATS match:** `python3 tools/ats_match.py <spec or job-spec.md> <CV.md> <letter.md> --bank <term bank> --out ats.json --md ats.md`. The judgement of the missing terms is the reviewer's.
5. **Record what it was built from:** `python3 tools/staleness.py record --root <the folder the sources sit in> --cv <CV base> --letter <letter base> --notes <career notes folder> --highlights <highlight bank> --answers <form-answer bank> --spec <the advert as read> --settings-version <n> --into pack.json`, with every path relative to that root, so the PC can compare them each morning. When the advert was read in the cloud, not by the PC, write its facts (requirements as written, pay, place, closing date) to a small JSON and make the spec with `python3 tools/staleness.py facts advert-facts.json > spec.json`.
6. **Review** (below), then check `pack.json` with `python3 tools/validate.py pack pack.json` and write it last. From 0.15.0 it refuses a new pack without `builtFrom`.

## Review

A second agent that did not write the pack checks it before `pack.json`. It reads only; you write.

1. **Prepare:** `python3 tools/validate.py sentences <CV.md> --letter <letter.md> > sentences.json` (it refuses a CV whose Summary or highlights it cannot find) and `python3 tools/validate.py hashes <pack folder> <CV.md> <letter.md> > before.json` (the CV and letter named relative to the pack folder). Copy into a folder of its own only: `sentences.json`, the CV and letter `.md`, `ats.json`, `form-answers.md`, the approved AI-use answer, [REVIEW.md](REVIEW.md), the positioning rules, and the candidate's career notes. Not the advert, your notes or the fit-and-gap.
2. **Call the reviewer** as a read-only sub-agent, with that folder, the pack's name, its ledger id (`ledger.py add ... --agent reviewer`) and `"round": 1`.
3. **Check its answer:** `python3 tools/validate.py claims claims.json --cv <CV.md> --letter <letter.md> --ats ats.json --vault <its folder> --before before.json --pack <pack folder>`. It confirms every quote is really in the record, every sentence was judged once, and the pack did not change during review. On a failure, call it once more; a second failure goes in Problems.
4. **One revision:** revise only the `unsupported` lines, rebuild, and review again with `"round": 2`. Never a third round.
5. **Then** list every line still `unsupported` at the top of "For your sign-off", every `hedged` line under "Suggestions" (never applied by you), and the reviewer's ATS judgement beside the table. The card's `reviewFlags` is the number of unsupported lines left.

## Rebuilding a pack

When SCOUT.md step 8a asks for one (the user pressed **Rebuild pack** on a Draft card, or the advert changed): only for a Draft card with no applied date; from today's advert, bases, notes, banks and settings, not from the old pack; into a **new** folder, `<Company> - <Role> (rebuilt <date>)`, never over the old one; with the same build, checks, review and `builtFrom`. The card gets `rebuilt: { folder, built, cause, reason }` and `rebuild: null`; the user chooses on the card, **Use the rebuilt pack** or **Dismiss**.

## The board card

After the pack, one Draft card per shortlisted role, written as `{ "id": "scout-<company>-<role>", "data": { ... } }` (lower case, hyphens) and checked with `python3 tools/validate.py card card.json --existing board.json` (`--demo` for the demo).

- **Required:** `company`, `role`, `status` (`"draft"`), `source` (`"scout"`), `scoutId` (the role's id from `candidates.json`), `score`, `rubricVersion`, `runDate`, `site` (linkedin, hackajob, google, microsoft or request).
- **Usual:** `link` (the advert), `blurb` (a paragraph on the company and the role), `next` ("Review the pack and apply, or archive"), `notes` (the lead story and anything to check), `pack` (the pack folder), `alerted`, `posted` and `applicants` (null when unknown), `warnings` (a list), `target`, `cvFormat` ("two-page"), `ledger`, `atsMatch`, `reviewFlags`, and a first `log` entry recording the score and lead story.
- **Never:** a contact's name, email address or phone number, in any field. The checker refuses addresses and numbers; leave names out yourself.
- Skip a role whose `scoutId` is already on the board.
