"""Tests for the audit trail (backlog H7). Run: python3 -m unittest tools/test_ledger.py"""

import json
import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from ledger import add, file_hash, find, main  # noqa: E402
from validate import validate  # noqa: E402
from weekly import by_model, summarise  # noqa: E402


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)



def _load(path):
    with open(path) as f:
        return json.load(f)


class Ledger(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "2026-10-17.json")
        # The code half's entry, as src/ledger.ts writes it.
        write(self.path, json.dumps({"date": "2026-10-17", "entries": [
            {"id": "2026-10-17.scout.1", "agent": "scout", "kind": "code", "where": "pc", "model": None, "version": "0.7.0",
             "at": "2026-10-17T06:30:00Z", "instructions": {}, "settingsVersion": 5, "inputs": {}, "counts": {"score": 9}}]}))
        self.scout = os.path.join(self.dir, "SCOUT.md")
        write(self.scout, "# Scoring\nStep one.\n")
        self.settings = os.path.join(self.dir, "settings.json")
        write(self.settings, json.dumps({"version": 5}))

    def test_a_run_has_an_entry_for_the_code_and_the_orchestrator(self):
        i = add(self.path, "orchestrator", "claude-opus-5-5", "cloud", [self.scout], self.settings, {"candidates": 9}, {"scored": 9, "shortlisted": 2})
        self.assertEqual(i, "2026-10-17.orchestrator.1")
        entries = _load(self.path)["entries"]
        self.assertEqual([e["agent"] for e in entries], ["scout", "orchestrator"])
        e = entries[1]
        self.assertEqual((e["kind"], e["where"], e["model"], e["settingsVersion"]), ("ai", "cloud", "claude-opus-5-5", 5))
        self.assertEqual(e["counts"], {"scored": 9, "shortlisted": 2})
        self.assertEqual(add(self.path, "orchestrator", "claude-opus-5-5", "cloud", [], None, {}, {}), "2026-10-17.orchestrator.2")

    def test_changing_a_procedure_changes_its_hash_but_not_its_line_endings(self):
        before = file_hash(self.scout)
        write(self.scout, "# Scoring\r\nStep one.\r\n")
        self.assertEqual(file_hash(self.scout), before)  # the same on Windows and in the workspace
        write(self.scout, "# Scoring\nStep one, changed.\n")
        self.assertNotEqual(file_hash(self.scout), before)
        add(self.path, "orchestrator", "m", "cloud", [self.scout], None, {}, {})
        self.assertEqual(_load(self.path)["entries"][-1]["instructions"]["SCOUT.md"], file_hash(self.scout))

    def test_a_cards_ledger_id_resolves_to_its_entry(self):
        i = add(self.path, "writer", "claude-opus-5-5", "cloud", [], None, {}, {"packs": 1})
        card = {"id": "scout-acme-head-of-product", "data": {
            "company": "Acme", "role": "Head of Product", "status": "draft", "source": "scout", "scoutId": "linkedin:1",
            "score": 70, "rubricVersion": 3, "runDate": "2026-10-17", "site": "linkedin", "ledger": i}}
        self.assertEqual(validate("card", card), [])
        self.assertEqual(find(self.path, card["data"]["ledger"])["agent"], "writer")
        card["data"]["ledger"] = "yesterday"
        self.assertIn("ledger must be a ledger entry id", " ".join(validate("card", card)))

    def test_weekly_groups_the_ai_steps_by_model(self):
        add(self.path, "orchestrator", "model-a", "cloud", [], None, {}, {"scored": 9, "shortlisted": 2})
        add(self.path, "orchestrator", "model-b", "cloud", [], None, {}, {"scored": 4, "shortlisted": 1})
        add(self.path, "orchestrator", "model-a", "cloud", [], None, {}, {"scored": 1, "shortlisted": 0})
        entries = _load(self.path)["entries"]
        g = by_model(entries, date(2026, 10, 12), date(2026, 10, 18))
        self.assertEqual(g[("orchestrator", "model-a", "cloud")]["runs"], 2)
        self.assertEqual(g[("orchestrator", "model-a", "cloud")]["counts"]["scored"], 10)
        self.assertNotIn(("scout", "unknown", "pc"), g)  # code entries are not AI steps
        text = summarise([], [], date(2026, 10, 12), date(2026, 10, 18), entries)
        self.assertIn("| orchestrator | model-b | cloud | 1 | scored 4, shortlisted 1 |", text)

    def test_command_line(self):
        self.assertEqual(main(["add", self.path, "--agent", "reviewer", "--model", "m", "--where", "cloud", "--count", "flags=0"]), 0)
        self.assertEqual(main(["show", self.path, "2026-10-17.reviewer.1"]), 0)
        self.assertEqual(main(["show", self.path, "2026-10-17.reviewer.9"]), 1)
        with self.assertRaises(SystemExit):
            main(["add", self.path, "--agent", "Bad Name", "--model", "m", "--where", "cloud"])


if __name__ == "__main__":
    unittest.main()
