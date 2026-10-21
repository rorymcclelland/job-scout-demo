"""Replies to applications, in the cloud (backlog I3 and I4, Sprint 6a).

Part 2 (08:10) runs this on the PC's reply summary and an export of the board:

    python tools/replies.py match --summary replies/summary.json --board board.json --today 2026-10-18 > replies/matched.json
    python tools/validate.py moves replies/matched.json --existing board.json
    python tools/replies.py watchlist --board board.json --tracker applications.md --previous watchlist.json > watchlist.json
    python tools/replies.py keep --board board.json --today 2026-10-18 > keep.json   (H10)

"match" pairs each reply with a card (I3) and decides what happens to it (I4),
by fixed rules:

    invitation, assessment, offer   Applied               -> In Conversation
    rejection                       Applied, In Conversation -> Rejected
    anything else                   no move; logged

A move is MADE only when the reply reader has passed the owner's grading, the reply
is not from the first 60-day look back, its sender passed DKIM and everything
it says was found in the email. Otherwise it is SUGGESTED: shown on the card
with Confirm and Dismiss, and nothing changes until he confirms. A Draft or
Archived card never moves, nothing moves backwards, and a reply already on a
card's log (moved, suggested, undone or dismissed) is never acted on again.

The output carries the exact board patches, so part 2 writes only what the
checker (validate.py moves) has passed. Standard library only.
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlparse

MOVES = {
    "invitation": {"applied": "conversation"},
    "assessment": {"applied": "conversation"},
    "offer": {"applied": "conversation"},
    "rejection": {"applied": "rejected", "conversation": "rejected"},
}
LABEL = {"draft": "Draft", "applied": "Applied", "conversation": "In Conversation", "rejected": "Rejected", "archived": "Archived"}
LEGACY = {"preparing": "draft", "screening": "conversation", "interviewing": "conversation", "offer": "conversation", "closed": "rejected", "withdrawn": "rejected"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Hosts that are not an employer's own domain: job boards, hiring systems, aggregators.
NOT_EMPLOYER = (
    "linkedin.com", "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "myworkdayjobs.com", "myworkday.com",
    "smartrecruiters.com", "teamtailor.com", "personio.de", "personio.com", "bamboohr.com", "recruitee.com",
    "builtin.com", "builtinlondon.uk", "otta.com", "welcometothejungle.com", "indeed.com", "glassdoor.com", "hackajob.com",
    "google.com", "careers.google.com", "microsoft.com", "jobs.careers.microsoft.com", "wellfound.com", "dover.com",
)
_OWN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "own-domains.txt")
FREE_MAIL = ("gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "proton.me", "protonmail.com", "pm.me", "example.com") + tuple(
    # The owner's own mail domains, kept out of the public copy (H22): one per line in config/own-domains.txt.
    l.strip().lower() for l in (open(_OWN, encoding="utf-8").read().splitlines() if os.path.exists(_OWN) else []) if l.strip() and not l.startswith("#"))
TWO_LEVEL = ("co.uk", "org.uk", "ac.uk", "com.tw", "org.tw", "com.au", "co.jp", "co.nz", "com.sg", "co.in")


def stage(status):
    s = str(status or "").lower()
    return LEGACY.get(s, s if s in LABEL else "draft")


def norm(s):
    s = re.sub(r"\(formerly[^)]*\)", "", str(s or ""), flags=re.I)
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    s = re.sub(r"\b(ltd|limited|inc|plc|gmbh|llc|the|group)\b", " ", s)
    return " ".join(s.split())


def tokens(s):
    return set(norm(s).split()) - {"of", "and", "for", "a", "an", "the"}


def role_score(a, b):
    """How alike two role titles are: shared words over the longer title's words."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def employer_domain(url):
    """The employer's own registrable domain from an advert address, or None for job boards and hiring systems."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    if not host or any(host == d or host.endswith("." + d) for d in NOT_EMPLOYER):
        return None
    parts = host.split(".")
    n = 3 if ".".join(parts[-2:]) in TWO_LEVEL else 2
    return ".".join(parts[-n:]) if len(parts) >= n else None


def short_date(iso):
    if not iso or len(iso) < 10:
        return "an undated email"
    return f"{int(iso[8:10])} {MONTHS[int(iso[5:7]) - 1]}"


def handled(card_data, reply_id):
    for e in card_data.get("log") or []:
        if isinstance(e, dict) and reply_id in (e.get("replyId"), e.get("undo"), e.get("dismissed"), e.get("confirmed")):
            return True
    return any(isinstance(s, dict) and s.get("replyId") == reply_id for s in card_data.get("suggestions") or [])


def thread_ids(card_data):
    ids = set()
    for e in card_data.get("log") or []:
        if isinstance(e, dict):
            ids.update(e.get("thread") or [])
    return ids


def find_card(r, cards):
    """I3: returns (card or None, method, note)."""
    read = r.get("read") or {}
    company, role = read.get("company") or "", read.get("role") or ""
    by_id = {c["id"]: c for c in cards}

    def narrow(cands, how):
        live = [c for c in cands if stage(c["data"].get("status")) in ("applied", "conversation")] or cands
        if len(live) == 1:
            return live[0], how, None
        if role:
            scored = sorted(((role_score(role, c["data"].get("role", "")), i) for i, c in enumerate(live)), reverse=True)
            # The best title must be close, and clearly closer than the next one.
            if scored[0][0] >= 0.6 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
                return live[scored[0][1]], how + " and role", None
        return None, "unmatched", f"{len(live)} applications at {live[0]['data'].get('company', 'this company')}, and the reply does not say which role"

    # A reply in a thread the scout has already matched goes to the same card (I3.5).
    mine = set([r.get("thread", {}).get("id") or ""] + list(r.get("thread", {}).get("parents") or [])) - {""}
    if mine:
        same = [c for c in cards if mine & thread_ids(c["data"])]
        if len(same) == 1:
            return same[0], "thread", None
    # A company's own domain or a recruiter on the watch list (I1).
    pointed = [by_id[i] for i in r.get("cardIds") or [] if i in by_id]
    if pointed:
        if r.get("via") == "company" and company and norm(company) not in {norm(c["data"].get("company")) for c in pointed}:
            return None, "unmatched", f"sent from {r.get('domain')} but names {company}: check it is genuine"
        return narrow(pointed, "sender")
    # A hiring system or LinkedIn: by the company the email names (I3.3).
    if company:
        named = [c for c in cards if norm(c["data"].get("company")) and (norm(c["data"].get("company")) == norm(company) or norm(company).startswith(norm(c["data"].get("company")) + " "))]
        if named:
            return narrow(named, "company")
        return None, "unmatched", f"{company} is not on the board"
    return None, "unmatched", "the reply does not name the company"


def decide(r, card, grade_passed):
    """I4: what happens to a matched reply."""
    data = card["data"]
    read = r.get("read") or {}
    typ = read.get("type") or "other"
    now = stage(data.get("status"))
    to = MOVES.get(typ, {}).get(now)
    checks = []
    if not r.get("verified"):
        checks.append("the sender could not be verified")
    if r.get("byName"):
        checks.append("the sender's domain was matched by the company's name only: check it is the company's own")
    if r.get("status") != "ok":
        checks.append("some details were not found in the email")
    if r.get("firstLook"):
        checks.append("from the first look back")
    if not grade_passed:
        checks.append("the reader has not passed its grading yet")
    if now in ("draft", "archived") and typ in MOVES:
        return "log", now, None, f"a {typ} for a card still in {LABEL[now]}: check it"
    if to is None:
        return "log", now, None, None
    if checks:
        return "suggest", now, to, "; ".join(checks)
    return "move", now, to, None


def short_warnings(ws):
    """BUG-3: the reader's warnings, cut to what a card or Inbox entry can show."""
    out = []
    for w in ws or []:
        if isinstance(w, str) and w.strip():
            w = " ".join(w.split())
            out.append(w if len(w) <= 120 else w[:117].rstrip() + "...")
    return out[:3]


