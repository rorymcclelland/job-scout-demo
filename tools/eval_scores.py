#!/usr/bin/env python3
"""The evaluation set and its report (backlog H8, Sprint 7): has the scout's judgement moved?

    python3 eval_scores.py sheet  --runs data/runs --out EVAL_DIR [--keep data/keep.json] [--size 40] [--from 2026-10-14 --to 2026-10-18]
    python3 eval_scores.py report --eval EVAL_DIR --scores rescored.json --settings settings.json
                                  [--keep keep.json] [--reader reader-latest.json] [--replies replies-grade.json]
                                  [--review-evals REVIEW_EVALS_DIR --vault CONTEXT_DIR] [--today YYYY-MM-DD]
                                  [--set-baseline]

sheet   Writes the labelling sheet the owner marks (label-sheet.csv: apply, pass or
        unsure, with a word of reason) from roles already scored, each once, and
        freezes what the scorer saw for each one in inputs/<id>.json: the role
        record from the alert and the advert's text if one was read. Advert text
        is cleaned as in a live run (instruction-like lines removed and listed),
        and email addresses and phone numbers are removed (H10). The set then
        survives the 90-day retention, which never touches the vault.

report  Compares a fresh scoring of the inputs (by the scoring run, under the
        current rubric and settings: EVAL.md) with the owner's labels. A role scored
        at or above the threshold counts as "apply". Reports agreement, false
        positives and false negatives (a role he applied to first), the roles
        left out as unsure, and the change from the baseline; and, when given,
        the reader's field accuracy (npm run eval:reader), the reviewer's
        hand-checks and the reply grading. Drift is flagged (the owner, 17 Oct 2026)
        when agreement drops by more than 10 points from the baseline, or when
        there is any false negative the baseline did not have. Nothing changes
        automatically. Writes EVAL_DIR/latest.json and prints the report as
        Markdown; --set-baseline also saves latest.json as baseline.json.

Standard library only.
"""
import argparse
import csv
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from validate import INSTRUCTION_LIKE  # noqa: E402  (kept in step with src/untrusted.ts)

LABELS = ("apply", "pass", "unsure")
HEADER = ["id", "run", "title", "company", "location", "score then", "shortlisted then", "applied", "link",
          "your label (apply / pass / unsure)", "reason (optional)", "advert read (H18)"]


