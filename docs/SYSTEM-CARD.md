# Job Scout: system card

_Version 0.14 · 21 October 2026 · owner: the repository's owner ·  reviewed at every sprint close · built with Claude_

A system card describes an AI system in one place: what it is for, what it is not for, which AI models it uses, how well they perform, where they fail and who is responsible. Words in _italics_ are explained in the [glossary](GLOSSARY.md).

## 1. Summary

Job Scout is an automated job search for one person. Every morning it reads job alerts and replies to applications, reads the full adverts, scores each role, drafts a CV and covering letter for the best few, checks every claim in the drafts, and shows the results on a private board. A person makes every decision that matters. The system never applies, replies or contacts anyone.

## 2. Intended use

| | |
| --- | --- |
| **Purpose** | Save time in a senior job search: find suitable roles, explain why they fit, and prepare first drafts of applications. |
| **User** | A single user, who is also the owner and operator. |
| **Decisions it supports** | Which roles to look at, which to apply for, and what to write. The user makes each of these decisions. |
| **Setting** | A local Windows PC, their Proton mailbox, their Claude account and a private board in that account. |

## 3. Not intended for

- **Acting for the user.** It does not apply, reply, accept, book or contact anyone, and it does not edit LinkedIn or any document already sent. These limits are in every instruction and checked by code.
- **Other people's job searches.** The rules, scoring criteria and career record are the user's. A demo mode with a fictional candidate runs on made-up data only (`npm run demo`, a separate demo board); real use by anyone else would need its own review.
- **Judging people.** It scores job adverts against one person's preferences. It does not assess candidates, employers or recruiters as people.
- **Making claims without evidence.** The drafts may only state what the user's career record supports. Some claims are barred completely.

## 4. AI components

| Component | Model | Where it runs | What it sees | What it can do |
| --- | --- | --- | --- | --- |
| **Advert and reply reader** | qwen2.5:14b, run with Ollama | Local PC, on the graphics card | One advert or one reply at a time, after code has removed hidden instructions | Nothing except return a fixed answer format. No tools, no internet. Code keeps only the facts found in the original text. |
| **Finder** (part 1) | Claude | Anthropic's cloud, as a scheduled task | Role records from alerts (title, company, place, pay, link) | Search the web for where each advert is published. Its list of links is checked by code. |
| **Scorer and writer** (part 2) | Claude | Anthropic's cloud | Job facts from the reader, the scoring criteria, the user's career record and their previous CV and letter | Score roles on eight criteria and draft a CV and letter. Every output is checked by code before it is saved. |
| **Reviewer** | Claude, as a separate agent | Anthropic's cloud | Only the finished drafts, the keyword report and the career record. Not the writer's reasoning. | Read only. It must quote the career record for every claim it accepts, and code confirms each quote exists. |
| **Weekly summary** | Claude | Anthropic's cloud, on Mondays | The week's results, the user's edits and their reasons for declining roles | Propose at most three changes a month. Nothing changes without the user's approval. |

Everything else is normal code, not AI: reading mail, filtering, removing duplicates, counting keywords, matching replies to applications, and all checks. A log records every step, with the model, the version of its instructions and its inputs.

## 5. Human oversight

- The user reviews every draft and makes every decision to apply. About 30 minutes each morning.
- Anything the reviewer cannot confirm goes to the user's sign-off list.
- The system may move a card on the board by itself only after the user has tested the reply reader on their own replies (not done yet). Until then, every move is a suggestion. Every move is logged and can be undone.
- A pause switch on the board stops every part of the system.
- Only the user can change the rules. The settings page is checked on entry, every change is logged, and no AI can write to it.

## 6. Data and privacy

| Data | Who can see it | Kept for |
| --- | --- | --- |
| Mailbox | Only code on the PC, read-only | Not copied, except as below |
| Copies of emails | Code on the PC, in a private folder | 30 days |
| Adverts, job facts, reply summaries | The local reader; cleaned versions go to the cloud | 90 days, unless the user applied |
| Career record and previous documents | The cloud writer and reviewer | The user's own files |
| Mail password | Nothing. Encrypted for the local Windows account. | Until changed |

Board cards never hold a contact's email address or phone number. The emails of strangers are never sent to the cloud, only a short, checked summary.

## 7. Evaluation results

| What is tested | Bar | Latest result | Date |
| --- | --- | --- | --- |
| Reader: requirements and pay copied correctly | 9 in 10 | 21 of 22, the same in three runs (H19) | 21 Oct 2026 |
| Reviewer: planted problems found | All | 8 of 8 | 17 Oct 2026 |
| _Red team_: hostile inputs stopped | All | 10 of 10 | 17 Oct 2026 |
| Scoring agrees with the user's own decisions | Not set yet | No baseline yet (see 8) | 17 Oct 2026 |
| Reply reader agrees with the user's grading | 9 in 10, no rejection read as an invitation | Not graded yet | |
| Automated tests | All pass | <!-- fact:code-tests -->151<!-- /fact --> code tests, <!-- fact:tool-tests -->164<!-- /fact --> tool tests | 19 Oct 2026 |

The tests use made-up emails and adverts, several of them hostile. The red team is run each quarter; the first run was on 17 October 2026.

## 8. Known limitations

- **Scoring is not yet measured properly.** The first scoring test re-scored most roles from the short alert only, because their adverts had not been saved. The set is being rebuilt before a _baseline_ is set. Until then, the scoring may miss good roles: the user would apply for seven roles that scored below the line. To reduce this, roles scoring from 55 to just under the line are listed as "worth a look" in the digest.
- **Some adverts cannot be read.** LinkedIn pages are never fetched, and some careers pages block automated reading. These roles are scored from the alert alone and marked as such.
- **The cloud model can change.** The local model's version is checked every day. The Claude model is updated by Anthropic and is not pinned. A change is visible in the log, and the evaluation is re-run before any change to the rules or instructions.
- **Read-only enforcement for the reviewer depends on setup.** When the scheduled task cannot load the reviewer's agent definition, the reviewer runs on its instructions alone. The code checks still apply in both cases.
- **It depends on the local PC.** The PC must be awake, on mains power, with the graphics card in use. Two incidents in the first week (sleep mode, graphics mode) made runs late or slow. Both are fixed and documented.
- **It reflects one person's preferences.** The scoring criteria are the user's. They are not a general measure of a good job.

## 9. Main risks and controls

| Risk | Main controls |
| --- | --- |
| Hidden instructions in an advert or email steer the AI (_prompt injection_) | Code removes them first; the reader has no tools; outputs checked by code; red team |
| A draft claims more than the user's record supports | Barred claims fail the build; independent reviewer with checked quotes; the user signs off |
| The system acts without permission | No tool can send or apply; draft-only cards; moves are suggestions until earned |
| Personal data leaks to the cloud | Privacy tiers; only checked summaries leave the PC; retention limits |
| Quality drifts after a change | Evaluation before every change; model version checked daily |

The full list, with owners and check dates, is in the [risk register](RISK-REGISTER.md). It follows the NIST AI Risk Management Framework.

## 10. Changes and review

This card is updated at every sprint close, and whenever a model, the scoring criteria or an agent's instructions change. Before any such change, the evaluations in section 7 are run again. Version history is in the changelog.
