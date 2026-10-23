#!/usr/bin/env python3
"""The run log: one document per morning run, for the board's Runs tab (backlog G11, Sprint 10).

    python3 runlog.py build RUN_FOLDER LEDGER.json [--settings settings.json] [--backfilled] > run.json
    python3 runlog.py backfill DATA_FOLDER [--settings settings.json] [--from 2026-10-17] > runs.json
    python3 runlog.py gaps RUN_FOLDER [--settings settings.json] > gaps.json

`gaps` (G4, Sprint 11): a "none" document for each morning the mail read reports as missed
(`missed` in status.json), so the Runs tab shows the gap rather than skipping it.

What a run did (roles found, analysed, shortlisted, packs, minutes) is exact: it comes from the
run folder and the ledger. The local model's tokens are exact too, as Ollama reports them (from
0.15.0; earlier runs have none). Claude's tokens are an ESTIMATE: scheduled tasks report no usage,
so they are worked out from the size of what each cloud step reads and writes (METHOD below), and
the cost from the prices in Settings. The estimate is indicative; what matters is the change from
run to run (the user, 22 Oct 2026). Changing METHOD raises its version, so the board can mark the
break in the trend. Standard library only.
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

# Method 1 (22 Oct 2026). Characters per token, and for each cloud step: the instructions and
# record it reads every time (characters), what it writes (characters), and how many times its
# context is sent in a working session (an agent re-reads its context on every turn).
METHOD = {
    "version": 1,
    "charsPerToken": 4,
    "turns": 4,
    "steps": {
        "finder": {"reads": 46000, "writes": 4000, "data": ["candidates.json"]},
        "orchestrator": {"reads": 46000, "writes": 0, "data": ["candidates.json", "specs/*.json", "adverts/*.md"],
                         "out": ["scores.json", "digest.md", "carryover.json"]},
        "writer": {"reads": 100000, "writes": 30000, "data": []},
        "reviewer": {"reads": 100000, "writes": 15000, "data": []},
        "replies": {"reads": 32000, "writes": 0, "data": ["replies/summary.json"], "out": ["replies/matched.json"]},
    },
    "otherStep": {"reads": 30000, "writes": 5000},
}
DEFAULT_PRICES = {"inputPerMillion": 5.0, "outputPerMillion": 25.0, "currency": "USD"}
MORNING_GAP_MINUTES = 60
# Checks of Job Scout itself (red-team runs, grading) are not part of a morning run.
NOT_RUN_WORK = {"redteam", "evaluator"}


def _json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _size(run, patterns):
    total = 0
    for pat in patterns or []:
        for p in glob.glob(os.path.join(run, pat)):
            if os.path.isfile(p):
                total += os.path.getsize(p)
    return total


def _when(s):
    """A time stamp, always with a zone (one written without is taken as UTC)."""
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _int(v):
    """A count as written by a step; anything that is not a whole number counts as 0."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return max(v, 0)
    if isinstance(v, float) and v == v and v not in (float("inf"), float("-inf")):
        return max(int(v), 0)
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    return 0


def _obj(v):
    return v if isinstance(v, dict) else {}


def prices(settings):
    c = (settings or {}).get("costs") or {}
    out = dict(DEFAULT_PRICES)
    for k in ("inputPerMillion", "outputPerMillion"):
        if isinstance(c.get(k), (int, float)) and not isinstance(c.get(k), bool) and c[k] >= 0:
            out[k] = float(c[k])
    if isinstance(c.get("currency"), str) and 0 < len(c["currency"]) <= 4:
        out["currency"] = c["currency"]
    return out


def cloud_tokens(run, entries):
    """Method 1: the estimate of Claude's tokens for the day's cloud steps."""
    cpt, turns = METHOD["charsPerToken"], METHOD["turns"]
    tin = tout = 0
    for e in entries:
        if e.get("where") != "cloud":
            continue
        agent = e.get("agent", "")
        m = METHOD["steps"].get(agent, METHOD["otherStep"])
        data = _size(run, m.get("data"))
        written = _size(run, m.get("out")) + m.get("writes", 0)
        tin += (m["reads"] + data) * turns / cpt
        tout += written / cpt
    return {"in": int(round(tin)), "out": int(round(tout))}


