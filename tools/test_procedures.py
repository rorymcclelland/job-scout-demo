"""H22c (Sprint 9): the public procedures must not drift from the owner's private ones.

Every tool command the private procedures name (validate.py <kind>, replies.py <command>,
ledger.py add, build_pack.py, ats_match.py) must also appear in procedures/. The private
procedures live in the owner's vault, beside the Job Scout folder; anywhere else (the
public copy), this test has nothing to compare and says so."""
import glob
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT = os.environ.get("JOB_SCOUT_VAULT") or os.path.join(ROOT, "..", "Professional development", "_context", "job-scout")
COMMAND = re.compile(r"\b(validate\.py [a-z]+|replies\.py [a-z]+|ledger\.py add|build_pack\.py|ats_match\.py)\b")


def commands(paths):
    found = set()
    for p in paths:
        with open(p, encoding="utf-8") as f:
            found |= set(COMMAND.findall(f.read()))
    return found


@unittest.skipUnless(os.path.exists(os.path.join(VAULT, "SCOUT.md")), "the private procedures are not here (the public copy)")
class Procedures(unittest.TestCase):
    def test_every_private_command_is_in_the_public_procedures(self):
        private = commands([os.path.join(VAULT, n) for n in ("SCOUT.md", "PACK.md", "REVIEW.md") if os.path.exists(os.path.join(VAULT, n))])
        public = commands(glob.glob(os.path.join(ROOT, "procedures", "*.md")) + [os.path.join(ROOT, "demo", "DEMO.md")])
        self.assertTrue(private)
        self.assertEqual(sorted(private - public), [], "commands in the private procedures but not the public ones")


if __name__ == "__main__":
    unittest.main()
