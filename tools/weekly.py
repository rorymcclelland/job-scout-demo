"""The Job Scout's weekly summary (backlog F4) and response tracking (F3).

Run by Claude on Mondays, following _context/job-scout/WEEKLY.md, in its own
workspace. It only counts: every number comes from the two inputs, so the
summary can be checked by running it again.

Inputs:
  metrics.csv   Job Scout\\data\\metrics.csv, one line per scored run
  board.json    the board's `applications` collection exported as a list of
                {"id": ..., "data": {...}} objects (ArtifactData query)

Usage:
  python3 weekly.py metrics.csv board.json --week-ending 2026-10-18 [--ledgers DIR] [--out summary.md]

--ledgers is Job Scout\data\ledger (H7): with it, the summary adds a table of
the week's AI steps by model, so a change of model can be judged on results.

The week is the seven days ending on --week-ending (inclusive).
"""

import argparse
import csv
import glob
import json
import os
from collections import Counter, defaultdict
from datetime import date, timedelta

RESPONDED = {"conversation"}          # board stage "In Conversation"
CLOSED = {"rejected"}                 # board stage "Rejected"
STAGES = ["draft", "applied", "conversation", "rejected", "archived"]


def stage_of(status: str) -> str:
    s = (status or "").lower()
    if s in ("preparing", "draft"):
        return "draft"
    if s in ("screening", "interviewing", "offer", "conversation"):
        return "conversation"
    if s in ("closed", "withdrawn", "rejected"):
        return "rejected"
    if s == "archived":
        return "archived"
    return "applied" if s == "applied" else s or "draft"


def band(score) -> str:
    try:
        n = float(score)
    except (TypeError, ValueError):
        return "unscored"
    if n >= 80:
        return "80+"
    if n >= 70:
        return "70-79"
    if n >= 60:
        return "60-69"
    return "under 60"


def in_week(day: str, start: date, end: date) -> bool:
    try:
        d = date.fromisoformat((day or "")[:10])
    except ValueError:
        return False
    return start <= d <= end


def by_model(entries, start: date, end: date):
    """H7: the week's AI ledger entries grouped by agent and model, with their counts summed."""
    groups = defaultdict(lambda: {"runs": 0, "counts": Counter()})
    for e in entries:
        if e.get("kind") != "ai" or not in_week(str(e.get("id", ""))[:10], start, end):
            continue
        g = groups[(e.get("agent", "?"), e.get("model") or "unknown", e.get("where", "?"))]
        g["runs"] += 1
        for k, v in (e.get("counts") or {}).items():
            if isinstance(v, (int, float)):
                g["counts"][k] += v
    return groups


def read_ledgers(folder):
    entries = []
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                entries += json.load(f).get("entries", [])
        except (OSError, ValueError):
            continue
    return entries