def build(run, ledger, settings=None, backfilled=False):
    """The run document for one run folder and its day's ledger."""
    date = os.path.basename(os.path.normpath(run))
    status = _obj(_json(os.path.join(run, "status.json"), {}))
    scores = _json(os.path.join(run, "scores.json"), []) or []
    if isinstance(scores, dict):
        scores = scores.get("scores") or scores.get("roles") or []
    specs = _obj(_json(os.path.join(run, "specs", "summary.json"), {}))
    replies = _obj(_json(os.path.join(run, "replies", "summary.json"), {}))
    entries = [e for e in (_obj(ledger).get("entries") or []) if isinstance(e, dict) and e.get("agent") not in NOT_RUN_WORK]
    counts = _obj(status.get("counts"))

    by_agent = {}
    for e in entries:
        by_agent.setdefault(e.get("agent"), []).append(e)
    total = lambda agent, key: sum(_int(_obj(e.get("counts")).get(key)) for e in by_agent.get(agent, []))

    # Minutes: the morning, from the first ledger entry until a gap of more than an hour (later
    # steps, such as a pack made on request at midday, count in tokens and cost but not in minutes).
    # The wait between the PC's part 1 and the cloud's part 2 is part of the morning, so a gap
    # only ends it once the scoring step has run.
    timed = sorted((t, e.get("agent")) for t, e in ((_when(e.get("at")), e) for e in entries) if t)
    minutes = 0
    if timed:
        end, scored = timed[0][0], timed[0][1] == "orchestrator"
        for t, agent in timed[1:]:
            if scored and (t - end).total_seconds() > MORNING_GAP_MINUTES * 60:
                break
            end = t
            scored = scored or agent == "orchestrator"
        minutes = int(round((end - timed[0][0]).total_seconds() / 60))

    local = {"in": 0, "out": 0}
    for s in (specs, replies):
        t = _obj(s.get("tokens"))
        local["in"] += _int(t.get("in"))
        local["out"] += _int(t.get("out"))

    cloud = cloud_tokens(run, entries)
    pr = prices(settings)
    cost = round((cloud["in"] * pr["inputPerMillion"] + cloud["out"] * pr["outputPerMillion"]) / 1e6, 2)
    shortlisted = sum(1 for s in scores if isinstance(s, dict) and s.get("shortlisted") is True)
    look = sum(1 for s in scores if isinstance(s, dict) and s.get("band") == "look")
    if not look and not any(isinstance(s, dict) and "band" in s for s in scores):
        # Runs before the band was recorded: count from the scores and the settings.
        sc = (settings or {}).get("scoring") or {}
        low, high = sc.get("lookBand", 55), sc.get("threshold", 60)
        look = sum(1 for s in scores if isinstance(s, dict) and s.get("shortlisted") is not True
                   and isinstance(s.get("score"), (int, float)) and low <= s["score"] < high)

    if status and status.get("ok") is False:
        state = "failed"
    elif "orchestrator" not in by_agent:
        state = "partial" if entries else "none"
    else:
        state = "done"

    return {
        "date": date,
        "status": state,
        "found": _int(counts.get("found")),
        "toScore": _int(counts.get("score")),
        "dropped": _int(counts.get("dropped")),
        "known": _int(counts.get("known")),
        "analysed": total("orchestrator", "scored") or len(scores),
        "shortlisted": shortlisted,
        "worthALook": look,
        "packs": total("writer", "packs"),
        "advertsRead": total("orchestrator", "advertsRead") or _int(_obj(specs.get("counts")).get("ok")),
        "minutes": minutes,
        "steps": len(entries),
        "localTokens": local,
        "cloudTokens": cloud,
        "cost": cost,
        "currency": pr["currency"],
        "perShortlisted": round(cost / shortlisted, 2) if shortlisted else None,
        "estimated": ["cloudTokens", "cost", "perShortlisted"],
        "method": METHOD["version"],
        "backfilled": bool(backfilled),
        "ledger": [e.get("id") for e in entries if e.get("id")][:40],
    }


def none_doc(date, settings=None):
    """A morning with no run (G4): all counts nil, nothing estimated to have been spent."""
    pr = prices(settings)
    return {"date": date, "status": "none", "found": 0, "toScore": 0, "dropped": 0, "known": 0, "analysed": 0,
            "shortlisted": 0, "worthALook": 0, "packs": 0, "advertsRead": 0, "minutes": 0, "steps": 0,
            "localTokens": {"in": 0, "out": 0}, "cloudTokens": {"in": 0, "out": 0}, "cost": 0.0, "currency": pr["currency"],
            "perShortlisted": None, "estimated": ["cloudTokens", "cost", "perShortlisted"], "method": METHOD["version"],
            "backfilled": False, "ledger": []}


def gaps(run, settings=None):
    status = _obj(_json(os.path.join(run, "status.json"), {}))
    missed = [d for d in (status.get("missed") or []) if isinstance(d, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", d)]
    return [none_doc(d, settings) for d in sorted(set(missed))[:14]]


def backfill(data, settings=None, start="2026-10-17"):
    out = []
    for run in sorted(glob.glob(os.path.join(data, "runs", "????-??-??"))):
        date = os.path.basename(run)
        if date < start:
            continue
        ledger = _json(os.path.join(data, "ledger", f"{date}.json"), {"entries": []})
        out.append(build(run, ledger, settings, backfilled=True))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("run")
    b.add_argument("ledger")
    b.add_argument("--settings")
    b.add_argument("--backfilled", action="store_true")
    g = sub.add_parser("gaps")
    g.add_argument("run")
    g.add_argument("--settings")
    f = sub.add_parser("backfill")
    f.add_argument("data")
    f.add_argument("--settings")
    f.add_argument("--from", dest="start", default="2026-10-17")
    a = ap.parse_args(argv)
    settings = _json(a.settings, {}) if a.settings else {}
    if a.cmd == "build":
        doc = build(a.run, _json(a.ledger, {"entries": []}), settings, a.backfilled)
    elif a.cmd == "gaps":
        doc = gaps(a.run, settings)
    else:
        doc = backfill(a.data, settings, a.start)
    json.dump(doc, sys.stdout, indent=1)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
