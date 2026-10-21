#!/usr/bin/env python3
"""The ATS match, part 1: the code (backlog E11, Sprint 5c). No AI.

Finds the advert's key terms and says, for each, whether the CV and letter
carry it: found, partly found, or missing. Gives one match figure, with
must-haves counted double, so a pack shows what an applicant-tracking system
would likely see. Same input, same output, every time.

    python3 ats_match.py ADVERT CV.md [LETTER.md] --bank ats-terms.md [--out ats.json] [--md coverage.md]

ADVERT is either the reader's spec (specs/<id>.json, from the advert's own
text, H5) or a pack's job-spec.md. A match made from a summary of the advert
(the cloud's fetch tool gives summaries) is labelled indicative.

What is matched:
  must-haves   the advert's requirements (the spec's mustHaves, or the
               "Requirements" line or section of job-spec.md), weight 2
  nice-to-haves its "nice to have" points, weight 1
  bank terms   terms from the term bank (_context\\job-scout\\ats-terms.md)
               that the advert uses, weight 1
Matching ignores case, plurals, hyphens and "&" versus "and", and treats a
bank term's aliases as the same term ("PM" and "product manager", "GTM" and
"go-to-market"). An item is found when 80% of its key words are in the CV or
letter, partly found from 40%, missing below that. Part 2 (E12, an AI step in
PACK.md) then judges the missing and partly-found items; this figure stays the
figure of record.
"""

import argparse
import json
import re
import sys

STOP = set("""the and for with you your our are have has who will can this that from into able ability strong
experience experienced years year proven track record including such other least plus must ideally preferably
demonstrable excellent good great working work skills skill knowledge background ideally across within their
them they its it's not more most well also both all any one two three four five six seven eight nine ten
about how what when where which while who whom why being been were was get set than then very via per
some own owned owning own end leadership ownership""".split())
SHORT = {"ai", "ml", "ux", "ui", "qa", "hr", "pr", "bi", "go"}

ABBREVIATIONS = {"pm": "product manager", "pms": "product managers", "vp": "vice president", "cpo": "chief product officer",
                 "cto": "chief technology officer", "ceo": "chief executive officer", "ux": "user experience"}


def singular(w):
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def normalise(text):
    t = text.lower().replace("&", " and ").replace("’", "'")
    t = re.sub(r"[-/_]", " ", t)
    t = re.sub(r"[^a-z0-9+#' ]+", " ", t)
    words = []
    for w in t.split():
        w = w.strip("'")
        words.extend(ABBREVIATIONS.get(w, w).split())
    return [singular(w) for w in words if w]


def key_words(text):
    return [w for w in normalise(text) if (len(w) >= 3 or w in SHORT) and w not in STOP and not w.isdigit()]


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_bank(path):
    bank = []
    for line in _read(path).splitlines():
        m = re.match(r"^\s*-\s*([^:]+):\s*(.*)$", line)
        if m:
            canonical = m.group(1).strip()
            aliases = [a.strip() for a in m.group(2).split(",") if a.strip()]
            bank.append((canonical, [canonical] + aliases))
    return bank


def contains(haystack_words, phrase):
    """Whole-phrase match on normalised words."""
    needle = normalise(phrase)
    if not needle:
        return False
    n = len(needle)
    return any(haystack_words[i:i + n] == needle for i in range(len(haystack_words) - n + 1))


def split_items(text):
    parts = re.split(r";|\n\s*[-*]\s+|\.\s+(?=[A-Z])", text)
    return [p.strip(" -*.\n") for p in parts if len(p.strip(" -*.\n")) > 2]


def advert_items(path):
    """(must-haves, nice-to-haves, full text, basis) from a spec or a job-spec.md."""
    raw = _read(path)
    if path.endswith(".json"):
        rec = json.loads(raw)
        spec = rec.get("spec") or rec
        text = json.dumps(spec)
        return list(spec.get("mustHaves", [])), list(spec.get("niceToHaves", [])), text, "full text"
    basis = "summary" if re.search(r"summary of the page|not the full text|close summary", raw, re.I) else "full text"
    must, nice = [], []
    for label, target in (("requirements?|must[- ]haves?|what we're looking for|about you|your background|minimum qualifications|qualifications", must),
                          ("nice to have|nice-to-have|preferred|desirable|bonus", nice)):
        for m in re.finditer(rf"^[>\s]*(?:\*\*)?(?:{label})(?:\*\*)?\s*:\s*(.+)$", raw, re.I | re.M):
            target.extend(split_items(m.group(1)))
        for m in re.finditer(rf"^#+\s*(?:{label})[^\n]*\n((?:\s*[-*].*\n?)+)", raw, re.I | re.M):
            target.extend(split_items(m.group(1)))
    return must, nice, raw, basis


