"""kit:reviewer's frontmatter pins its model and effort (ADR-0011 amendment, 2026-10-27).

Run: python -m unittest discover -s plugins/kit/tests
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REVIEWER = os.path.join(HERE, "..", "agents", "reviewer.md")


def read_reviewer():
    with open(REVIEWER, encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def frontmatter(text):
    lines = text.split("\n")
    assert lines[0] == "---", "file doesn't open with ---"
    return lines[1:lines.index("---", 1)]


class ReviewerAgent(unittest.TestCase):
    def test_frontmatter_pins_effort_medium_exactly_once(self):
        fm = frontmatter(read_reviewer())
        self.assertEqual([l for l in fm if l.startswith("effort:")], ["effort: medium"])

    def test_frontmatter_still_pins_model_opus(self):
        self.assertIn("model: opus", frontmatter(read_reviewer()))

    def test_file_has_no_lens_section(self):
        headings = [l for l in read_reviewer().split("\n") if re.match(r"#{1,6}\s", l)]
        self.assertEqual([h for h in headings if "lens" in h.lower()], [])


if __name__ == "__main__":
    unittest.main()
