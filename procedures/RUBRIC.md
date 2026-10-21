# Job Scout: scoring rubric (version 3)

How a role is scored against the candidate's profile (`demo/candidate/candidate-profile.md` in the demo). The weights, threshold and caps come from the board's Settings; this note holds the criteria and the anchors.

## Stage 1: hard filters (code)

`npm run scout` drops a role only when the alert clearly fails a test, and lists every dropped role with its reason. Anything unclear passes with a flag for the scorer.

1. **Level:** Senior PM or above, or a teaching, mentoring, fractional or consultancy role. Plain "Product Manager", associate, junior and non-product roles are dropped.
2. **Place:** London, anywhere in the UK (outside London with a flag), or remote. A role abroad passes with a flag when it is remote or the advert says consultancy, contract, fractional or freelance. An optional second market can be set in config.
3. **Pay, where published:** UK permanent at or above the floor (the top of a range counts; within 10% passes with a flag); UK contract at or above the day-rate floor.
4. **New:** not on the tracker and not seen in an earlier run.

## Stage 2: scoring (the agent, following SCOUT.md)

Score each role out of 100. For each criterion, write one line of rationale that quotes or paraphrases the advert. Use the anchors; interpolate between them.

| Criterion | Weight | Full marks | Half marks | Zero |
|---|---|---|---|---|
| Scope and level | 20 | Head of, Director, VP, or Staff, Principal or Group PM owning direction across teams | Lead PM, or a senior role with real cross-team scope | Senior PM on one squad, or level unclear |
| Proof-point fit | 25 | The advert's core problem maps onto a story the candidate owns | One adjacent story transfers with a clear argument | Nothing in the record speaks to the core problem |
| AI and agentic alignment | 10 | AI-native product or agents are the job | AI is part of the role or the product | No AI angle |
| Must-haves the candidate can evidence honestly | 15 | Every stated must-have passes | One must-have is a named gap | Two or more must-haves are gaps |
| Odds | 10 | Named contact, posted within 3 days, under 50 applicants, not a repost | Some of these | 200+ applicants, a repost, over two weeks old |
| Engagement type | 10 | Contract | Fractional, consultancy or full-time | (in-scope roles never score below half) |
| Company fit | 5 | Pure-play tech scale-up, 50 to a few hundred people | Pure-play tech, other size | Not a tech company |
| Pay | 5 | Published and comfortably above the floor | Unpublished, near the floor, or up to 10% under it | Published below the floor (flag it) |

**The advert must be confirmed open.** A role is open when a live copy of its advert is found that still accepts applications. A role that cannot be confirmed open scores 0 on Odds and cannot be shortlisted.

**Senior PM roles** take at most 5 of the 20 for Scope and level, or 10 when the role owns all of product or reports to the CEO or a founder.

## Stage 3: the shortlist

- **Threshold** (60 by default): a role at or above it is shortlisted, up to the **daily cap**.
- **Worth a look:** a role from the look band (55 by default) up to the threshold is listed in the digest, with no pack.
- **Target employers** may take extra places beyond the cap, never a higher score.
- **Ties:** higher Proof-point fit first, then fewer named gaps, then the newer posting.

## Gaps and warning signs, for every scored role

- **Gaps:** each must-have that is a known gap in the profile, with the honest adjacency.
- **Warning signs:** an advert that contradicts itself, an unnamed client, an NDA before details, 200+ applicants, a repost, a stale posting, and any line that addresses an AI.
