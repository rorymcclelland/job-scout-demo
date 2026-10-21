#!/usr/bin/env python3
"""Checks what the AI wrote before it is saved (backlog H3).

The Claude half of a run writes files and board cards from its own judgement.
This script checks each one against a fixed shape and a few rules of arithmetic
and honesty before it is written anywhere, so a malformed or manipulated output
is stopped rather than delivered. It needs only the Python standard library.

    python3 validate.py scores    scores.json    --settings settings.json
    python3 validate.py carryover carryover.json --settings settings.json
    python3 validate.py card      card.json      [--existing board.json]
    python3 validate.py pack      pack.json
    python3 validate.py urls      advert-urls.json --settings settings.json [--candidates candidates.json]
    python3 validate.py jobspec   specs/linkedin-123.json
    python3 validate.py sentences CV.md --letter LETTER.md
    python3 validate.py claims    claims.json --cv CV.md --letter LETTER.md --ats ats.json --vault VAULT_DIR [--before before.json --pack PACK_DIR]
    python3 validate.py hashes    PACK_DIR CV.md LETTER.md > before.json
    python3 validate.py disclosure PACK_DIR/form-answers.md --bank VAULT/job-scout/form-answers.md

Exit code 0 means it passed. Anything else prints one line per problem; the
procedures put those lines in the digest's Problems and write nothing.

What it checks:
  scores     every field present and typed; criteria are the eight in the
             rubric, each with points between 0 and its weight and a rationale;
             the points add up to the score; the rubric version matches the
             settings; shortlisted roles are at or above the threshold and no
             more than the daily cap; nothing scored below the line is shortlisted.
             Target employers (B13): up to targets.extraPlaces (2) target roles
             may be shortlisted beyond the cap, and a target role below the line
             only when targets.packBelowLine is on.
  carryover  each entry at or above the threshold and carried no more than the
             limit allows.
  card       a new Draft card only: id starts scout-, status draft, source scout,
             and no field outside the list in PACK.md (so a card can never be
             made Applied, or carry anything else, by the AI). H10: no email
             address or phone number in any field (contacts never go on a card).
  pack       pack.json lists its files and every check passed.
  urls       (H5a) the morning run's list of advert addresses: https only,
             never LinkedIn, ids unique and among the candidates, no more
             than control.advertsPerRun.
  jobspec    (H5b) a spec written by the reader on the PC: its shape, its
             status, and no instruction-like text outside injectionLines.
  claims     (H6) the reviewer's claims file: every sentence of the CV
             Summary, highlights and letter judged exactly once; a verdict
             from the four; supported and compressed verdicts quote a vault
             file, and the quote is really in it; unsupported and hedged ones
             give a reason; every missing or partly found ATS term judged once,
             and a "covered" line is really in the CV or letter; at most one
             revision round. With --before, the pack files must be unchanged.
  sentences  (H6) prints the sentences the reviewer must judge, as JSON, so
             the reviewer and the check split the text the same way.
  disclosure (H11) a pack's form answers carry the approved answer to "did
             you use AI?" from the bank, word for word.
All kinds: no em dashes, and no instruction-like text (the same patterns the
code removes from alerts) in any text the AI wrote.
"""

import argparse
import json
import os
import re
import sys

CRITERIA = ["scope", "proof", "ai", "mustHaves", "odds", "engagement", "company", "pay"]
DEFAULT_WEIGHTS = {"scope": 20, "proof": 25, "ai": 10, "mustHaves": 15, "odds": 10, "engagement": 10, "company": 5, "pay": 5}
# The rubric's names ("Scope and level", "AI and agentic alignment", ...) or the
# settings' keys are both accepted: the first word decides.
CRITERION_WORDS = {"scope": "scope", "proof": "proof", "ai": "ai", "must": "mustHaves", "musthaves": "mustHaves",
                   "odds": "odds", "engagement": "engagement", "company": "company", "pay": "pay"}

SCORE_FIELDS = {
    "id": str, "title": str, "company": str, "url": (str, type(None)), "site": str, "score": (int, float),
    "criteria": list, "gaps": list, "warnings": list, "alerted": (str, type(None)), "posted": (str, type(None)),
    "applicants": (int, str, type(None)), "carried": (dict, type(None)), "shortlisted": bool,
    "advert": (str, type(None)), "rubricVersion": (int, str),
}
# Optional score fields: checked when present.
SCORE_OPTIONAL = {"target": (str, type(None)), "ledger": str, "band": (str, type(None))}
# The project folder may have any name (a clone is "job-scout-demo", say); either slash.
DEMO_PACK = re.compile(r"^[^\\/:*?\"<>|]+[\\/]data[\\/]demo[\\/]\d{4}-\d{2}-\d{2}[\\/]packs[\\/][^\\/:*?\"<>|]+$")
LEDGER_ID = re.compile(r"^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9-]*\.\d+$")
SITES = ("linkedin", "hackajob", "google", "microsoft", "request")
REQUEST_ID = re.compile(r"^request:[a-z0-9][a-z0-9-]{0,60}$")
CARD_FIELDS = {
    # Board fields (PACK.md, "Board card").
    "company", "role", "status", "link", "blurb", "next", "notes", "log",
    # Scout fields.
    "source", "scoutId", "score", "rubricVersion", "runDate", "pack", "site", "alerted", "posted",
    "applicants", "warnings", "cvFormat", "target", "ledger", "atsMatch", "reviewFlags",
}
CARD_REQUIRED = {"company", "role", "status", "source", "scoutId", "score", "rubricVersion", "runDate", "site"}
PACK_FIELDS = {"id", "company", "role", "score", "built", "files", "checks"}
# H7: from 0.7.0 every output names the ledger entry that produced it.

