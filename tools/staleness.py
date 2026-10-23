#!/usr/bin/env python3
"""What a pack was built from, and whether its advert has changed since (backlog E16 and E13, Sprint 10).

    python3 staleness.py record --root ROOT --cv REL --letter REL --notes REL --highlights REL
                                --answers REL [--spec spec.json] [--settings-version N] [--date D]
                                [--into pack.json]
    python3 staleness.py advert pack.json NEW_SPEC.json
    python3 staleness.py patches staleness.json board.json > packpatch.json
    python3 staleness.py facts advert-facts.json > spec.json

`facts` (E17, Sprint 11) makes a spec in the local reader's shape from the facts the cloud writer
took from an advert it read itself ({"mustHaves": [...], "pay": {min, max, currency, period} or
null, "location": "...", "closes": "YYYY-MM-DD" or null}), checked for shape and length, so
`record --spec` keeps the advert's facts whichever reader read it, and E13 can compare them later.

`patches` (BUG-8, Sprint 11) turns the PC's staleness.json into the patches for the board: one
per Draft card with no applied date whose pack it lists, matched by the pack's folder name (the last
part of the card's `pack`), because older cards name the pack without the folder it sits in. A
folder name listed twice is skipped and reported. Check the result with `validate.py packpatch`.

`record` hashes the files a pack was built from and prints `builtFrom` (or merges it into
pack.json with --into). Every path is relative to ROOT, the Professional development folder (or the
copy staged in the cloud), so the PC can find the same files: src/staleness.ts compares the hashes
each morning and says how fresh each pack is. Hashes are of the raw bytes, 16 hex characters of
SHA-256; a folder's hash covers its Markdown files by relative path (the same in staleness.ts).

`advert` compares the advert facts kept in builtFrom with a spec read later (E13). Only a change in
the requirements, pay, place or closing date counts; a change of wording does not (the user,
22 Oct 2026). Standard library only.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date

VERSION = 1
FILE_KEYS = ("cvBase", "letterBase", "highlights", "formAnswers")
FOLDER_KEYS = ("careerNotes",)
# Two must-haves are the same requirement when this share of their words match.
SAME_WORDS = 0.5
STOP = set("a an and or the of in on to for with as at by from is are be our your you we will this that it its".split())


def hash_bytes(b):
    return hashlib.sha256(b).hexdigest()[:16]


def hash_file(path):
    with open(path, "rb") as f:
        return hash_bytes(f.read())


def hash_folder(path):
    """The Markdown files under a folder, by forward-slash relative path. Symlinks are not followed."""
    lines = []
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)) and not d.startswith("."))
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if not name.lower().endswith(".md") or name.startswith(".") or os.path.islink(full):
                continue
            rel = os.path.relpath(full, path).replace(os.sep, "/")
            lines.append(f"{rel}\t{hash_file(full)}\n")
    return hash_bytes("".join(sorted(lines)).encode("utf-8"))


def safe_rel(rel):
    """A path relative to the root, with no way out of it. Returned with backslashes, as on the PC."""
    if not isinstance(rel, str) or not rel.strip():
        raise ValueError("a path is empty")
    parts = [p for p in re.split(r"[\\/]", rel.strip()) if p not in ("", ".")]
    if not parts or ".." in parts or re.match(r"^[A-Za-z]:", rel.strip()) or rel.strip().startswith(("/", "\\")):
        raise ValueError(f"{rel!r} must be a path inside the Professional development folder")
    return "\\".join(parts)


def _words(s):
    return {w for w in re.findall(r"[a-z0-9+#]+", str(s).lower()) if w not in STOP}


def _similar(a, b):
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    return len(wa & wb) / len(wa | wb) >= SAME_WORDS


def advert_facts(spec):
    """The parts of an advert that count as a change (E13): requirements, pay, place, closing date."""
    spec = spec or {}
    pay = spec.get("pay") if isinstance(spec.get("pay"), dict) else None
    return {
        "mustHaves": [str(m)[:300] for m in (spec.get("mustHaves") or []) if isinstance(m, str)][:40],
        "pay": {k: pay.get(k) for k in ("min", "max", "currency", "period")} if pay else None,
        "place": str(spec.get("location") or "")[:200],
        "closes": spec.get("closes") if isinstance(spec.get("closes"), str) else None,
    }


def advert_change(old_facts, new_spec):
    """What changed between the advert a pack was built from and one read later."""
    new = advert_facts(new_spec)
    what = []
    closed = isinstance(new_spec, dict) and new_spec.get("status") == "closed"
    if closed:
        what.append("advert closed")
    old = old_facts or {}
    # An advert that could not be read says nothing about a change (Sprint 10 check).
    if not closed and isinstance(new_spec, dict) and new_spec.get("status") not in (None, "ok"):
        return {"changed": False, "closed": False, "what": [], "unread": True}
    if not closed:
        old_m, new_m = old.get("mustHaves") or [], new["mustHaves"]
        added = [m for m in new_m if not any(_similar(m, o) for o in old_m)]
        removed = [o for o in old_m if not any(_similar(o, m) for m in new_m)]
        if not new_m:
            added = removed = []  # no requirements read: nothing to compare
        if added or removed:
            bits = []
            if added:
                bits.append(f"{len(added)} new")
            if removed:
                bits.append(f"{len(removed)} dropped")
            what.append("requirements changed (" + ", ".join(bits) + ")")
        op, np_ = old.get("pay") or {}, new["pay"] or {}
        if any(op.get(k) is not None and np_.get(k) is not None and op.get(k) != np_.get(k) for k in ("min", "max", "currency", "period")):
            what.append("pay changed")
        if old.get("place") and new["place"] and not _similar(old["place"], new["place"]):
            what.append("place changed")
        if (old.get("closes") or None) != (new["closes"] or None) and new["closes"]:
            what.append("closing date changed")
    return {"changed": bool(what), "closed": closed, "what": what}


PERIODS = ("year", "month", "day", "hour")
BAD_TEXT = re.compile(r"\b(ignore|disregard|forget|override)\b.{0,60}\b(instruction|instructions|prompt|rules?|previous|above)\b|\b(system|developer)\s*(prompt|message)\b", re.I)


def facts_to_spec(facts):
    """E17: the cloud writer's advert facts as a reader-shaped spec; raises ValueError on bad input."""
    if not isinstance(facts, dict):
        raise ValueError("advert facts must be an object")
    musts = facts.get("mustHaves")
    if not isinstance(musts, list) or not musts or not all(isinstance(m, str) and 0 < len(m.strip()) <= 300 for m in musts) or len(musts) > 40:
        raise ValueError("mustHaves must be a list of 1 to 40 requirements, each as written and at most 300 characters")
    for m in musts:
        if BAD_TEXT.search(m):
            raise ValueError(f"a requirement reads like an instruction, not a requirement: {m[:80]!r}")
    pay = facts.get("pay")
    if pay is not None:
        if not isinstance(pay, dict):
            raise ValueError("pay must be an object or null")
        for k in ("min", "max"):
            v = pay.get(k)
            if v is not None and (not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0):
                raise ValueError(f"pay.{k} must be a number or null")
        if pay.get("currency") is not None and (not isinstance(pay["currency"], str) or not 0 < len(pay["currency"]) <= 4):
            raise ValueError("pay.currency must be a short code such as GBP")
        if pay.get("period") is not None and pay["period"] not in PERIODS:
            raise ValueError(f"pay.period must be one of {', '.join(PERIODS)}")
    loc = facts.get("location", "")
    if not isinstance(loc, str) or len(loc) > 200 or BAD_TEXT.search(loc):
        raise ValueError("location must be a place, at most 200 characters")
    closes = facts.get("closes")
    if closes is not None and not (isinstance(closes, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", closes)):
        raise ValueError("closes must be a date (YYYY-MM-DD) or null")
    return {"status": "ok", "source": "cloud", "mustHaves": [m.strip() for m in musts],
            "pay": {k: pay.get(k) for k in ("min", "max", "currency", "period")} if pay else None,
            "location": loc.strip(), "closes": closes}


def _stage(status):
    # The board's stages, with the names used before it had four columns (as validate.py reads them).
    from validate import _stage as stage
    return stage(status)


def _last(p):
    return re.split(r"[\\/]", str(p or "").rstrip("\\/"))[-1]


def patches(report, board):
    """The staleness patches for the board's Draft cards, from the PC's staleness.json (BUG-8)."""
    out = {"patches": [], "problems": []}
    packs = [p for p in (report or {}).get("packs") or [] if isinstance(p, dict)]
    by_name = {}
    for p in packs:
        by_name.setdefault((p.get("folder") or _last(p.get("pack"))).lower(), []).append(p)
    checked = str((report or {}).get("checked") or "")
    for c in board or []:
        if not isinstance(c, dict):
            continue
        cid, d = c.get("id"), c.get("data") or {}
        if not d.get("pack") or _stage(d.get("status")) != "draft" or d.get("applied"):
            continue
        found = by_name.get(_last(d["pack"]).lower(), [])
        if len(found) > 1:
            out["problems"].append(f"{cid}: two packs are named {_last(d['pack'])!r}; its freshness was not set")
            continue
        if not found:
            continue
        p = found[0]
        level = p.get("level") if p.get("level") in ("fresh", "probably", "stale") else "probably"
        reasons = [str(x)[:120] for x in (p.get("reasons") or []) if isinstance(x, str)][:6]
        st = {"level": level, "reasons": reasons, "checked": checked}
        if d.get("staleness") == st:
            continue
        out["patches"].append({"cardId": cid, "patch": {"staleness": st}})
    return out


def record(root, paths, spec=None, settings_version=None, built=None):
    root = os.path.realpath(root)
    files = {}
    for key, rel in paths.items():
        rel = safe_rel(rel)
        full = os.path.realpath(os.path.join(root, *rel.split("\\")))
        if os.path.commonpath([root, full]) != root:
            raise ValueError(f"{key}: {rel} leads outside the root")
        if key in FOLDER_KEYS:
            if not os.path.isdir(full):
                raise ValueError(f"{key}: {rel} is not a folder")
            files[key] = {"path": rel, "kind": "folder", "hash": hash_folder(full)}
        else:
            if not os.path.isfile(full):
                raise ValueError(f"{key}: {rel} is not a file")
            files[key] = {"path": rel, "kind": "file", "hash": hash_file(full)}
    out = {"version": VERSION, "built": built or date.today().isoformat(),
           "settingsVersion": settings_version if isinstance(settings_version, int) else None, "files": files}
    if spec is not None:
        # Sprint 11 check: an advert that was not read well says nothing to compare later.
        if not isinstance(spec, dict) or spec.get("status") not in (None, "ok") or not spec.get("mustHaves"):
            raise ValueError("the spec was not read well (no requirements, or not ok): read the advert and use staleness.py facts")
        out["advert"] = advert_facts(spec)
        out["advert"]["hash"] = hash_bytes(json.dumps(out["advert"], sort_keys=True).encode("utf-8"))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--root", required=True, help="the Professional development folder, or its staged copy")
    for flag, key in (("--cv", "cvBase"), ("--letter", "letterBase"), ("--notes", "careerNotes"),
                      ("--highlights", "highlights"), ("--answers", "formAnswers")):
        r.add_argument(flag, required=True, dest=key)
    r.add_argument("--spec", help="the advert as read (the reader's spec JSON), for E13")
    r.add_argument("--settings-version", type=int)
    r.add_argument("--date")
    r.add_argument("--into", help="pack.json to add builtFrom to")
    fa = sub.add_parser("facts")
    fa.add_argument("facts")
    pt = sub.add_parser("patches")
    pt.add_argument("staleness")
    pt.add_argument("board")
    a2 = sub.add_parser("advert")
    a2.add_argument("pack")
    a2.add_argument("spec")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "record":
            paths = {k: getattr(a, k) for k in FILE_KEYS + FOLDER_KEYS}
            spec = None
            if a.spec:
                with open(a.spec, encoding="utf-8") as f:
                    spec = json.load(f)
            built_from = record(a.root, paths, spec, a.settings_version, a.date)
            if a.into:
                with open(a.into, encoding="utf-8") as f:
                    pack = json.load(f)
                pack["builtFrom"] = built_from
                with open(a.into, "w", encoding="utf-8") as f:
                    json.dump(pack, f, indent=1)
                    f.write("\n")
                print(f"builtFrom added to {a.into}")
            else:
                json.dump(built_from, sys.stdout, indent=1)
                print()
        elif a.cmd == "facts":
            with open(a.facts, encoding="utf-8") as f:
                json.dump(facts_to_spec(json.load(f)), sys.stdout, indent=1)
            print()
        elif a.cmd == "patches":
            with open(a.staleness, encoding="utf-8") as f:
                rep = json.load(f)
            with open(a.board, encoding="utf-8") as f:
                board = json.load(f)
            json.dump(patches(rep, board), sys.stdout, indent=1)
            print()
        else:
            with open(a.pack, encoding="utf-8") as f:
                pack = json.load(f)
            with open(a.spec, encoding="utf-8") as f:
                spec = json.load(f)
            facts = ((pack.get("builtFrom") or {}).get("advert")) if isinstance(pack, dict) else None
            json.dump(advert_change(facts, spec), sys.stdout, indent=1)
            print()
    except (OSError, ValueError) as e:
        print(f"staleness: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
