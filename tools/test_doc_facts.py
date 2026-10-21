import os, tempfile, unittest
from doc_facts import update, facts, main


class DocFacts(unittest.TestCase):
    def test_updates_a_stale_marker(self):
        new, stale = update("x <!-- fact:code-tests -->129<!-- /fact --> y", {"code-tests": "131"})
        self.assertEqual(new, "x <!-- fact:code-tests -->131<!-- /fact --> y")
        self.assertEqual(stale, [("code-tests", "129", "131")])

    def test_leaves_unknown_and_current_markers(self):
        text = "<!-- fact:other -->5<!-- /fact --> <!-- fact:tool-tests -->110<!-- /fact -->"
        new, stale = update(text, {"tool-tests": "110"})
        self.assertEqual(new, text)
        self.assertEqual(stale, [])

    def test_counts_and_check_mode(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "test"))
            os.makedirs(os.path.join(root, "tools"))
            os.makedirs(os.path.join(root, "docs"))
            with open(os.path.join(root, "test", "a.test.ts"), "w") as f:
                f.write('test("one", () => {});\n  it("two", () => {});\n// test( not at start\n')
            with open(os.path.join(root, "tools", "test_x.py"), "w") as f:
                f.write("    def test_a(self): pass\n    def helper(self): pass\n")
            self.assertEqual(facts(root), {"code-tests": "2", "tool-tests": "1"})
            doc = os.path.join(root, "docs", "D.md")
            with open(doc, "w") as f:
                f.write("<!-- fact:code-tests -->9<!-- /fact -->\n")
            self.assertEqual(main(["--check", root]), 1)
            self.assertEqual(main([root]), 0)
            self.assertEqual(main(["--check", root]), 0)
            with open(doc) as f:
                self.assertIn("-->2<!--", f.read())


if __name__ == "__main__":
    unittest.main()
