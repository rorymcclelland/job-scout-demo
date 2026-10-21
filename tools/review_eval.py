#!/usr/bin/env python3
"""Scores the reviewer's answer on one hand-check case (backlog H6, cases 9 to 16).

    python3 review_eval.py CASE_DIR [--vault VAULT_DIR]

CASE_DIR holds cv.md, letter.md, ats.json, expect.json and the reviewer's answer.json.
First the answer must pass validate.py claims; then each expected verdict must match
("fragment": "verdict" for a sentence, "ats:<term>": "covered" or "gap" for a term),
and unsupportedMax, when set, caps the unsupported lines. The cases live in the vault
(_context\\job-scout\\review-evals) because they hold the owner's own letter text.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from validate import _norm, check_claims, sentences  # noqa: E402


def score(case, vault_dir):
    def read(n):
        with open(os.path.join(case, n), encoding="utf-8") as f:
            return f.read()
    cv, letter = read("cv.md"), read("letter.md")
    ats, expect, answer = json.loads(read("ats.json")), json.loads(read("expect.json")), json.loads(read("answer.json"))
    vault = {}
    for root, _, files in os.walk(vault_dir):
        rel = os.path.relpath(root, vault_dir).replace(os.sep, "/")
        if not (rel.startswith("shared") or rel.startswith("career")):
            continue  # the record is shared\ and career\ only, as the reviewer is given
        for n in files:
            if n.endswith(".md"):
                with open(os.path.join(root, n), encoding="utf-8") as f:
                    vault[os.path.relpath(os.path.join(root, n), vault_dir).replace(os.sep, "/")] = f.read()
    problems = [f"check: {x}" for x in check_claims(answer, sentences(cv, letter), vault, ats, cv + "\n" + letter)]
    claims = answer.get("claims") or []
    for frag, verdict in (expect.get("expect") or {}).items():
        if frag.startswith("ats:"):
            term = frag[4:]
            got = [a.get("status") for a in answer.get("ats") or [] if a.get("term") == term]
            if got != [verdict]:
                problems.append(f"expected ATS term {term!r} to be {verdict}, got {got or 'nothing'}")
            continue
        got = [c.get("verdict") for c in claims if _norm(frag) in _norm(c.get("sentence"))]
        if verdict not in got:
            problems.append(f"expected {frag!r} to be {verdict}, got {got or 'no such sentence'}")
    cap = expect.get("unsupportedMax")
    n = sum(1 for c in claims if c.get("verdict") == "unsupported")
    if cap is not None and n > cap:
        problems.append(f"{n} unsupported lines, at most {cap} expected: " + "; ".join(c["sentence"][:60] for c in claims if c.get("verdict") == "unsupported"))
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("case")
    ap.add_argument("--vault", default=None, help="the _context folder holding shared\\ and career\\ (default: two levels above the case)")
    a = ap.parse_args(argv)
    vault = a.vault or os.path.abspath(os.path.join(a.case, "..", "..", ".."))
    problems = score(a.case, vault)
    for p in problems:
        print(p)
    print(("FAILED: " + str(len(problems)) + " problem(s)") if problems else f"OK: {os.path.basename(os.path.normpath(a.case))} passed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
