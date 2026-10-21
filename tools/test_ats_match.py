"""Tests for the ATS match, part 1 (backlog E11)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from ats_match import markdown, match, normalise  # noqa: E402

BANK = """- go-to-market: gtm, go to market
- machine learning: ml
- start-up: startup, scale-up, vc-backed
- roadmap: roadmaps, roadmapping
"""


class Ats(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.bank = self.file("bank.md", BANK)

    def file(self, name, text):
        p = os.path.join(self.d, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def spec(self, must, nice=()):
        return self.file("spec.json", json.dumps({"id": "x", "status": "ok", "spec": {"mustHaves": list(must), "niceToHaves": list(nice)}}))

    def test_pm_and_product_manager_are_the_same_term(self):
        cv = self.file("cv.md", "Senior product manager at Acme for six years.")
        r = match(self.spec(["5 years as a PM"]), cv, None, self.bank)
        self.assertEqual(r["items"][0]["status"], "found")
        self.assertEqual(normalise("PMs"), ["product", "manager"])

    def test_aliases_plurals_and_hyphens(self):
        cv = self.file("cv.md", "Led GTM for two products; owned the roadmaps; ML features at a start up.")
        r = match(self.spec(["Go-to-market leadership", "Machine learning products", "Roadmap ownership", "Startup experience"]), cv, None, self.bank)
        self.assertEqual([i["status"] for i in r["items"]], ["found"] * 4, r["items"])

    def test_a_missing_must_have_counts_double(self):
        cv = self.file("cv.md", "Payments product leader.")
        r = match(self.spec(["Payments product leadership"], ["Kubernetes operations"]), cv, None, self.bank)
        self.assertEqual(r["figure"], round(100 * 2 / 3))
        r2 = match(self.spec(["Kubernetes operations"], ["Payments product leadership"]), cv, None, self.bank)
        self.assertEqual(r2["figure"], round(100 * 1 / 3))

    def test_same_input_same_output(self):
        cv = self.file("cv.md", "Product strategy, roadmaps and discovery across B2B SaaS.")
        letter = self.file("letter.md", "I have led go-to-market for new platforms.")
        a = match(self.spec(["B2B SaaS", "Discovery"], ["GTM"]), cv, letter, self.bank)
        b = match(self.spec(["B2B SaaS", "Discovery"], ["GTM"]), cv, letter, self.bank)
        self.assertEqual(json.dumps(a), json.dumps(b))
        self.assertEqual(a["items"][2]["where"], ["letter"])

    def test_a_summary_is_indicative_and_no_requirements_means_no_figure(self):
        cv = self.file("cv.md", "Product leader.")
        js = self.file("job-spec.md", "> Read as a summary of the page (not the full text).\n> Requirements: product leadership; B2B experience.\n> Nice to have: ML.\n")
        r = match(js, cv, None, self.bank)
        self.assertTrue(r["indicative"])
        self.assertEqual(len([i for i in r["items"] if i["kind"] == "must-have"]), 2)
        none = self.file("none.md", "An email about a role. No list of requirements here, but machine learning is mentioned.")
        r2 = match(none, cv, None, self.bank)
        self.assertIsNone(r2["figure"])
        self.assertIn("no figure", markdown(r2))


if __name__ == "__main__":
    unittest.main()