def warnings_text(ws):
    ws = short_warnings(ws)
    return (" Warning: " + "; ".join(ws) + ".") if ws else ""


def match(summary, board, today, at):
    cards = [c for c in board if isinstance(c, dict) and isinstance(c.get("data"), dict) and c.get("id")]
    grade = summary.get("grade") or {}
    passed = grade.get("passed") is True
    items, patches = [], {}
    for r in summary.get("replies") or []:
        read = r.get("read") or {}
        typ = read.get("type") or "unread"
        base = {
            "replyId": r.get("id"), "type": typ, "emailDate": r.get("date") or "", "domain": r.get("domain"), "via": r.get("via"), "byName": bool(r.get("byName")),
            "verified": bool(r.get("verified")), "offer": typ == "offer",
            "ask": read.get("ask") or "", "askBy": (read.get("askBy") or {}).get("date"),
            "dates": [d for d in read.get("dates") or [] if d.get("date")], "calendar": r.get("calendar"),
            "warnings": short_warnings(r.get("warnings")), "named": read.get("company") or "",
        }
        if r.get("status") in ("failed", "missing"):
            items.append({**base, "cardId": None, "action": "unread", "note": r.get("reason") or "not read"})
            continue
        card, how, note = find_card(r, cards)
        if not card:
            items.append({**base, "cardId": None, "action": "unmatched", "note": note})
            continue
        current = patches.get(card["id"], {})
        data = {**card["data"], **current}
        if handled(data, r.get("id")):
            items.append({**base, "cardId": card["id"], "action": "skip", "note": "already on the card's log"})
            continue
        action, frm, to, why = decide(r, {"data": data}, passed)
        thread = [x for x in [r.get("thread", {}).get("id")] + list(r.get("thread", {}).get("parents") or []) if x]
        entry = {"at": at, "by": "scout", "replyId": r.get("id"), "type": typ, "emailDate": r.get("date") or "", "thread": thread}
        when = short_date(r.get("date"))
        sys_name = (r.get("system") or r.get("domain") or "").capitalize()
        patch = dict(current)
        log = list(data.get("log") or [])
        warn = warnings_text(r.get("warnings"))
        if action == "move":
            entry.update({"move": {"from": frm, "to": to}, "text": f"Moved by the scout to {LABEL[to]}: {typ}, email of {when} ({sys_name}). Undo on the card puts it back.{warn}"})
            patch["status"] = to
        elif action == "suggest":
            entry.update({"suggest": {"from": frm, "to": to}, "text": f"Suggested by the scout: {LABEL[to]} ({typ}, email of {when}). Nothing changes until you confirm. {why[0].upper() + why[1:]}.{warn}"})
            patch["suggestions"] = list(data.get("suggestions") or []) + [{"replyId": r.get("id"), "type": typ, "from": frm, "to": to, "emailDate": r.get("date") or "", "note": why + (f". {warn.strip()}" if warn else "")}]
        else:
            entry["text"] = f"Reply from {sys_name}: {typ}, email of {when}." + (f" {why[0].upper() + why[1:]}." if why else "") + (f" They ask: “{read['ask']}”" if read.get("ask") else "") + warn
        patch["log"] = log + [entry]
        patches[card["id"]] = patch
        items.append({**base, "cardId": card["id"], "company": data.get("company"), "role": data.get("role"), "method": how, "action": action, "from": frm, "to": to, "note": why})
    counts = {}
    for it in items:
        counts[it["action"]] = counts.get(it["action"], 0) + 1
    return {
        "date": today, "gradePassed": passed, "firstLook": bool(summary.get("firstLook")),
        "counts": counts, "items": items,
        "patches": [{"cardId": k, "patch": v} for k, v in patches.items()],
    }


