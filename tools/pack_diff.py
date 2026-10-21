"""What the owner changed in a pack before sending it (backlog F2).

Compares the CV and letter as built (baseline.json, written by build_pack.py)
with every Word file now in the pack folder whose name says CV or covering
letter, including copies the owner saved under another name. Run by Claude for the
monthly learning review (WEEKLY.md), on folders staged into its workspace.

Usage:
  python3 pack_diff.py "<pack folder>" [more folders...]

Prints JSON: for each folder and document, the paragraphs removed, added and
reworded. An empty list means the pack went out as built.
"""

import difflib
import json
import sys
from pathlib import Path

from docx import Document


def paragraphs(path):
    return [p.text.strip() for p in Document(path).paragraphs if p.text.strip()]


def compare(before, after):
    changes = []
    sm = difflib.SequenceMatcher(a=before, b=after, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        old, new = before[i1:i2], after[j1:j2]
        if op == "replace" and len(old) == len(new):
            for o, n in zip(old, new):
                changes.append({"kind": "reworded", "before": o, "after": n})
        else:
            changes += [{"kind": "removed", "text": o} for o in old]
            changes += [{"kind": "added", "text": n} for n in new]
    return changes


def folder_report(folder):
    folder = Path(folder)
    base_file = folder / "baseline.json"
    if not base_file.exists():
        return {"folder": str(folder), "error": "no baseline.json: the pack was built before Sprint 3, or not by build_pack.py"}
    base = json.loads(base_file.read_text(encoding="utf-8"))
    docs = []
    for f in sorted(folder.glob("*.docx")):
        if f.name.startswith("~$"):
            continue
        kind = "cv" if " CV" in f.name else "letter" if "letter" in f.name.lower() else None
        if not kind:
            continue
        changes = compare(base[kind], paragraphs(f))
        docs.append({"file": f.name, "kind": kind, "changed": len(changes), "changes": changes})
    return {"folder": str(folder), "documents": docs}


if __name__ == "__main__":
    print(json.dumps([folder_report(f) for f in sys.argv[1:]], indent=2, ensure_ascii=False))