# Kept in step with src/untrusted.ts. Text the AI wrote should never look like this:
# if it does, something it read has got into its output.
INSTRUCTION_LIKE = [
    ("tries to override instructions", re.compile(r"\b(ignore|disregard|forget|override|bypass)\b.{0,60}\b(instruction|instructions|prompt|rules?|previous|above|guidelines|system)\b", re.I)),
    ("addresses an AI system", re.compile(r"\b(system|developer)\s*(prompt|message)\b|^\s*(system|assistant|developer)\s*:", re.I | re.M)),
    ("addresses an AI system", re.compile(r"\b(dear|hey|hi|attention|note to( the)?)\s+(ai|assistant|claude|chatgpt|gpt|gemini|model|llm|bot)\b|\b(ai|llm|model|assistant|bot|agent)s?\s+(reading|reviewing|screening|processing|scoring|parsing)\s+this\b", re.I)),
    ("asks for data to be sent", re.compile(r"\b(send|email|forward|share|upload|paste|copy)\b.{0,50}\b(password|passcode|credentials|api key|token|personal (data|details)|home address|bank|candidate profile|career (notes|vault))\b.{0,60}(@|https?://|\bto\b)", re.I)),
    ("contains prompt markup", re.compile(r"<\|[^|]*\|>|\[/?INST\]|<</?SYS>>|BEGIN (PROMPT|INSTRUCTIONS)", re.I)),
]