def emails_in(*texts):
    out = set()
    for t in texts:
        out.update(m.lower() for m in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", str(t or "")))
    return sorted(out)


def tracker_rows(text):
    """Rows of _context\\applications.md that are live applications: Company | Role | Status | ..."""
    rows = []
    for line in (text or "").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or set(cells[0]) <= set("-: ") or cells[0].lower() == "company":
            continue
        if re.search(r"applied|conversation|interview|screen|assessment|offer", cells[2], re.I):
            rows.append({"company": cells[0], "role": cells[1], "status": cells[2]})
    return rows


def watchlist(board, tracker_text, previous, today, matched=None):
    prev = {e.get("cardId"): e for e in (previous or {}).get("entries", []) if isinstance(e, dict)}
    # I9: a company domain a reply came from, matched to its card today, is kept for the next mornings.
    learned = {}
    for it in (matched or {}).get("items") or []:
        dom = (it.get("domain") or "").lower()
        if it.get("cardId") and it.get("via") == "company" and not it.get("byName") and dom and dom not in FREE_MAIL and not any(dom == n or dom.endswith("." + n) for n in NOT_EMPLOYER):
            learned.setdefault(it["cardId"], set()).add(dom)
    # The board wins over the tracker: a company with any card, live or closed, is not taken from the tracker.
    companies = {norm(c["data"].get("company")) for c in board if isinstance(c, dict) and isinstance(c.get("data"), dict)}
    entries = []
    for c in board:
        if not isinstance(c, dict) or not isinstance(c.get("data"), dict):
            continue
        d = c["data"]
        st = stage(d.get("status"))
        if st not in ("applied", "conversation"):
            continue
        domains = set(prev.get(c["id"], {}).get("domains") or []) | learned.get(c["id"], set())
        dom = employer_domain(d.get("link") or "")
        if dom:
            domains.add(dom)
        notes = [d.get("notes"), d.get("next"), d.get("blurb")] + [e.get("text") for e in d.get("log") or [] if isinstance(e, dict) and e.get("by") != "scout"]
        found = emails_in(*notes)
        recruiters = set(prev.get(c["id"], {}).get("recruiters") or []) | set(found)
        # An address the owner noted at the company's own domain gives that domain too.
        for addr in found:
            dom = addr.split("@", 1)[1]
            if dom not in FREE_MAIL and not any(dom == n or dom.endswith("." + n) for n in NOT_EMPLOYER):
                domains.add(dom)
        entries.append({"cardId": c["id"], "company": d.get("company", ""), "role": d.get("role", ""), "status": st, "domains": sorted(domains), "recruiters": sorted(recruiters)})
    for row in tracker_rows(tracker_text):
        if norm(row["company"]) in companies:
            continue
        key = "tracker-" + re.sub(r"[^a-z0-9]+", "-", norm(row["company"] + " " + row["role"])).strip("-")
        entries.append({"cardId": key, "company": row["company"], "role": row["role"], "status": "conversation" if re.search(r"conversation|interview|screen|offer", row["status"], re.I) else "applied", "domains": sorted(set(prev.get(key, {}).get("domains") or []) | learned.get(key, set())), "recruiters": sorted(prev.get(key, {}).get("recruiters") or [])})
    # I9: applications with no domain and no recruiter address: the mail read can only find them by the company's name.
    unknown = [e["company"] for e in entries if not e["domains"] and not e["recruiters"]]
    return {"written": today, "entries": entries, "noDomain": unknown}


# ---- Sprint 7: what retention keeps (H10) ----
KEPT_STAGES = ("applied", "conversation", "rejected")


def keep_list(board, today):
    """data/keep.json: the roles the owner applied for. The mail read keeps their adverts,
    specs and replies past the 90 days; everything else old is deleted."""
    roles, cards = set(), set()
    for c in board:
        if not isinstance(c, dict) or not isinstance(c.get("data"), dict):
            continue
        if stage(c["data"].get("status")) not in KEPT_STAGES:
            continue
        cards.add(str(c.get("id")))
        sid = c["data"].get("scoutId")
        if isinstance(sid, str) and sid:
            roles.add(sid)
    return {"written": today, "roles": sorted(roles), "cards": sorted(cards)}


# ---- Sprint 6b: the Inbox, to-do list and calendar (I5, I7) ----
UK = "Europe/London"


def board_docs(matched, today, existing_ids=None):
    """The documents part 2 creates for the board's Inbox and Calendar tabs. Create-only:
    an id already on the board is skipped, so the owner's ticks and choices are never overwritten."""
    have = {k: set(v or []) for k, v in (existing_ids or {}).items()}
    writes = []

    def add(collection, doc_id, data):
        if doc_id in have.get(collection, set()):
            return
        have.setdefault(collection, set()).add(doc_id)
        writes.append({"collection": collection, "doc_id": doc_id, "data": data})

    for it in matched.get("items") or []:
        rid = it.get("replyId")
        if not rid or it.get("action") == "skip":
            continue
        company = it.get("company") or it.get("named") or ""
        who = company or it.get("domain") or ""
        typ = it.get("type") or "other"
        base = {"replyId": rid, "cardId": it.get("cardId"), "company": company, "role": it.get("role") or "", "domain": it.get("domain") or ""}
        warns = short_warnings(it.get("warnings"))
        add("replies", rid, {**base, "date": it.get("emailDate") or "", "type": typ, "action": it.get("action"),
                             "note": (it.get("note") or "")[:200], "offer": bool(it.get("offer")), "seen": False, "source": "scout", "created": today,
                             **({"warnings": warns} if warns else {})})
        if it.get("ask"):
            add("todos", rid, {**base, "ask": it["ask"][:200], "askBy": it.get("askBy"), "done": False, "source": "scout", "created": today,
                               **({"warnings": warns} if warns else {})})
        if it.get("askBy"):
            add("events", rid + "-d", {**base, "kind": "deadline", "start": it["askBy"], "end": None, "zone": None, "zoneAssumed": False,
                                       "title": f"Deadline · {who}", "asWritten": "", "group": rid, "source": "scout", "created": today})
        cal = it.get("calendar")
        if cal and cal.get("start"):
            add("events", rid + "-c", {**base, "kind": "confirmed", "start": cal["start"], "end": cal.get("end"), "zone": cal.get("zone") or UK,
                                       "zoneAssumed": not cal.get("zone"), "title": f"{typ.capitalize()} · {who}", "asWritten": "", "group": rid, "source": "scout", "created": today})
        elif typ == "invitation":
            slots = [d for d in it.get("dates") or [] if d.get("date") and d.get("time")]
            for n, d in enumerate(slots[:6], 1):
                add("events", f"{rid}-{n}", {**base, "kind": "proposed", "start": f"{d['date']}T{d['time']}:00", "end": None,
                                            "zone": d.get("zone") or UK, "zoneAssumed": not d.get("zone"), "title": f"Proposed · {who}",
                                            "asWritten": (d.get("asWritten") or "")[:120], "group": rid, "source": "scout", "created": today})
    return {"date": today, "writes": writes}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("match")
    m.add_argument("--summary", required=True)
    m.add_argument("--board", required=True, help="the board's applications, as [{id, data}]")
    m.add_argument("--today", required=True)
    m.add_argument("--at", help="time stamp for log entries (ISO); defaults to today at 08:10")
    dc = sub.add_parser("docs")
    dc.add_argument("--matched", required=True)
    dc.add_argument("--existing-ids", help='{"replies": [...], "todos": [...], "events": [...]}: ids already on the board')
    dc.add_argument("--today", required=True)
    w = sub.add_parser("watchlist")
    w.add_argument("--board", required=True)
    w.add_argument("--tracker")
    w.add_argument("--previous")
    w.add_argument("--matched", help="today's matched.json, so a domain a reply came from is kept (I9)")
    w.add_argument("--today", required=True)
    k = sub.add_parser("keep")
    k.add_argument("--board", required=True)
    k.add_argument("--today", required=True)
    a = ap.parse_args(argv)

    def load(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    if a.cmd == "match":
        out = match(load(a.summary), load(a.board), a.today, a.at or f"{a.today}T08:10:00Z")
    elif a.cmd == "keep":
        board = load(a.board)
        if not isinstance(board, list) or not board:
            print("The board export is empty: no keep list written (the mail read then deletes nothing).", file=sys.stderr)
            return 1
        out = keep_list(board, a.today)
    elif a.cmd == "docs":
        out = board_docs(load(a.matched), a.today, load(a.existing_ids) if a.existing_ids else None)
    else:
        tracker = ""
        if a.tracker:
            with open(a.tracker, encoding="utf-8") as f:
                tracker = f.read()
        out = watchlist(load(a.board), tracker, load(a.previous) if a.previous else None, a.today, load(a.matched) if a.matched else None)
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