def replies_section(cards, start: date, end: date, reply_rows=None):
    """I6 (Sprint 6a): replies this week, from the scout's entries on the card logs, and response rates by source."""
    out = ["## Replies this week (I6)", ""]
    week = []
    for c in cards:
        for e in c.get("log") or []:
            if isinstance(e, dict) and e.get("by") == "scout" and e.get("replyId") and in_week(str(e.get("emailDate", ""))[:10], start, end):
                week.append((c, e))
    if not week:
        out.append("No replies matched to a card this week.")
    else:
        counts = Counter(e.get("type", "other") for _, e in week)
        out.append(", ".join(f"{counts[t]} {t}{'s' if counts[t] != 1 and not t.endswith('s') else ''}" for t in ("offer", "invitation", "assessment", "request", "rejection", "follow-up", "other") if counts[t]) + ".")
        out.append("")
        out.append("| Email | Company | Role | Reply | What happened |")
        out.append("| --- | --- | --- | --- | --- |")
        for c, e in sorted(week, key=lambda x: str(x[1].get("emailDate", ""))):
            what = "moved" if e.get("move") else ("suggested" if e.get("suggest") else "logged")
            out.append(f"| {str(e.get('emailDate', ''))[:10]} | {c.get('company', '')} | {c.get('role', '')} | {e.get('type', '')} | {what} |")
    if reply_rows:
        wk = [r for r in reply_rows if in_week(r.get("date", ""), start, end)]
        if wk:
            tot = lambda k: sum(int(r.get(k) or 0) for r in wk)
            out.append("")
            out.append(f"From the daily runs: {tot('found')} found, {tot('moved')} moved, {tot('suggested')} suggested, {tot('unmatched')} unmatched.")
    out.append("")
    out.append("**Response rate by source, all applications** (shown once a source has five or more)")
    out.append("")
    sent = [c for c in cards if stage_of(c.get("status")) in ("applied", "conversation", "rejected")]
    groups = defaultdict(list)
    for c in sent:
        groups[c.get("site") or ("scout" if c.get("source") == "scout" else "your own")].append(c)
    shown = [(g, cs) for g, cs in sorted(groups.items()) if len(cs) >= 5]
    if shown:
        out.append("| Source | Sent | Any reply | Conversation | Rejected | Response rate |")
        out.append("| --- | --- | --- | --- | --- | --- |")
        for g, cs in shown:
            conv = sum(stage_of(c.get("status")) in RESPONDED for c in cs)
            rej = sum(stage_of(c.get("status")) in CLOSED for c in cs)
            out.append(f"| {g} | {len(cs)} | {conv + rej} | {conv} | {rej} | {(conv + rej) / len(cs):.0%} |")
    else:
        out.append("No source has five applications yet.")
    out.append("")
    return out


def eval_section(latest=None, reader=None):
    """H8 (Sprint 7): one line on the latest evaluation, or that it has not been run."""
    out = ["## Evaluation (H8)", ""]
    if not latest and not reader:
        out.append("Not run yet. Label the sheet in _context\\job-scout\\eval, then ask Claude to run EVAL.md; npm run eval:reader checks the reader on the PC.")
        return out + [""]
    if latest and (latest.get("scoring") or {}).get("agreement") is not None:
        sc, d = latest["scoring"], latest.get("drift") or {}
        line = f"Scoring, {latest.get('date')}: {sc['right']} of {sc['of']} agree with your labels ({sc['agreement']}%), {len(sc['falsePositives'])} false positive{'s' if len(sc['falsePositives']) != 1 else ''}, {len(sc['falseNegatives'])} false negative{'s' if len(sc['falseNegatives']) != 1 else ''}."
        if d.get("flag"):
            line += " **Drift flagged:** " + "; ".join(d.get("reasons") or []) + "."
        out.append(line)
    elif latest:
        out.append(f"Scoring, {latest.get('date')}: no labelled roles yet.")
    else:
        out.append("Scoring: not run yet.")
    r = reader or (latest or {}).get("reader")
    out.append(f"Reader, {r.get('date')}: {r.get('model')}, {r.get('right')} of {r.get('of')} right." if r else "Reader: not run yet (npm run eval:reader).")
    return out + [""]


