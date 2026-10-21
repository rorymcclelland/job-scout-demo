# Job Scout: documentation

_Version 0.14 · demo copy_

Job Scout is an automated job search, designed and directed by its owner and built with Claude. This public copy holds the documents written for readers; the operating and delivery records stay in the private copy. Terms are explained in the [glossary](GLOSSARY.md).

## What it is and whether it is safe

1. [How it is built](HOW-IT-IS-BUILT.md): the story in two pages, with measured results.
2. [System card](SYSTEM-CARD.md): intended use, limits, models, results and risks on one page.
3. [How it works](ARCHITECTURE-OVERVIEW.pdf): the plain-English diagram.
4. [Five-minute demo script](DEMO-SCRIPT.md): a walkthrough on made-up data and a separate demo board.

## How it is put together

1. [Architecture](ARCHITECTURE.md) and the [technical diagram](ARCHITECTURE-TECHNICAL.pdf): modules, run sequence, scheduling, data flows.
2. [Agent catalogue](AGENTS.md): every AI component, its inputs, permissions, checks and evaluation.
3. [Data](DATA.md): every file, field and setting, and how long each is kept.
4. [Configuration](CONFIGURATION.md): what can be changed, where, and when it takes effect.
5. [Decisions](DECISIONS.md): why it is built this way.
6. [Testing](TESTING.md): automated tests, built-in checks and manual checks.

## Assurance

1. [Threat model](THREAT-MODEL.md): assets, attackers, entry points, threats and controls.
2. [Risk register](RISK-REGISTER.md): each risk, control, owner and last check (NIST AI RMF).

## The procedures the AI follows

The instructions Claude follows are in [procedures/](../procedures/README.md): scoring a run, building a pack, the reviewer and the rubric.

## Screenshots

The demo board, on made-up data: [the board](screenshots/demo-board.png), [the columns](screenshots/demo-columns.png), [a scouted card](screenshots/demo-card.png) and [the inbox](screenshots/demo-inbox.png).
