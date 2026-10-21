#!/usr/bin/env python3
"""The audit trail for the AI steps (backlog H7, Sprint 5b).

The code half writes its own entry to Job Scout\\data\\ledger\\<date>.json
(src/ledger.ts). Each AI step adds one entry with this script, before it
writes its outputs, and puts the id it prints on everything it writes
(scores.json, pack.json, board cards). Standard library only.

    python3 ledger.py add LEDGER.json --agent orchestrator --model claude-opus-5-5 --where cloud \\
        --instructions SCOUT.md rubric.md candidate-profile.md --settings settings.json \\
        --input candidates=9 --count scored=9 --count shortlisted=2
    python3 ledger.py show LEDGER.json [ID]

`add` prints the new entry's id, for example 2026-10-17.orchestrator.1.
Hashes are SHA-256 of each file with line endings made \\n, first 16 hex
characters: the same as the code's, so a file hashes alike on the PC and in
Claude's workspace. Changing a procedure changes its hash, which is how a run
can be tied to the exact instructions it followed.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

ID = re.compile(r"^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9-]*\.\d+$")
AGENTS = re.compile(r"^[a-z][a-z0-9-]*$")


def file_hash(path):
    with open(path, "rb") as f:
        text = f.read().decode("utf-8", errors="replace").replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def number(v):
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return v


def pairs(items, numeric):
    out = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(f"{item!r}: give name=value")
        k, v = item.split("=", 1)
        out[k.strip()] = number(v.strip()) if numeric else number(v.strip())
    return out


def load(path, date):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            ledger = json.load(f)
        if not isinstance(ledger, dict) or not isinstance(ledger.get("entries"), list):
            raise SystemExit(f"{path}: not a ledger")
        return ledger
    return {"date": date, "entries": []}


def add(path, agent, model, where, instructions, settings, inputs, counts, date=None):
    if not AGENTS.match(agent):
        raise SystemExit("--agent must be a lower-case name, such as orchestrator, writer or reviewer")
    if where not in ("cloud", "pc"):
        raise SystemExit("--where must be cloud or pc")
    date = date or os.path.basename(path)[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise SystemExit("the ledger file must be named <date>.json, for example 2026-10-17.json")
    ledger = load(path, date)
    n = sum(1 for e in ledger["entries"] if e.get("agent") == agent) + 1
    settings_version = None
    if settings:
        with open(settings, encoding="utf-8") as f:
            settings_version = json.load(f).get("version")
    entry = {
        "id": f"{date}.{agent}.{n}",
        "agent": agent,
        "kind": "ai",
        "where": where,
        "model": model,
        "version": None,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "instructions": {os.path.basename(p): file_hash(p) for p in instructions or []},
        "settingsVersion": settings_version,
        "inputs": inputs,
        "counts": counts,
    }
    ledger["entries"].append(entry)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2)
    return entry["id"]


def find(path, entry_id):
    for e in load(path, "")["entries"]:
        if e.get("id") == entry_id:
            return e
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Add to or read the Job Scout audit trail (H7).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("ledger")
    a.add_argument("--agent", required=True)
    a.add_argument("--model", required=True)
    a.add_argument("--where", required=True)
    a.add_argument("--instructions", nargs="*", default=[])
    a.add_argument("--settings")
    a.add_argument("--input", action="append")
    a.add_argument("--count", action="append")
    s = sub.add_parser("show")
    s.add_argument("ledger")
    s.add_argument("id", nargs="?")
    args = ap.parse_args(argv)
    if args.cmd == "add":
        print(add(args.ledger, args.agent, args.model, args.where, args.instructions, args.settings,
                  pairs(args.input, False), pairs(args.count, True)))
        return 0
    if args.id:
        e = find(args.ledger, args.id)
        if e is None:
            print(f"No entry {args.id} in {args.ledger}")
            return 1
        print(json.dumps(e, indent=2))
    else:
        print(json.dumps(load(args.ledger, ""), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