def runs_section(runs, start: date, end: date):
    """G11 (Sprint 10): the week's morning runs from the board's runs collection, and the change from the week before."""
    docs = [r.get("data", r) for r in runs or [] if isinstance(r, dict)]
    def week(s, e):
        return [d for d in docs if in_week(str(d.get("date", "")), s, e)]
    def totals(ws):
        cost = sum(d["cost"] for d in ws if isinstance(d.get("cost"), (int, float)))
        short = sum(int(d.get("shortlisted") or 0) for d in ws)
        return cost, short, (cost / short if short else None)
    by_date = lambda ws: sorted(ws, key=lambda d: str(d.get("date", "")))
    this, last = by_date(week(start, end)), by_date(week(start - timedelta(days=7), start - timedelta(days=1)))
    out = ["## Morning runs (G11)", ""]
    if not this:
        out += ["No run log this week.", ""]
        return out
    cur = this[-1].get("currency") or "USD"
    # Costs in another currency (the prices were changed mid-week) are left out, not added up.
    this = [d for d in this if (d.get("currency") or "USD") == cur]
    last = [d for d in last if (d.get("currency") or "USD") == cur]
    cost, short, per = totals(this)
    money = lambda v: "none" if v is None else f"{cur} {v:.2f}"
    line = f"{len(this)} runs, {short} shortlisted, estimated cost {money(cost)}, {money(per)} per shortlisted role"
    if last:
        lcost, lshort, lper = totals(last)
        bits = [f"cost {'up' if cost > lcost else 'down'} {money(abs(cost - lcost))}" if abs(cost - lcost) >= 0.005 else "cost the same"]
        if per is not None and lper is not None:
            bits.append(f"per shortlisted role {'up' if per > lper else 'down'} {money(abs(per - lper))}" if abs(per - lper) >= 0.005 else "per shortlisted role the same")
        line += f" ({', '.join(bits)} on the week before)"
    out += [line + ". Costs are estimates (method " + ", ".join(sorted({str(d.get('method')) for d in this})) + "): read them for the change, not as a bill.", ""]
    return out


