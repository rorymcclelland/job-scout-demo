"""Keep facts in the docs in step with the code (docs as code).

Numbers in the docs that can be counted are wrapped in markers, for example
<!-- fact:code-tests -->131<!-- /fact -->. This tool counts them again and
rewrites the markers, or with --check reports any that are out of date.

Usage: python tools/doc_facts.py [--check] [root]
"""
import glob, os, re, sys

FACT = re.compile(r"(<!-- fact:([a-z-]+) -->)(.*?)(<!-- /fact -->)")


def count(root, pattern, line_re):
    rx = re.compile(line_re)
    n = 0
    for path in glob.glob(os.path.join(root, pattern), recursive=True):
        with open(path, encoding="utf-8") as f:
            n += sum(1 for line in f if rx.match(line))
    return n


def facts(root):
    return {
        "code-tests": str(count(root, "test/**/*.test.ts", r"^\s*(test|it)\(")),
        "tool-tests": str(count(root, "tools/test_*.py", r"^\s*def test_")),
    }


def update(text, values):
    stale = []

    def repl(m):
        name, old = m.group(2), m.group(3)
        if name not in values:
            return m.group(0)
        if old != values[name]:
            stale.append((name, old, values[name]))
        return m.group(1) + values[name] + m.group(4)

    return FACT.sub(repl, text), stale


def main(argv):
    check = "--check" in argv
    rest = [a for a in argv if a != "--check"]
    root = rest[0] if rest else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    values = facts(root)
    problems = 0
    for path in [os.path.join(root, "README.md")] * os.path.exists(os.path.join(root, "README.md")) + sorted(glob.glob(os.path.join(root, "docs", "*.md"))):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        new, stale = update(text, values)
        for name, old, now in stale:
            problems += 1
            print(f"{os.path.basename(path)}: {name} says {old}, now {now}")
        if stale and not check:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(new)
    if check and problems:
        return 1
    print("facts:", ", ".join(f"{k} {v}" for k, v in values.items()), "| updated" if problems and not check else "| in step")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