def coverage(item, docs, bank):
    """Share of an item's key words found in each document, counting bank aliases as one term."""
    item_words = key_words(item)
    # Expand: a bank term named in the item is satisfied by any of its aliases in a document.
    groups = []
    used = set()
    item_norm = normalise(item)
    for canonical, aliases in bank:
        if any(contains(item_norm, a) for a in aliases):
            groups.append(aliases)
            for a in aliases:
                used.update(key_words(a))
    rest = [w for w in dict.fromkeys(item_words) if w not in used]
    total = len(rest) + len(groups)
    if total == 0:
        return 0.0, []
    best, where = 0.0, []
    found_any = {}
    for name, words in docs.items():
        ws = set(words)
        hits = sum(1 for w in rest if w in ws) + sum(1 for g in groups if any(contains(words, a) for a in g))
        found_any[name] = hits / total
    best = max(found_any.values()) if found_any else 0.0
    # Combined across CV and letter: a word in either counts.
    allw = [w for words in docs.values() for w in words]
    combined = (sum(1 for w in rest if w in set(allw)) + sum(1 for g in groups if any(contains(words, a) for words in docs.values() for a in g))) / total
    where = [n for n, share in found_any.items() if share > 0]
    return max(best, combined), where


def status_of(share):
    return "found" if share >= 0.8 else "partly found" if share >= 0.4 else "missing"


def match(advert_path, cv_path, letter_path, bank_path):
    must, nice, text, basis = advert_items(advert_path)
    bank = load_bank(bank_path)
    docs = {"CV": normalise(_read(cv_path))}
    if letter_path:
        docs["letter"] = normalise(_read(letter_path))
    advert_words = normalise(text)
    items = [(m, "must-have", 2) for m in must] + [(n, "nice-to-have", 1) for n in nice]
    named = " ".join(must + nice)
    terms = [c for c, aliases in bank if any(contains(advert_words, a) for a in aliases) and not any(contains(normalise(named), a) for a in aliases)]
    items += [(t, "term", 1) for t in terms]
    rows, got, out_of = [], 0.0, 0
    for item, kind, weight in items:
        share, where = coverage(item, docs, bank)
        st = status_of(share)
        got += weight * (1 if st == "found" else 0.5 if st == "partly found" else 0)
        out_of += weight
        rows.append({"item": item, "kind": kind, "weight": weight, "status": st, "share": round(share, 2), "where": where if st != "missing" else []})
    # Without the advert's own requirements, a figure from bank terms alone would flatter (Atlas IT, 14 Oct).
    figure = round(100 * got / out_of) if out_of and must else None
    return {"figure": figure, "basis": basis, "indicative": basis != "full text", "noRequirements": not must, "counts": {
        "found": sum(r["status"] == "found" for r in rows), "partly found": sum(r["status"] == "partly found" for r in rows),
        "missing": sum(r["status"] == "missing" for r in rows)}, "items": rows}


def markdown(result):
    head = f"## ATS match: {result['figure']}%" if result["figure"] is not None else "## ATS match: no figure (the advert as saved lists no requirements)"
    lines = [head + (" (indicative: matched against a summary of the advert)" if result["indicative"] and result["figure"] is not None else ""), "",
             f"{result['counts']['found']} found, {result['counts']['partly found']} partly found, {result['counts']['missing']} missing. Must-haves count double. Worked out by `tools\\ats_match.py`; no AI.", "",
             "| Advert asks for | Kind | In the pack | Where |", "| --- | --- | --- | --- |"]
    order = {"missing": 0, "partly found": 1, "found": 2}
    for r in sorted(result["items"], key=lambda r: (order[r["status"]], -r["weight"])):
        lines.append(f"| {r['item'].replace('|', '/')} | {r['kind']} | {r['status']} | {', '.join(r['where']) or 'none'} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="ATS match, part 1 (E11): the code.")
    ap.add_argument("advert")
    ap.add_argument("cv")
    ap.add_argument("letter", nargs="?")
    ap.add_argument("--bank", required=True)
    ap.add_argument("--out")
    ap.add_argument("--md")
    a = ap.parse_args(argv)
    result = match(a.advert, a.cv, a.letter, a.bank)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
    if a.md:
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(markdown(result))
    print(markdown(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