def texts(value, path="$"):
    """Every string in a JSON value, with where it was found."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from texts(v, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from texts(v, f"{path}.{k}")


def text_problems(value, label):
    out = []
    for where, s in texts(value):
        if "—" in s:
            out.append(f"{label}{where}: contains an em dash")
        for why, pattern in INSTRUCTION_LIKE:
            if pattern.search(s):
                out.append(f"{label}{where}: instruction-like text ({why}): {s.strip()[:100]!r}")
                break
    return out


def settings_numbers(settings):
    s = settings or {}
    scoring = s.get("scoring", {})
    weights = dict(DEFAULT_WEIGHTS)
    weights.update(scoring.get("weights", {}) or {})
    return {
        "weights": weights,
        "threshold": scoring.get("threshold") if isinstance(scoring.get("threshold"), (int, float)) and not isinstance(scoring.get("threshold"), bool) else 60,
        "dailyCap": scoring.get("dailyCap", 5),
        "carryOverMax": scoring.get("carryOverMax", 2),
        "rubricVersion": s.get("rubricVersion"),
        "extraPlaces": (s.get("targets") or {}).get("extraPlaces", 2),
        "packBelowLine": (s.get("targets") or {}).get("packBelowLine", False) is True,
        "lookBand": look_band(scoring),
    }


def look_band(scoring):
    """C9 (Sprint 8): the "worth a look" band runs from lookBand up to the threshold. Off when lookBand is at or above
    the threshold; a value outside 0 to 100, or not a number, is ignored and the default of 55 stands."""
    v = scoring.get("lookBand", 55)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 100:
        v = 55
    t = scoring.get("threshold", 60)
    if not isinstance(t, (int, float)) or isinstance(t, bool):
        t = 60
    return v if v < t else None


def criterion_key(name):
    words = re.findall(r"[a-z]+", str(name).lower())
    return CRITERION_WORDS.get(words[0]) if words else None


def check_scores(data, settings):
    p = []
    if not isinstance(data, list):
        return ["scores.json: must be a list of scored roles"]
    nums = settings_numbers(settings)
    ids = set()
    shortlisted = 0
    targets_shortlisted = 0
    for i, r in enumerate(data):
        label = f"scores[{i}]"
        if not isinstance(r, dict):
            p.append(f"{label}: must be an object")
            continue
        label = f"scores[{i}] ({r.get('company', '?')}, {r.get('title', '?')})"
        for field, kind in SCORE_FIELDS.items():
            if field not in r:
                p.append(f"{label}: missing {field}")
            elif not isinstance(r[field], kind) or (kind is not bool and isinstance(r[field], bool) and field != "shortlisted"):
                p.append(f"{label}: {field} has the wrong type")
        for field, kind in SCORE_OPTIONAL.items():
            if field in r and not isinstance(r[field], kind):
                p.append(f"{label}: {field} has the wrong type")
        if "ledger" in r and not LEDGER_ID.match(str(r["ledger"])):
            p.append(f"{label}: ledger must be a ledger entry id such as 2026-10-17.orchestrator.1")
        if r.get("id") in ids:
            p.append(f"{label}: id {r.get('id')} appears twice")
        ids.add(r.get("id"))
        if r.get("site") not in SITES:
            p.append(f"{label}: site must be one of {', '.join(SITES)}")
        if (r.get("site") == "request") != bool(REQUEST_ID.match(str(r.get("id", "")))):
            p.append(f"{label}: a role scored on request has site request and an id request:<slug>, and only it (H15)")
        if r.get("url") and not re.match(r"^https://", str(r["url"])):
            p.append(f"{label}: url must start https://")
        score = r.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool) and not 0 <= score <= 100:
            p.append(f"{label}: score {score} is outside 0 to 100")
        if nums["rubricVersion"] is not None and str(r.get("rubricVersion")) != str(nums["rubricVersion"]):
            p.append(f"{label}: rubricVersion {r.get('rubricVersion')} does not match the settings ({nums['rubricVersion']})")

        crit = r.get("criteria")
        if isinstance(crit, list):
            seen, total = set(), 0
            for c in crit:
                if not isinstance(c, dict):
                    p.append(f"{label}: each criterion must be an object")
                    continue
                key = criterion_key(c.get("name"))
                if key is None:
                    p.append(f"{label}: unknown criterion {c.get('name')!r}")
                    continue
                if key in seen:
                    p.append(f"{label}: criterion {key} appears twice")
                seen.add(key)
                pts = c.get("points")
                if not isinstance(pts, (int, float)) or isinstance(pts, bool):
                    p.append(f"{label}: {key} has no points")
                    continue
                total += pts
                if not 0 <= pts <= nums["weights"][key]:
                    p.append(f"{label}: {key} scored {pts}, outside 0 to its weight {nums['weights'][key]}")
                if "max" in c and c["max"] != nums["weights"][key]:
                    p.append(f"{label}: {key} is marked out of {c['max']}, but its weight in the settings is {nums['weights'][key]}")
                if not str(c.get("rationale", "")).strip():
                    p.append(f"{label}: {key} has no rationale")
            missing = [k for k in CRITERIA if k not in seen]
            if missing:
                p.append(f"{label}: criteria missing: {', '.join(missing)}")
            if isinstance(score, (int, float)) and abs(total - score) > 0.5:
                p.append(f"{label}: criteria add up to {total:g}, not the score {score:g}")

        band = nums["lookBand"]
        in_band = band is not None and isinstance(score, (int, float)) and band <= score < nums["threshold"]
        if r.get("band") not in (None, "look"):
            p.append(f"{label}: band must be look or absent")
        elif r.get("band") == "look" and not in_band:
            p.append(f"{label}: marked worth a look, but {score} is outside the band {band} to {nums['threshold']} (C9)")
        elif in_band and r.get("band") != "look" and r.get("shortlisted") is not True:
            p.append(f"{label}: {score:g} is in the worth-a-look band ({band} to {nums['threshold']}): mark it band look (C9)")
        if r.get("shortlisted") is True:
            shortlisted += 1
            target = bool(r.get("target"))
            targets_shortlisted += target
            if isinstance(score, (int, float)) and score < nums["threshold"] and not (target and nums["packBelowLine"]):
                why = " (packing target roles below the line is off)" if target else ""
                p.append(f"{label}: shortlisted with {score:g}, below the threshold {nums['threshold']}{why}")
    extra = min(nums["extraPlaces"], targets_shortlisted)
    requests = [r for r in data if isinstance(r, dict) and r.get("site") == "request"]
    if requests:
        if len(data) != 1:
            p.append("scores.json: a run on request scores exactly one role (H15)")
    elif shortlisted > nums["dailyCap"] + extra:
        plus = f", plus {extra} extra for target employers" if extra else ""
        p.append(f"scores.json: {shortlisted} roles shortlisted, more than the daily cap of {nums['dailyCap']}{plus}")
    p += text_problems(data, "scores")
    return p


def check_carryover(data, settings):
    p = []
    if not isinstance(data, list):
        return ["carryover.json: must be a list (an empty list is fine)"]
    nums = settings_numbers(settings)
    for i, c in enumerate(data):
        label = f"carryover[{i}]"
        if not isinstance(c, dict):
            p.append(f"{label}: must be an object")
            continue
        for field in ("role", "score", "runDate", "carries"):
            if field not in c:
                p.append(f"{label}: missing {field}")
        if not isinstance(c.get("role"), dict) or not c.get("role", {}).get("id"):
            p.append(f"{label}: role must be the candidate's role record, with its id")
        score = c.get("score")
        if isinstance(score, (int, float)) and score < nums["threshold"]:
            p.append(f"{label}: score {score} is below the threshold {nums['threshold']}, so it cannot carry over")
        carries = c.get("carries")
        if not isinstance(carries, int) or isinstance(carries, bool) or not 0 <= carries < nums["carryOverMax"]:
            p.append(f"{label}: carries must be a whole number from 0 to {nums['carryOverMax'] - 1}")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(c.get("runDate", ""))):
            p.append(f"{label}: runDate must be YYYY-MM-DD")
    return p


def check_card(card, existing, demo=False):
    p = []
    if not isinstance(card, dict):
        return ["card: must be an object { id, data } or the card's data"]
    doc_id = card.get("id")
    data = card.get("data", card) if "data" in card else card
    if doc_id is not None and not re.match(r"^scout-[a-z0-9-]+$", str(doc_id)):
        p.append(f"card: id {doc_id!r} must be scout- followed by lower-case letters, digits and hyphens")
    extra = sorted(set(data) - CARD_FIELDS)
    if extra:
        p.append(f"card: fields not allowed on a scout card: {', '.join(extra)}")
    missing = sorted(CARD_REQUIRED - set(data))
    if missing:
        p.append(f"card: missing {', '.join(missing)}")
    if data.get("status") != "draft":
        p.append(f"card: status must be draft (it is {data.get('status')!r}); only the owner moves cards")
    if data.get("source") != "scout":
        p.append("card: source must be scout")
    if data.get("ledger") is not None and not LEDGER_ID.match(str(data["ledger"])):
        p.append("card: ledger must be a ledger entry id such as 2026-10-17.writer.1")
    ats = data.get("atsMatch")
    if ats is not None and (not isinstance(ats, int) or isinstance(ats, bool) or not 0 <= ats <= 100):
        p.append("card: atsMatch must be a whole number from 0 to 100, the figure from tools\\ats_match.py")
    flags = data.get("reviewFlags")
    if flags is not None and (not isinstance(flags, int) or isinstance(flags, bool) or flags < 0):
        p.append("card: reviewFlags must be a whole number, 0 or more: the lines the reviewer left for sign-off (H6)")
    if data.get("target") is not None and not isinstance(data.get("target"), str):
        p.append("card: target must be the employer's name")
    if data.get("cvFormat") not in (None, "two-page"):
        p.append("card: cvFormat must be two-page")
    if data.get("link") and not str(data["link"]).startswith("https://"):
        p.append("card: link must start https://")
    pack = str(data.get("pack") or "")
    # BUG-7 (Sprint 9): a demo card's pack lives in the demo's own folder; only a demo run may name it.
    demo_pack = bool(DEMO_PACK.match(pack)) and ".." not in re.split(r"[\\/]", pack)
    if pack and not (pack.startswith("Professional development\\") and ".." not in pack.split("\\")) and not (demo and demo_pack):
        p.append("card: pack must be a folder under Professional development\\" + (" (or, for the demo, <project folder>\\data\\demo\\<date>\\packs\\)" if demo else ""))
    if existing:
        taken = {e.get("data", {}).get("scoutId") for e in existing if isinstance(e, dict)}
        ids = {e.get("id") for e in existing if isinstance(e, dict)}
        if data.get("scoutId") in taken or (doc_id and doc_id in ids):
            p.append("card: a card for this role is already on the board; skip it")
    p += contact_problems(data, "card")
    p += text_problems(data, "card")
    return p


# H10 (Sprint 7): a card never carries a contact's email address or phone number.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\w/.-])(?:\+|\(0|0)[\d\s().-]{8,}\d(?![\w/-])")
# Fields that hold ids, dates or addresses made by the code, never contacts.
CONTACT_SKIP = {"scoutId", "link", "ledger", "runDate", "pack", "alerted", "posted", "rubricVersion", "site", "source", "status"}


def contact_problems(data, label):
    out = []
    for key, value in (data.items() if isinstance(data, dict) else []):
        if key in CONTACT_SKIP:
            continue
        for where, s in texts(value, f".{key}"):
            if EMAIL.search(s):
                out.append(f"{label}{where}: contains an email address; contacts never go on a card (H10)")
            for m in PHONE.finditer(s):
                digits = re.sub(r"\D", "", m.group(0))
                if 10 <= len(digits) <= 15:
                    out.append(f"{label}{where}: contains a phone number; contacts never go on a card (H10)")
                    break
    return out


# H11 (Sprint 7): the approved answer to "did you use AI?".
DISCLOSURE_LINE = re.compile(r"\*\*Use of AI[^*]*\*\*[^\n]*?\(approved[^)]*\)\*?:\s*[\"“]([^\"”]+)[\"”]")


def _flat(t):
    t = str(t).replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return " ".join(t.split())


def approved_disclosure(bank_md):
    m = DISCLOSURE_LINE.search(bank_md or "")
    return m.group(1).strip() if m else None


def check_disclosure(pack_md, bank_md):
    wording = approved_disclosure(bank_md)
    if not wording:
        return ["disclosure: the bank has no approved \"Use of AI\" answer; the owner approves one in form-answers.md first (H11)"]
    if _flat(wording) in _flat(pack_md):
        return []
    if re.search(r"\bAI\b|artificial intelligence", pack_md or "", re.I):
        return [f"disclosure: the pack answers the AI question in other words; use the approved line exactly: \"{wording}\""]
    return [f"disclosure: the pack's form answers do not include the approved answer on AI use: \"{wording}\""]


def check_pack(data):
    p = []
    if not isinstance(data, dict):
        return ["pack.json: must be an object"]
    missing = sorted(PACK_FIELDS - set(data))
    if missing:
        p.append(f"pack.json: missing {', '.join(missing)}")
    if "ledger" in data and not LEDGER_ID.match(str(data["ledger"])):
        p.append("pack.json: ledger must be a ledger entry id such as 2026-10-17.writer.1")
    files = data.get("files")
    if not isinstance(files, list) or not files:
        p.append("pack.json: files must list the pack's files")
    else:
        names = " ".join(map(str, files)).lower()
        for need in ("job-spec.md", "fit-and-gap-analysis.md", "form-answers.md", "cv", "letter"):
            if need not in names:
                p.append(f"pack.json: files do not include {need}")
    checks = data.get("checks")
    names_done = set(checks) if isinstance(checks, dict) else {str(c.get("name")) for c in checks if isinstance(c, dict)} if isinstance(checks, list) else set()
    if checks is not None and "disclosure" not in names_done:
        p.append("pack.json: checks must include disclosure: run validate.py disclosure on the pack's form answers (H11)")
    if isinstance(checks, dict):
        failed = [k for k, v in checks.items() if v not in (True, "pass", "passed", "ok")]
        if failed:
            p.append(f"pack.json: checks not passed: {', '.join(failed)}")
    elif isinstance(checks, list):
        failed = [str(c.get("name", c)) for c in checks if isinstance(c, dict) and c.get("ok") is not True]
        if failed:
            p.append(f"pack.json: checks not passed: {', '.join(failed)}")
    else:
        p.append("pack.json: checks must record the build checks")
    p += text_problems(data, "pack")
    return p


URL_ENTRY = {"id", "url", "foundBy", "provisional"}
SPEC_STATUS = ("ok", "unreliable", "not-readable", "closed", "failed")


# B16 (Sprint 5d): where an address came from, employer first.
FOUND_BY = ("careers page", "job board", "aggregator", "alert")


def check_urls(data, settings, candidates=None):
    p = []
    if not isinstance(data, list):
        return ["advert-urls.json: must be a list (an empty list is fine)"]
    cap = ((settings or {}).get("control") or {}).get("advertsPerRun", 20)
    if len(data) > cap:
        p.append(f"advert-urls.json: {len(data)} addresses, more than the {cap} adverts allowed a run")
    known = {c.get("role", {}).get("id") for c in candidates or [] if isinstance(c, dict)} if candidates is not None else None
    ids = set()
    for i, e in enumerate(data):
        label = f"urls[{i}]"
        if not isinstance(e, dict):
            p.append(f"{label}: must be an object")
            continue
        missing = sorted({"id", "url"} - set(e))
        if missing:
            p.append(f"{label}: missing {', '.join(missing)}")
        extra = sorted(set(e) - URL_ENTRY)
        if extra:
            p.append(f"{label}: fields not allowed: {', '.join(extra)}")
        if e.get("foundBy") not in FOUND_BY:
            p.append(f"{label}: foundBy must be one of {', '.join(FOUND_BY)} (B16)")
        url = str(e.get("url", ""))
        if not url.startswith("https://"):
            p.append(f"{label}: url must start https://")
        if re.search(r"(^|[/.])linkedin\.com", url, re.I):
            p.append(f"{label}: LinkedIn pages are never fetched")
        if e.get("id") in ids:
            p.append(f"{label}: id {e.get('id')} appears twice")
        ids.add(e.get("id"))
        if known is not None and e.get("id") not in known:
            p.append(f"{label}: id {e.get('id')} is not among today's candidates")
    p += text_problems(data, "urls")
    return p


def check_jobspec(rec):
    p = []
    if not isinstance(rec, dict):
        return ["jobspec: must be an object"]
    for f in ("id", "url", "status", "spec", "grounding"):
        if f not in rec:
            p.append(f"jobspec: missing {f}")
    if rec.get("status") not in SPEC_STATUS:
        p.append(f"jobspec: status must be one of {', '.join(SPEC_STATUS)}")
    if re.search(r"linkedin\.com", str(rec.get("url", "")), re.I):
        p.append("jobspec: came from a LinkedIn page, which is never fetched")
    spec = rec.get("spec")
    if rec.get("status") in ("ok", "unreliable"):
        if not isinstance(spec, dict):
            p.append("jobspec: a read advert must carry its spec")
        else:
            for f in ("mustHaves", "niceToHaves", "responsibilities", "injectionLines"):
                v = spec.get(f)
                if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                    p.append(f"jobspec: spec.{f} must be a list of text")
            if not isinstance(spec.get("suspectedInjection"), bool):
                p.append("jobspec: spec.suspectedInjection must be true or false")
            pay = spec.get("pay")
            if pay is not None and (not isinstance(pay, dict) or not {"min", "max", "currency", "period", "asWritten"} <= set(pay)):
                p.append("jobspec: spec.pay must be null or have min, max, currency, period and asWritten")
            # The advert's own words may contain dashes; instruction-like text anywhere but
            # injectionLines means something the advert said got into the facts.
            checked = {k: v for k, v in spec.items() if k != "injectionLines"}
            for where, s in texts(checked, "spec"):
                for why, pattern in INSTRUCTION_LIKE:
                    if pattern.search(s):
                        p.append(f"jobspec: {where}: instruction-like text ({why}): {s.strip()[:100]!r}")
                        break
    elif spec is not None:
        p.append("jobspec: an advert that was not read must not carry a spec")
    return p



# ---------------------------------------------------------------- H6, the reviewer
VERDICTS = ("supported", "compressed", "unsupported", "hedged", "no-claim")
SIGN_OFF_ENDS = re.compile(r"^\s*(kind regards|best regards|regards|yours sincerely|yours faithfully|many thanks|best wishes)\b", re.I)
SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"\u201c(])")


def _split(text):
    text = re.sub(r"\s+", " ", text).strip()
    return [x.strip() for x in SENTENCE_END.split(text) if x.strip()] if text else []


def _section(md, heading):
    m = re.search(r"^##\s+" + re.escape(heading) + r"\s*$(.*?)(?=^##\s|\Z)", md, re.M | re.S | re.I)
    return m.group(1) if m else ""


def sentences(cv_md, letter_md):
    """The sentences the reviewer judges: the CV's Summary and Selected Highlights, and the letter's body.
    Experience, titles, dates and employers never change, so they are not reviewed."""
    out = []
    for para in re.split(r"\n\s*\n", _section(cv_md, "Summary")):
        out += [{"where": "summary", "sentence": x} for x in _split(para)]
    bullets = [b for b in re.findall(r"^\s*[-*]\s+(.+)$", _section(cv_md, "Selected Highlights"), re.M)]
    for n, b in enumerate(bullets, 1):
        out += [{"where": f"highlight-{n}", "sentence": x} for x in _split(b)]
    lines = letter_md.splitlines()
    start = next((i + 1 for i, l in enumerate(lines) if re.match(r"^\s*dear\b", l, re.I)), 0)
    body = []
    for l in lines[start:]:
        if SIGN_OFF_ENDS.match(l):
            break
        body.append(l)
    for para in re.split(r"\n\s*\n", "\n".join(body)):
        out += [{"where": "letter", "sentence": x} for x in _split(para)]
    return out


def _norm(t):
    import html
    t = html.unescape(t or "")
    t = t.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    t = re.sub(r"[*_`#>]", "", t)
    return re.sub(r"\s+", " ", t).strip().lower()


def check_claims(data, sents, vault, ats, pack_text):
    """vault: {relative path: text}; ats: the pack's ats.json; pack_text: the CV and letter as built."""
    p = []
    if not isinstance(data, dict):
        return ["claims: must be an object"]
    for f in ("pack", "reviewer", "round", "claims", "ats"):
        if f not in data:
            p.append(f"claims: missing {f}")
    if not LEDGER_ID.match(str(data.get("reviewer", ""))):
        p.append("claims: reviewer must be the reviewer's ledger id, such as 2026-10-17.reviewer.1 (H7)")
    if data.get("round") not in (1, 2):
        p.append("claims: round must be 1 or 2: one revision at most, then the line goes to sign-off (H6)")
    claims = data.get("claims") if isinstance(data.get("claims"), list) else []
    want, original = {}, {}
    for x in sents:
        k = (x["where"], _norm(x["sentence"]))
        want[k] = want.get(k, 0) + 1
        original[k] = x["sentence"]
    seen = {}
    vault_n = {k: _norm(v) for k, v in vault.items()}
    for i, c in enumerate(claims):
        at = f"claims[{i}]"
        if not isinstance(c, dict):
            p.append(f"{at}: must be an object")
            continue
        k = (c.get("where"), _norm(c.get("sentence")))
        seen[k] = seen.get(k, 0) + 1
        if k not in want:
            p.append(f"{at}: {str(c.get('sentence'))[:80]!r} is not a sentence of the CV Summary, highlights or letter")
        v = c.get("verdict")
        if v not in VERDICTS:
            p.append(f"{at}: verdict must be one of {', '.join(VERDICTS)}")
        if v in ("supported", "compressed"):
            src = c.get("source")
            if not isinstance(src, dict) or not src.get("file") or not src.get("quote"):
                p.append(f"{at}: a {v} verdict needs a source: the vault file and the line quoted from it")
            elif src["file"] not in vault_n:
                p.append(f"{at}: {src['file']} is not a vault file the reviewer was given")
            elif len(_norm(src["quote"])) < 12 or _norm(src["quote"]) not in vault_n[src["file"]]:
                p.append(f"{at}: quote not found in {src['file']}: {str(src['quote'])[:80]!r}")
        if v in ("unsupported", "hedged", "no-claim"):
            if len(str(c.get("reason") or "").strip()) < 10:
                p.append(f"{at}: a {v} verdict needs a reason")
        if v == "no-claim" and c.get("where") != "letter":
            p.append(f"{at}: only a letter sentence can make no claim; the CV Summary and highlights always do")
        p += text_problems(c.get("reason") or "", f"{at}.reason")
    for k, n in want.items():
        got = seen.get(k, 0)
        if got == 0:
            p.append(f"claims: not judged: {k[0]}: {original[k][:80]!r}")
        elif got > n:
            p.append(f"claims: judged more than once: {k[0]}: {original[k][:80]!r}")
    # E12, moved to the reviewer: the code's missing and partly found terms, each judged once.
    rows = (ats or {}).get("items") or []
    open_terms = {r["item"]: r["status"] for r in rows if r.get("status") in ("missing", "partly found")}
    found_terms = {r["item"] for r in rows if r.get("status") == "found"}
    judged = {}
    pack_n = _norm(pack_text)
    for i, a in enumerate(data.get("ats") if isinstance(data.get("ats"), list) else []):
        at = f"ats[{i}]"
        if not isinstance(a, dict):
            p.append(f"{at}: must be an object")
            continue
        t = a.get("term")
        judged[t] = judged.get(t, 0) + 1
        if t in found_terms:
            p.append(f"{at}: {t!r} was found by the code; judge only missing and partly found terms")
        elif t not in open_terms:
            p.append(f"{at}: {t!r} is not an item in ats.json")
        if a.get("status") == "covered":
            if not a.get("line") or _norm(a["line"]) not in pack_n:
                p.append(f"{at}: the line for {t!r} is not in the CV or letter")
        elif a.get("status") == "gap":
            if a.get("line") not in (None, ""):
                p.append(f"{at}: a genuine gap quotes no line")
        else:
            p.append(f"{at}: status must be covered or gap")
    for t, st in open_terms.items():
        if judged.get(t, 0) == 0:
            p.append(f"ats: {t!r} ({st}) not judged")
        elif judged[t] > 1:
            p.append(f"ats: {t!r} judged more than once")
    # H11: the reviewer's verdict on the pack's AI answer, when it was asked for one.
    disc = data.get("disclosure")
    if disc is not None:
        if not isinstance(disc, dict) or disc.get("verdict") not in ("matches", "differs"):
            p.append("disclosure: must be { verdict: matches or differs, reason } (H11)")
        elif disc["verdict"] == "differs" and len(str(disc.get("reason") or "").strip()) < 10:
            p.append("disclosure: differs needs the pack's wording as the reason")
    return p