def summarise(metrics_rows, cards, start: date, end: date, ledger_entries=None, reply_rows=None, evaluation=None, runs=None) -> str:
    week = [r for r in metrics_rows if in_week(r["date"], start, end)]
    found = sum(int(r["roles_found"]) for r in week)
    scored = sum(int(r["scored"]) for r in week)
    relevant = sum(int(r["relevant"]) for r in week)
    shortlisted = sum(int(r["shortlisted"]) for r in week)
    runs = len(week)

    scout = [c for c in cards if c.get("source") == "scout"]
    scout_week = [c for c in scout if in_week(c.get("runDate", ""), start, end)]
    applied_week = [c for c in cards if in_week(c.get("applied", ""), start, end)]
    applied_scout = [c for c in applied_week if c.get("source") == "scout"]
    archived_week = [c for c in scout if stage_of(c.get("status")) == "archived" and in_week(c.get("archivedAt", ""), start, end)]

    out = []
    out.append(f"# Job Scout weekly summary, {start.day} {start:%b} to {end.day} {end:%b %Y}")
    out.append("")
    out.append("## The two success measures")
    out.append("")
    out.append(f"- **Relevant roles found:** {relevant} over {runs} run{'s' if runs != 1 else ''}"
               + (f" ({relevant / runs:.1f} a day)" if runs else "") + f", from {found} roles read and {scored} scored.")
    out.append(f"- **Applied for:** {len(applied_week)} this week, {len(applied_scout)} of them found by the scout"
               + (f" ({len(applied_scout)} of {shortlisted} shortlisted)" if shortlisted else "") + ".")
    out.append("")

    out.append("## Day by day")
    out.append("")
    if week:
        out.append("| Date | Emails | Found | Scored | Relevant | Shortlisted | Rubric |")
        out.append("| --- | --- | --- | --- | --- | --- | --- |")
        for r in sorted(week, key=lambda r: r["date"]):
            out.append(f"| {r['date']} | {r['emails']} | {r['roles_found']} | {r['scored']} | {r['relevant']} | {r['shortlisted']} | v{r['rubric_version']} |")
    else:
        out.append("No scored runs this week. Check the Windows task and Bridge.")
    out.append("")

    out.append("## What happened to this week's shortlist")
    out.append("")
    if scout_week:
        counts = Counter(stage_of(c.get("status")) for c in scout_week)
        out.append(", ".join(f"{counts[s]} {s}" for s in STAGES if counts[s]) + ".")
        out.append("")
        out.append("| Score | Company | Role | Stage | Reason (if archived) |")
        out.append("| --- | --- | --- | --- | --- |")
        for c in sorted(scout_week, key=lambda c: -float(c.get("score") or 0)):
            out.append(f"| {c.get('score') if c.get('score') not in (None, '') else '-'} | {c.get('company', '')} | {c.get('role', '')} | {stage_of(c.get('status'))} | {c.get('archivedReason', '') if stage_of(c.get('status')) == 'archived' else ''} |")
    else:
        out.append("No scouted roles this week.")
    out.append("")

    out.extend(replies_section(cards, start, end, reply_rows))

    out.append("## Responses so far, all scouted roles (F3)")
    out.append("")
    sent = [c for c in scout if stage_of(c.get("status")) in ("applied", "conversation", "rejected")]
    if not sent:
        out.append("No scouted role has been applied for yet, so there is nothing to compare.")
    else:
        for label, key in (("Score band", lambda c: band(c.get("score"))),
                           ("Source", lambda c: c.get("site") or "unknown"),
                           ("CV format", lambda c: c.get("cvFormat") or "unknown"),
                           ("Rubric version", lambda c: f"v{c.get('rubricVersion')}" if c.get("rubricVersion") else "unknown")):
            groups = defaultdict(list)
            for c in sent:
                groups[key(c)].append(c)
            out.append(f"**{label}**")
            out.append("")
            out.append("| | Sent | Conversation | Rejected | No reply yet | Response rate |")
            out.append("| --- | --- | --- | --- | --- | --- |")
            for g in sorted(groups):
                cs = groups[g]
                conv = sum(stage_of(c.get("status")) in RESPONDED for c in cs)
                rej = sum(stage_of(c.get("status")) in CLOSED for c in cs)
                wait = len(cs) - conv - rej
                out.append(f"| {g} | {len(cs)} | {conv} | {rej} | {wait} | {conv / len(cs):.0%} |")
            out.append("")
        out.append("Small numbers: read these as signs, not results, until there are 20 or more applications.")
    out.append("")

    if ledger_entries is not None:
        out.append("## Runs by model (H7)")
        out.append("")
        groups = by_model(ledger_entries, start, end)
        if groups:
            out.append("| Step | Model | Where | Runs | Counts |")
            out.append("| --- | --- | --- | --- | --- |")
            for (agent, model, where), g in sorted(groups.items()):
                counts = ", ".join(f"{k} {v:g}" for k, v in sorted(g["counts"].items()))
                out.append(f"| {agent} | {model} | {where} | {g['runs']} | {counts} |")
        else:
            out.append("No AI steps recorded in the ledger this week.")
        out.append("")

    if evaluation is not None:
        out.extend(eval_section(*evaluation))

    if runs is not None:
        out.extend(runs_section(runs, start, end))

    out.append("## Reasons you gave for passing")
    out.append("")
    if archived_week:
        for c in archived_week:
            sc = c.get("score")
            out.append(f"- {c.get('company', '')}, {c.get('role', '')} ({'score ' + str(sc) if sc not in (None, '') else 'unscored'}): {c.get('archivedReason') or 'no reason given'}")
    else:
        out.append("None this week.")
    out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("metrics")
    ap.add_argument("board")
    ap.add_argument("--week-ending", required=True)
    ap.add_argument("--ledgers")
    ap.add_argument("--replies", help="Job Scout\\data\\replies.csv (Sprint 6a), if it exists")
    ap.add_argument("--eval", help="_context\\job-scout\\eval\\latest.json (H8), if it exists")
    ap.add_argument("--reader", help="Job Scout\\data\\eval\\reader-latest.json (H8), if it exists")
    ap.add_argument("--runs", help="the board's runs collection as a list of {id, data} (G11), if it exists")
    ap.add_argument("--out")
    a = ap.parse_args()
    end = date.fromisoformat(a.week_ending)
    start = end - timedelta(days=6)
    with open(a.metrics, newline="") as f:
        rows = list(csv.DictReader(f))
    def load(path):
        if not path or not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    raw = load(a.board)
    cards = [dict(d.get("data", d), id=d.get("id")) for d in raw]
    reply_rows = None
    if a.replies:
        with open(a.replies, newline="") as f:
            reply_rows = list(csv.DictReader(f))
    text = summarise(rows, cards, start, end, read_ledgers(a.ledgers) if a.ledgers else None, reply_rows, (load(a.eval), load(a.reader)), load(a.runs))
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
