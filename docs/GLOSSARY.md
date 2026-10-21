# Job Scout: glossary

_Version 0.14 · 21 October 2026 · shared by every document in this set_

| Term | Meaning |
| --- | --- |
| Advert reader | The local model step that copies the facts from a job advert. See [AGENTS](AGENTS.md). |
| AI agent | An AI model with a task, instructions and a limited set of tools, which works on the task by itself. |
| Alert | An email from a job site listing new roles that match a saved search. |
| ATS | Applicant tracking system: the software employers use to receive and filter applications, often by keywords. |
| Backlog | The ranked list of planned work, with codes such as H5 or BUG-3. See BACKLOG. |
| Baseline | A reference result. Later results are compared with it to see if quality has changed. |
| Board | The Application Pipeline: a private web page in the user's Claude account with its own database. It holds application cards, replies, to-dos, a calendar and the settings. |
| Bridge | Proton Mail Bridge: Proton's app that decrypts mail on the PC and offers it to local programs through IMAP. |
| Card | One application on the board. The system adds Draft cards only. |
| Digest | The morning summary of a run: problems, shortlist, replies. `data\runs\<date>\digest.md`. |
| Digest (model) | A version fingerprint of the local model. Recorded daily so a silent update is noticed. |
| Demo | `npm run demo`: the whole system on made-up data, with a fictional candidate and a separate demo board. Never touches real mail, files or the real board. See `demo\README.md`. |
| DKIM | A digital signature on an email that proves which domain sent it. Used to judge a sender by more than its display name. |
| Draft card | A card the system created. The user moves it on when they decide. |
| Evaluation | A repeatable test that compares the AI's answers with answers a person has checked. See `EVAL.md`. |
| Grounding | A code check that keeps only the facts that appear in the original text, so the model cannot add any. |
| IMAP | The standard way for a program to read a mailbox. Job Scout uses its read-only commands. |
| Ledger | The log of every step of every run: agent, model, instructions hash, inputs and counts. `data\ledger\`. |
| Local model | An AI model that runs on the local PC, not on the internet. Here, qwen2.5:14b in Ollama. |
| Ollama | Free software that runs open AI models on a local computer. |
| Pack | The folder of drafts for one role: CV, letter, fit-and-gap note, form answers, keyword report. |
| Part 1, part 2 | The two morning Claude scheduled tasks: part 1 finds adverts (07:23), part 2 scores and drafts (08:10). |
| Private store | `%LOCALAPPDATA%\JobScout` on the PC: the mail password and copies of emails. No AI can reach it. |
| Prompt injection | Hidden instructions placed in text, for example in a job advert, to make an AI do something its owner did not intend. |
| Red teaming | Testing a system by playing the attacker, to find weaknesses before a real attacker does. A practice from security testing. |
| Retention | How long data is kept before it is deleted. |
| Reviewer | The separate AI agent that checks every claim in a pack against the user's career record. |
| Rubric | The eight weighted criteria a role is scored on, with descriptions of what earns the points. `rubric.md`. |
| Request (score or pack on request) | A single role the user found themselves, scored or packed in a chat exactly like a morning role. Its folder is `data\runs\<date>-req-<n>\`. |
| Run folder | `data\runs\<date>\`: everything one morning produced. |
| Scheduled task | A Claude task that runs at a set time without anyone starting it. |
| Sprint | A short, planned block of work with agreed test cases. Specifications are in `docs\refinement\`. |
| System card | A one-document description of an AI system: use, limits, models, results and risks. See [SYSTEM-CARD](SYSTEM-CARD.md). |
| Threat model | A description of what needs protecting, who might cause harm, where they can get in and what stops them. See [THREAT-MODEL](THREAT-MODEL.md). |
| Tokens a second | How fast the local model writes its answer. Below 15, it is running on the main processor, not the graphics card, and the reader stops after one advert. |
| Untrusted text | Text written by strangers: alerts, adverts, replies, web pages. Always treated as data, never as instructions. |
| Worth a look | Roles that score just under the shortlist line (from 55 by default). Listed in their own digest section, so a near miss is not lost. |
| Vault | The user's career record and Job Scout's instructions, in `Professional development\_context\`. |