def _sha16(path):
    import hashlib
    with open(path, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()[:16]


def hashes(pack_dir, names):
    return {n: _sha16(os.path.join(pack_dir, n)) for n in names}


def check_unchanged(before, pack_dir):
    p = []
    for n, h in before.items():
        path = os.path.join(pack_dir, n)
        if not os.path.exists(path):
            p.append(f"pack: {n} is missing after review")
        elif _sha16(path) != h:
            p.append(f"pack: {n} changed during review; the reviewer writes nothing")
    return p

# ---- Sprint 6a: replies to applications (I2 to I4) ----
REPLY_TYPES = ("rejection", "invitation", "assessment", "request", "offer", "follow-up", "other")
REPLY_STATUS = ("ok", "partial", "failed", "missing")
REPLY_MOVES = {
    "invitation": {"applied": "conversation"},
    "assessment": {"applied": "conversation"},
    "offer": {"applied": "conversation"},
    "rejection": {"applied": "rejected", "conversation": "rejected"},
}
STAGES = ("draft", "applied", "conversation", "rejected", "archived")
STAGE_LEGACY = {"preparing": "draft", "screening": "conversation", "interviewing": "conversation", "offer": "conversation", "closed": "rejected", "withdrawn": "rejected"}


def _stage(v):
    v = str(v or "").lower()
    return STAGE_LEGACY.get(v, v if v in STAGES else "draft")


def check_replies(data):
    """The PC's reply summary (I2): its shape, and that no email text came with it."""
    p = []
    if not isinstance(data, dict) or not isinstance(data.get("replies"), list):
        return ["replies: must be the reply reader's summary.json, with a replies list"]
    for i, r in enumerate(data["replies"]):
        label = f"replies[{i}]"
        if not isinstance(r, dict):
            p.append(f"{label}: must be an object")
            continue
        if not re.match(r"^r-[0-9a-f]{12}$", str(r.get("id"))):
            p.append(f"{label}: id must be r- and twelve hex characters")
        if r.get("status") not in REPLY_STATUS:
            p.append(f"{label}: status must be one of {', '.join(REPLY_STATUS)}")
        rd = r.get("read")
        if rd is not None:
            if rd.get("type") not in REPLY_TYPES:
                p.append(f"{label}: type must be one of {', '.join(REPLY_TYPES)}")
            if len(str(rd.get("ask") or "")) > 200:
                p.append(f"{label}: the ask is a quote of at most 200 characters")
        for key in ("text", "body", "html", "subject", "raw"):
            if key in r or (isinstance(rd, dict) and key in rd):
                p.append(f"{label}: '{key}' must not leave the PC")
        for path, t in texts(r, label):
            if len(t) > 300:
                p.append(f"{path}: {len(t)} characters; nothing in the summary is longer than 300")
    return p


def check_moves(data, existing):
    """I4: the board patches from tools/replies.py match, checked against the board before anything is written."""
    p = []
    if not isinstance(data, dict) or not isinstance(data.get("patches"), list):
        return ["moves: must be the output of tools/replies.py match"]
    if existing is None:
        return ["moves: needs --existing, the board's applications"]
    board = {c.get("id"): c.get("data") or {} for c in existing if isinstance(c, dict)}
    passed = data.get("gradePassed") is True
    items = {i.get("replyId"): i for i in data.get("items") or [] if isinstance(i, dict)}
    seen = set()
    for n, pt in enumerate(data["patches"]):
        cid, patch = pt.get("cardId"), pt.get("patch") or {}
        label = f"moves[{n}] {cid}"
        if cid not in board:
            p.append(f"{label}: no such card on the board")
            continue
        card = board[cid]
        extra = sorted(set(patch) - {"status", "log", "suggestions"})
        if extra:
            p.append(f"{label}: may change only status, log and suggestions, not {', '.join(extra)}")
        old_log = card.get("log") or []
        new_log = patch.get("log", old_log)
        if new_log[: len(old_log)] != old_log:
            p.append(f"{label}: the card's log may only be added to, never changed")
            continue
        added = new_log[len(old_log):]
        old_ids = {e.get(k) for e in old_log if isinstance(e, dict) for k in ("replyId", "undo", "dismissed", "confirmed")} | {s.get("replyId") for s in card.get("suggestions") or [] if isinstance(s, dict)}
        now = _stage(card.get("status"))
        moved_to = None
        for e in added:
            rid = e.get("replyId") if isinstance(e, dict) else None
            if not isinstance(e, dict) or e.get("by") != "scout" or not rid or not isinstance(e.get("text"), str):
                p.append(f"{label}: each new log entry must be the scout's, with a replyId and text")
                continue
            if rid in old_ids or rid in seen:
                p.append(f"{label}: reply {rid} has already been acted on; never twice")
            seen.add(rid)
            if len(e["text"]) > 600:
                p.append(f"{label}: log text over 600 characters")
            for why, rx in INSTRUCTION_LIKE:
                if rx.search(e["text"]):
                    p.append(f"{label}: log text {why}")
            typ = e.get("type")
            for kind in ("move", "suggest"):
                mv = e.get(kind)
                if mv is None:
                    continue
                if mv.get("from") != now or REPLY_MOVES.get(typ, {}).get(now) != mv.get("to"):
                    p.append(f"{label}: a {typ} may not take a card from {now} to {mv.get('to')}")
                if kind == "move":
                    it = items.get(rid, {})
                    if not passed:
                        p.append(f"{label}: a move was made before the reader passed its grading; it must be a suggestion")
                    if data.get("firstLook"):
                        p.append(f"{label}: a move from the first look back must be a suggestion")
                    if not it.get("verified", False):
                        p.append(f"{label}: a move on an unverified sender must be a suggestion")
                    moved_to = mv.get("to")
        if "status" in patch:
            if moved_to is None or patch["status"] != moved_to:
                p.append(f"{label}: status may change only with a matching move in the log")
            if now in ("draft", "archived"):
                p.append(f"{label}: a {now} card never moves")
        elif moved_to is not None:
            p.append(f"{label}: the log says moved but the status is unchanged")
        if "suggestions" in patch:
            old_s = card.get("suggestions") or []
            if patch["suggestions"][: len(old_s)] != old_s:
                p.append(f"{label}: suggestions may only be added to")
    return p


DOC_FIELDS = {
    "replies": {"replyId", "cardId", "company", "role", "domain", "date", "type", "action", "note", "offer", "seen", "source", "created", "warnings"},
    "todos": {"replyId", "cardId", "company", "role", "domain", "ask", "askBy", "done", "source", "created", "warnings"},
    "events": {"replyId", "cardId", "company", "role", "domain", "kind", "start", "end", "zone", "zoneAssumed", "title", "asWritten", "group", "source", "created"},
}
DOC_ID = re.compile(r"^r-[0-9a-f]{12}(-(?:c|d|[1-6]))?$")
ZONE_RX = re.compile(r"^(UTC|[A-Z][A-Za-z_]+/[A-Z][A-Za-z_]+)$")
WHEN_RX = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$")


def check_docs(data, existing_ids=None):
    """Sprint 6b (I5, I7): the Inbox, to-do and calendar documents part 2 creates. Create-only."""
    p = []
    if not isinstance(data, dict) or not isinstance(data.get("writes"), list):
        return ["docs: must be the output of tools/replies.py docs"]
    have = {k: set(v or []) for k, v in (existing_ids or {}).items()}
    seen = set()
    for n, w in enumerate(data["writes"]):
        col, did, d = w.get("collection"), str(w.get("doc_id")), w.get("data") or {}
        label = f"docs[{n}] {col}/{did}"
        if col not in DOC_FIELDS:
            p.append(f"{label}: only replies, todos and events may be created")
            continue
        if not DOC_ID.match(did):
            p.append(f"{label}: id must be the reply's id (r- and 12 hex), with -c, -d or -1 to -6 for events")
        if did in have.get(col, set()) or (col, did) in seen:
            p.append(f"{label}: already exists; documents are created once and never overwritten")
        seen.add((col, did))
        extra = sorted(set(d) - DOC_FIELDS[col])
        if extra:
            p.append(f"{label}: fields not allowed: {', '.join(extra)}")
        if d.get("source") != "scout":
            p.append(f"{label}: source must be scout")
        if "warnings" in d and (not isinstance(d["warnings"], list) or len(d["warnings"]) > 3 or not all(isinstance(w, str) and 0 < len(w) <= 120 for w in d["warnings"])):
            p.append(f"{label}: warnings must be a list of at most three short notes (120 characters each), BUG-3")
        if col == "todos" and (not isinstance(d.get("ask"), str) or not 0 < len(d["ask"]) <= 200 or d.get("done") is not False):
            p.append(f"{label}: a to-do needs its ask (200 characters at most) and starts not done")
        if col == "events":
            if d.get("kind") not in ("confirmed", "proposed", "deadline"):
                p.append(f"{label}: kind must be confirmed, proposed or deadline")
            if not WHEN_RX.match(str(d.get("start") or "")):
                p.append(f"{label}: start must be a date or date and time")
            elif str(d.get("start"))[:4] < "2020" or (d.get("end") and str(d["end"]) < str(d["start"])):
                p.append(f"{label}: start {d.get('start')} is not a plausible time for this event (BUG-4: a calendar file's time-zone rules read as the event)")
            if d.get("kind") != "deadline" and not ZONE_RX.match(str(d.get("zone") or "")):
                p.append(f"{label}: a timed event needs its zone")
        for path, t in texts(d, label):
            if len(t) > 300:
                p.append(f"{path}: over 300 characters")
            for why, rx in INSTRUCTION_LIKE:
                if rx.search(t):
                    p.append(f"{path}: {why}")
    return p


def validate(kind, data, settings=None, existing=None, candidates=None, demo=False):
    if kind == "docs":
        return check_docs(data, existing)
    if kind == "replies":
        return check_replies(data)
    if kind == "moves":
        return check_moves(data, existing)
    if kind == "scores":
        return check_scores(data, settings)
    if kind == "carryover":
        return check_carryover(data, settings)
    if kind == "card":
        return check_card(data, existing, demo)
    if kind == "pack":
        return check_pack(data)
    if kind == "urls":
        return check_urls(data, settings, candidates)
    if kind == "jobspec":
        return check_jobspec(data)
    raise ValueError(f"unknown kind {kind}")


# H16 (Sprint 8): the demo writes to the demo board only, never the real one. The two boards'
# addresses are in config/boards.json (H22: each copy names its own), {"real": <id>, "demo": <id>}.
BOARD_URL = re.compile(r"^https://claude\.ai/(?:code/)?artifact/([A-Za-z0-9-]+)/?$")


def boards(root):
    """config/boards.json: the real board's and the demo board's artifact ids. Missing or unreadable: none known."""
    try:
        with open(os.path.join(root, "config", "boards.json"), encoding="utf-8") as f:
            b = json.load(f)
        return (b.get("real") or None), (b.get("demo") or None)
    except (OSError, ValueError, AttributeError):
        return None, None


def check_demoboard(url, folder, root=None):
    """The board a demo run may write to: the demo board, and only from a folder npm run demo made."""
    problems = []
    root = os.path.realpath(root or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    real_id, demo_id = boards(root)
    m = BOARD_URL.match((url or "").strip())
    if not m:
        problems.append(f"demoboard: {url!r} is not a board address (https://claude.ai/artifact/<id>).")
    elif not demo_id:
        problems.append("demoboard: no demo board is named in config/boards.json, so no board can be written.")
    elif real_id and (m.group(1) == real_id or real_id in url):
        problems.append("demoboard: that is the real board. The demo never writes to it.")
    elif m.group(1) != demo_id:
        problems.append(f"demoboard: {m.group(1)} is not the demo board ({demo_id}).")
    if not folder:
        problems.append("demoboard: --folder (the demo run's folder, data\\demo\\<date>) is required.")
        return problems
    home = os.path.join(root, "data", "demo")
    f = os.path.realpath(folder)
    if os.path.dirname(f) != home or not re.match(r"^\d{4}-\d{2}-\d{2}$", os.path.basename(f)):
        problems.append(f"demoboard: {folder} is not a folder data\\demo\\<date> in this Job Scout folder.")
    elif not os.path.exists(os.path.join(f, ".demo")):
        problems.append(f"demoboard: {folder} has no .demo marker, so it was not made by npm run demo.")
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check the AI's output before it is written (backlog H3).")
    ap.add_argument("kind", choices=["scores", "carryover", "card", "pack", "urls", "jobspec", "claims", "sentences", "hashes", "replies", "moves", "docs", "disclosure", "demoboard"])
    ap.add_argument("file")
    ap.add_argument("names", nargs="*", help="hashes: the pack files to hash")
    ap.add_argument("--cv", help="claims: the CV as built (.md)")
    ap.add_argument("--letter", help="claims, sentences: the letter as built (.md)")
    ap.add_argument("--ats", help="claims: the pack's ats.json")
    ap.add_argument("--vault", help="claims: the folder of vault files the reviewer was given")
    ap.add_argument("--before", help="claims: the pack's hashes before review (from the hashes kind)")
    ap.add_argument("--pack", help="claims: the pack folder, to compare with --before")
    ap.add_argument("--settings", help="the board's settings (settings.json); defaults are used without it")
    ap.add_argument("--existing", help="the board's applications, as [{id, data}], to catch duplicate cards; for docs, the ids already on the board")
    ap.add_argument("--bank", help="disclosure: the approved form-answer bank (_context/job-scout/form-answers.md)")
    ap.add_argument("--candidates", help="the run's candidates.json, to check the ids in advert-urls.json")
    ap.add_argument("--folder", help="demoboard: the demo run's folder (data\\demo\\<date>); required")
    ap.add_argument("--demo", action="store_true", help="card: a demo card, whose pack may be under Job Scout\\data\\demo (BUG-7)")
    ap.add_argument("--root", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    def load(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def read(path):
        with open(path, encoding="utf-8") as f:
            return f.read()

    if a.kind == "sentences":
        out = sentences(read(a.file), read(a.letter) if a.letter else "")
        # Found by the first demo run: a CV whose Summary or highlights were not found gave the reviewer
        # the letter alone, without a word of warning. Refuse instead.
        missing = [w for w in ("summary", "highlight-1") if not any(s["where"] == w for s in out)]
        if missing:
            print(f"sentences: no {' or '.join(missing)} found in {a.file} (it needs '## Summary' and '## Selected Highlights' with '- ' bullets)", file=sys.stderr)
            return 1
        print(json.dumps(out, indent=1, ensure_ascii=False))
        return 0
    if a.kind == "hashes":
        print(json.dumps(hashes(a.file, a.names), indent=1))
        return 0
    if a.kind == "demoboard":
        problems = check_demoboard(a.file, a.folder, a.root)
        for line in problems:
            print(line)
        if problems:
            print("FAILED: write nothing to any board.")
            return 1
        print("OK: demoboard passed (the demo board).")
        return 0
    if a.kind == "disclosure":
        if not a.bank:
            print("disclosure needs --bank")
            return 2
        problems = check_disclosure(read(a.file), read(a.bank))
        for line in problems:
            print(line)
        if problems:
            print("FAILED: the pack's AI answer is not the approved one. Fix form-answers.md before the pack is finished.")
            return 1
        print("OK: disclosure passed.")
        return 0
    try:
        data = load(a.file)
    except (OSError, json.JSONDecodeError) as e:
        print(f"{a.file}: cannot be read as JSON ({e})")
        return 2
    settings = load(a.settings) if a.settings else None
    existing = load(a.existing) if a.existing else None
    candidates = load(a.candidates) if a.candidates else None
    if a.kind == "claims":
        if not (a.cv and a.letter and a.ats and a.vault):
            print("claims needs --cv, --letter, --ats and --vault")
            return 2
        vault = {}
        for root, _, files in os.walk(a.vault):
            for n in files:
                if n.endswith(".md"):
                    full = os.path.join(root, n)
                    vault[os.path.relpath(full, a.vault).replace(os.sep, "/")] = read(full)
        cv, letter = read(a.cv), read(a.letter)
        problems = check_claims(data, sentences(cv, letter), vault, load(a.ats), cv + "\n" + letter)
        if a.before:
            problems += check_unchanged(load(a.before), a.pack or os.path.dirname(a.cv))
    else:
        problems = validate(a.kind, data, settings, existing, candidates, demo=a.demo)
    if problems:
        for line in problems:
            try:
                print(line)
            except BrokenPipeError:
                return 1
        print(f"FAILED: {len(problems)} problem(s). Write nothing; put these in the digest's Problems.")
        return 1
    print(f"OK: {a.kind} passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