def has_advert(eval_dir, role_id):
    """H18: did the scorer have the advert's own text for this role? True, False, or None when its frozen input is not there."""
    path = os.path.join(eval_dir, "inputs", re.sub(r"[^A-Za-z0-9_-]+", "-", role_id) + ".json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return bool(json.load(f).get("advert"))
    except (OSError, ValueError):
        return None
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\w/.-])(?:\+|\(0|0)[\d\s().-]{8,}\d(?![\w/-])")
ROLE_FIELDS = ("id", "source", "title", "company", "location", "workplace", "pay", "url", "excerpt")
DRIFT_POINTS = 10


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean(text):
    """The advert as the scorer may see it: instruction-like lines out (H2), contacts out (H10)."""
    kept, removed = [], []
    for line in str(text or "").splitlines():
        why = next((w for w, p in INSTRUCTION_LIKE if p.search(line)), None)
        if why:
            removed.append({"why": why, "line": line.strip()[:200]})
            continue
        line = EMAIL.sub("[email removed]", line)
        line = PHONE.sub(lambda m: "[phone removed]" if 10 <= len(re.sub(r"\D", "", m.group(0))) <= 15 else m.group(0), line)
        kept.append(line)
    return "\n".join(kept), removed


def _applied(keep):
    return set((keep or {}).get("roles") or [])


def gather(runs, date_from=None, date_to=None):
    """Every scored role across the runs, the latest scoring of each, with its inputs."""
    out = {}
    for day in sorted(os.listdir(runs)):
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", day) or (date_from and day < date_from) or (date_to and day > date_to):
            continue
        folder = os.path.join(runs, day)
        sp = os.path.join(folder, "scores.json")
        if not os.path.exists(sp):
            continue
        cands = {}
        cp = os.path.join(folder, "candidates.json")
        if os.path.exists(cp):
            for c in load(cp):
                r = c.get("role") or {}
                cands[r.get("id")] = r
        for s in load(sp):
            rid = s.get("id")
            if not rid:
                continue
            advert = None
            for name in (f"{rid}.md", f"{re.sub(r'[^A-Za-z0-9_-]+', '-', rid)}.md"):
                ap = os.path.join(folder, "adverts", name)
                if os.path.exists(ap):
                    with open(ap, encoding="utf-8") as f:
                        advert = f.read()
                    break
            role = cands.get(rid) or {k: s.get(k) for k in ("title", "company", "location", "url")}
            out[rid] = {"id": rid, "run": day, "score": s.get("score"), "shortlisted": bool(s.get("shortlisted")),
                        "rubricVersion": s.get("rubricVersion"), "role": {k: role.get(k) for k in ROLE_FIELDS if k in role},
                        "title": s.get("title") or role.get("title") or "", "company": s.get("company") or role.get("company") or "",
                        "location": role.get("location") or s.get("location") or "", "url": s.get("url") or role.get("url") or "",
                        "advert": advert}
    return out


def pick(roles, size, applied, labelled=()):
    """Every role already labelled and every role he applied to, the top of the list
    (where decisions sit), then a spread of the rest."""
    ranked = sorted(roles.values(), key=lambda r: (-(r["score"] or 0), r["id"]))
    keep = set(applied) | set(labelled)
    chosen = [r for r in ranked if r["id"] in keep]
    rest = [r for r in ranked if r["id"] not in keep]
    top = max(0, min(len(rest), (size * 3) // 5 - len(chosen)))
    chosen += rest[:top]
    tail = rest[top:]
    need = max(0, size - len(chosen))
    if need and tail:
        step = len(tail) / need
        chosen += [tail[int(i * step)] for i in range(min(need, len(tail)))]
    seen, unique = set(), []
    for r in chosen:
        if r["id"] not in seen:
            seen.add(r["id"])
            unique.append(r)
    return sorted(unique, key=lambda r: (-(r["score"] or 0), r["id"]))


def make_sheet(runs, out, keep=None, size=40, date_from=None, date_to=None, add=10):
    """size: the sheet's length the first time; when refreshing, every labelled role stays and up to `add` new ones join."""
    applied = _applied(keep)
    sheet = os.path.join(out, "label-sheet.csv")
    old = read_labels(sheet) if os.path.exists(sheet) else {}
    labelled = [i for i, v in old.items() if v["label"]]
    gathered = gather(runs, date_from, date_to)
    target = size if not labelled else len([i for i in labelled if i in gathered]) + add
    roles = pick(gathered, target, applied, labelled)
    os.makedirs(os.path.join(out, "inputs"), exist_ok=True)
    rows = [HEADER]
    for r in roles:
        path = os.path.join(out, "inputs", re.sub(r"[^A-Za-z0-9_-]+", "-", r["id"]) + ".json")
        if os.path.exists(path):
            pass  # frozen: what the scorer saw first, even after the run folder's advert has gone
        else:
            text, removed = clean(r["advert"]) if r["advert"] else (None, [])
            role = {}
            for k, v in (r["role"] or {}).items():
                if isinstance(v, str) and k != "url":
                    v, gone = clean(v)
                    removed += gone
                role[k] = v
            rec = {"id": r["id"], "run": r["run"], "role": role, "advert": text, "removed": removed,
                   "scoredThen": {"score": r["score"], "shortlisted": r["shortlisted"], "rubricVersion": r["rubricVersion"]}}
            with open(path, "w", encoding="utf-8") as f:
                json.dump(rec, f, indent=1, ensure_ascii=False)
        mark = old.get(r["id"], {})
        adv = has_advert(out, r["id"])
        rows.append([r["id"], r["run"], r["title"], r["company"], r["location"], r["score"], "yes" if r["shortlisted"] else "no",
                     "yes" if r["id"] in applied else "", r["url"] or "", mark.get("label", ""), mark.get("reason", ""),
                     "" if adv is None else ("yes" if adv else "no")])
    # A labelled role no longer in the runs read this time (another date range, say) keeps its row and label.
    listed = {r[0] for r in rows[1:]}
    for i in labelled:
        if i not in listed:
            v = old[i]
            adv = has_advert(out, i)
            rows.append([i, v.get("run", ""), v.get("title", ""), v.get("company", ""), v.get("location", ""), v.get("score", ""), v.get("shortlisted", ""),
                         "yes" if i in applied or v.get("applied") else "", v.get("link", ""), v["label"], v.get("reason", ""),
                         "" if adv is None else ("yes" if adv else "no")])
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\r\n").writerows(rows)
    with open(os.path.join(out, "label-sheet.csv"), "w", encoding="utf-8-sig", newline="") as f:
        f.write(buf.getvalue())
    return {"rows": len(rows) - 1, "withAdvert": sum(1 for r in roles if r["advert"]), "kept": len(labelled)}


def read_labels(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        text = f.read()
    dialect = csv.excel
    if text.count(";") > text.count(","):  # Excel in some locales saves with ";"
        dialect = type("semi", (csv.excel,), {"delimiter": ";"})
    rows = list(csv.reader(io.StringIO(text), dialect))
    out = {}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        label = (r[9] if len(r) > 9 else "").strip().lower()
        cell = lambda n: r[n] if len(r) > n else ""  # noqa: E731
        out[r[0].strip()] = {"label": label, "reason": cell(10).strip(), "applied": cell(7).strip().lower() == "yes",
                             "run": cell(1), "title": cell(2), "company": cell(3), "location": cell(4), "score": cell(5),
                             "shortlisted": cell(6), "link": cell(8), "advert": cell(11).strip().lower()}
    return out


def agreement(labels, scores, threshold, applied=()):
    """labels: {id: {label, ...}}; scores: {id: score}. Returns the comparison."""
    problems = [f"{i}: label {v['label']!r} is not apply, pass or unsure" for i, v in labels.items() if v["label"] and v["label"] not in LABELS]
    marked = {i: v for i, v in labels.items() if v["label"] in ("apply", "pass")}
    unsure = sorted(i for i, v in labels.items() if v["label"] == "unsure")
    unmarked = sorted(i for i, v in labels.items() if not v["label"])
    missing = sorted(i for i in marked if i not in scores)
    fp, fn, right = [], [], 0
    for i, v in marked.items():
        if i not in scores:
            if v["label"] == "apply":
                fn.append(i)  # a role he would apply for that the scorer did not score at all is still missed
            continue
        says_apply = scores[i] >= threshold
        if says_apply == (v["label"] == "apply"):
            right += 1
        elif says_apply:
            fp.append(i)
        else:
            fn.append(i)
    applied = set(applied)
    fn.sort(key=lambda i: (i not in applied and not labels[i].get("applied"), -scores.get(i, -1)))
    fp.sort(key=lambda i: -scores.get(i, 0))
    of = right + len(fp) + len(fn)
    return {"right": right, "of": of, "agreement": round(100 * right / of, 1) if of else None,
            "apply": sum(1 for v in marked.values() if v["label"] == "apply"), "pass": sum(1 for v in marked.values() if v["label"] == "pass"),
            "falsePositives": fp, "falseNegatives": fn, "unsure": unsure, "unmarked": unmarked, "notScored": missing, "problems": problems}


def drift(latest, baseline):
    """The owner's rule (17 Oct 2026): more than 10 points down, or any new false negative."""
    s = latest.get("scoring") or {}
    marked = s.get("apply", 0) + s.get("pass", 0)
    if marked > 0 and len(s.get("notScored") or []) >= marked:
        return {"flag": True, "reasons": ["none of the labelled roles was in the fresh scores"], "change": None, "newFalseNegatives": []}
    if not baseline or baseline.get("scoring", {}).get("agreement") is None or latest["scoring"].get("agreement") is None:
        return {"flag": False, "reasons": [], "change": None}
    # H18: a baseline set before alert-only roles were kept apart measured a different set of roles. Do not compare
    # the two; set a new baseline (review, Sprint 8).
    if baseline.get("basis") != latest.get("basis"):
        return {"flag": False, "reasons": [], "change": None, "note": "the baseline predates H18 (all roles, not advert-read ones): set a new baseline"}
    change = round(latest["scoring"]["agreement"] - baseline["scoring"]["agreement"], 1)
    reasons = []
    if change < -DRIFT_POINTS:
        reasons.append(f"agreement fell {abs(change)} points, from {baseline['scoring']['agreement']}% to {latest['scoring']['agreement']}%")
    new_fn = sorted(set(latest["scoring"]["falseNegatives"]) - set(baseline["scoring"].get("falseNegatives") or []))
    if new_fn:
        reasons.append("new false negative" + ("s" if len(new_fn) > 1 else "") + ": " + ", ".join(new_fn))
    return {"flag": bool(reasons), "reasons": reasons, "change": change, "newFalseNegatives": new_fn}


def review_results(cases_dir, vault):
    import review_eval
    out = {"passed": 0, "of": 0, "failed": []}
    for name in sorted(os.listdir(cases_dir)):
        case = os.path.join(cases_dir, name)
        if not (os.path.isdir(case) and os.path.exists(os.path.join(case, "expect.json")) and os.path.exists(os.path.join(case, "answer.json"))):
            continue
        out["of"] += 1
        problems = review_eval.score(case, vault)
        if problems:
            out["failed"].append({"case": name, "problems": problems[:3]})
        else:
            out["passed"] += 1
    return out


def report(eval_dir, scores, settings, today, keep=None, reader=None, replies=None, review=None):
    threshold = ((settings or {}).get("scoring") or {}).get("threshold", 60)
    labels = read_labels(os.path.join(eval_dir, "label-sheet.csv"))
    by = {s["id"]: s["score"] for s in scores if isinstance(s, dict) and "id" in s and isinstance(s.get("score"), (int, float))}
    names = {i: f"{v['company']}, {v['title']}" for i, v in labels.items()}
    # H18: the headline figure, and drift, are judged only on roles scored from the advert's own text.
    # Roles scored from the alert alone are reported beside it, for information.
    adv = {i: has_advert(eval_dir, i) for i in labels}
    with_text = {i: v for i, v in labels.items() if adv[i] is not False}  # None (inputs missing) counted, and listed below
    alert_only = {i: v for i, v in labels.items() if adv[i] is False}
    unknown = sorted(i for i, v in labels.items() if adv[i] is None)
    latest = {"date": today, "basis": "advert-read", "inputsMissing": unknown, "threshold": threshold, "rubricVersion": (settings or {}).get("rubricVersion"),
              "scoring": agreement(with_text, by, threshold, _applied(keep)), "names": names,
              "alertOnly": agreement(alert_only, by, threshold, _applied(keep)) if alert_only else None}
    if reader:
        latest["reader"] = {k: reader.get(k) for k in ("date", "model", "digest", "right", "of", "rate", "passed", "wrong", "source")}
    if replies:
        latest["replies"] = {k: replies.get(k) for k in ("date", "model", "right", "of", "confusions", "passed")}
    if review:
        latest["reviewer"] = review
    bp = os.path.join(eval_dir, "baseline.json")
    baseline = load(bp) if os.path.exists(bp) else None
    latest["drift"] = drift(latest, baseline)
    latest["baselineDate"] = baseline.get("date") if baseline else None
    return latest


def markdown(latest):
    s, d = latest["scoring"], latest["drift"]
    nm = latest.get("names", {})
    who = lambda i: f"{nm.get(i, i)} ({i})"  # noqa: E731
    lines = [f"# Evaluation, {latest['date']}", ""]
    if d["flag"]:
        lines += ["**Drift flagged:** " + "; ".join(d["reasons"]) + ". Nothing has changed automatically: look before the next change goes live.", ""]
    agree = ("no labelled roles scored from the advert's text yet" if latest.get("alertOnly") else "no labelled roles yet") if s["agreement"] is None else f"{s['right']} of {s['of']} ({s['agreement']}%)"
    base = f", {'+' if (d['change'] or 0) >= 0 else ''}{d['change']} points on the baseline of {latest['baselineDate']}" if d.get("change") is not None else (", no baseline yet" if latest.get("baselineDate") is None else "")
    lines += ["## Scoring against your labels", "",
              f"Threshold {latest['threshold']}; rubric version {latest.get('rubricVersion')}. Agreement: {agree}{base}. Labelled apply: {s['apply']}; pass: {s['pass']}.", ""]
    ao = latest.get("alertOnly")
    if ao:
        ao_agree = "none labelled" if ao["agreement"] is None else f"{ao['right']} of {ao['of']} ({ao['agreement']}%)"
        lines += [f"Scored from the alert alone (shown for information; not used for the headline or drift, H18): {ao_agree}.", ""]
    if d.get("note"):
        lines += [f"No drift comparison: {d['note']}.", ""]
    if latest.get("inputsMissing"):
        lines += [f"Counted, but their frozen inputs are missing, so it is not known whether the advert was read: {', '.join(who(i) for i in latest['inputsMissing'])}.", ""]
    if s["falseNegatives"]:
        lines += ["**False negatives** (you would apply; scored below the line):", ""] + [f"- {who(i)}" for i in s["falseNegatives"]] + [""]
    if s["falsePositives"]:
        lines += ["**False positives** (you would pass; scored at or above the line):", ""] + [f"- {who(i)}" for i in s["falsePositives"]] + [""]
    if s["unsure"]:
        lines += [f"Left out as unsure: {', '.join(s['unsure'])}.", ""]
    if s["unmarked"]:
        lines += [f"Not yet labelled: {len(s['unmarked'])}.", ""]
    for p in s["problems"] + [f"{i}: labelled but not in the fresh scores" for i in s["notScored"]]:
        lines.append(f"- Problem: {p}")
    r = latest.get("reader")
    lines += ["## The other checks", ""]
    lines.append(f"- Reader (npm run eval:reader, {r['date']}): {r['model']}{' digest ' + r['digest'][:12] if r.get('digest') else ''}, {r['right']} of {r['of']} right ({r['rate']}%), {'passes' if r['passed'] else 'below'} the 9 in 10 bar." if r else "- Reader: not run yet (npm run eval:reader on the PC).")
    v = latest.get("reviewer")
    lines.append(f"- Reviewer hand-checks: {v['passed']} of {v['of']} cases pass." + (" Failed: " + ", ".join(f['case'] for f in v['failed']) + "." if v['failed'] else "") if v else "- Reviewer hand-checks: not re-run.")
    q = latest.get("replies")
    lines.append(f"- Reply reader grading ({q['date']}): {q['right']} of {q['of']} right, {q['confusions']} rejection and invitation mix-ups: {'passed' if q['passed'] else 'not passed'}." if q else "- Reply reader: not graded yet (npm run grade-replies).")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sh = sub.add_parser("sheet")
    sh.add_argument("--runs", required=True)
    sh.add_argument("--out", required=True)
    sh.add_argument("--keep")
    sh.add_argument("--size", type=int, default=40)
    sh.add_argument("--add", type=int, default=10, help="when refreshing: new roles to add beside those labelled")
    sh.add_argument("--from", dest="date_from")
    sh.add_argument("--to", dest="date_to")
    rp = sub.add_parser("report")
    rp.add_argument("--eval", required=True)
    rp.add_argument("--scores", required=True)
    rp.add_argument("--settings")
    rp.add_argument("--keep")
    rp.add_argument("--reader")
    rp.add_argument("--replies")
    rp.add_argument("--review-evals")
    rp.add_argument("--vault")
    rp.add_argument("--today", required=True)
    rp.add_argument("--set-baseline", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "sheet":
        r = make_sheet(a.runs, a.out, load(a.keep) if a.keep and os.path.exists(a.keep) else None, a.size, a.date_from, a.date_to, a.add)
        print(f"Labelling sheet: {r['rows']} roles ({r['withAdvert']} with the advert's text), in {os.path.join(a.out, 'label-sheet.csv')}." + (f" {r['kept']} earlier labels carried over." if r["kept"] else ""))
        print("Mark each one apply, pass or unsure in the last-but-one column, add a word of reason where it helps, and save it as CSV.")
        return 0
    review = review_results(a.review_evals, a.vault or os.path.abspath(os.path.join(a.review_evals, "..", ".."))) if a.review_evals else None
    latest = report(a.eval, load(a.scores), load(a.settings) if a.settings else None, a.today,
                    load(a.keep) if a.keep else None, load(a.reader) if a.reader else None, load(a.replies) if a.replies else None, review)
    with open(os.path.join(a.eval, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, indent=1, ensure_ascii=False)
    if a.set_baseline:
        with open(os.path.join(a.eval, "baseline.json"), "w", encoding="utf-8") as f:
            json.dump(latest, f, indent=1, ensure_ascii=False)
    sys.stdout.write(markdown(latest))
    return 1 if latest["drift"]["flag"] else 0


if __name__ == "__main__":
    sys.exit(main())
