"""kit: the expert bar. Pins the docs step, defect habits as debt, the engineering baseline, the
static-analysis set and the test-quality rules.

Run: python -m unittest discover -s plugins/kit/tests
"""
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..")


def read(*parts):
    with open(os.path.join(PLUGIN, *parts), encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


class PersonaDocsStep(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "persona", "SKILL.md")

    def test_docs_step_is_required_and_uses_the_real_version(self):
        self.assertIn("### Where Standards come from", self.text)
        self.assertIn("This step is required for every editing persona", self.text)
        self.assertIn("major version from the lockfile", self.text)
        self.assertIn("official docs or the upgrade guide", self.text)
        self.assertIn("source URL", self.text)

    def test_no_web_tool_is_said_and_marked(self):
        self.assertIn("With no web tool, say so in the proposal", self.text)
        self.assertIn("`ecosystem idiom, from memory, unverified`", self.text)

    def test_defect_habit_is_debt_not_a_standard(self):
        self.assertIn("A habit is not a Standard when it is a defect", self.text)
        self.assertIn("existing debt", self.text)

    def test_engineering_baseline_and_size(self):
        self.assertIn("### Engineering baseline", self.text)
        for needle in ("One responsibility per unit", "No second copy", "Dependency direction",
                       "never swallowed", "validated at the boundary", "Tests assert behaviour"):
            self.assertIn(needle, self.text)
        self.assertIn("### How many", self.text)
        self.assertIn("Eight to fifteen Standards", self.text)


class InitDocsAndStaticAnalysis(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "init", "SKILL.md")

    def test_init_requires_docs_step_and_lists_debt(self):
        self.assertIn("do the persona skill's docs step", self.text)
        self.assertIn("it is required", self.text)
        self.assertIn("as existing debt", self.text)

    def test_static_analysis_set(self):
        self.assertIn("static-analysis set", self.text)
        for job in ("formatter check", "type check", "complexity limit", "duplication check",
                    "dependency audit", "secret scan"):
            self.assertIn(job, self.text)
        self.assertIn("never two tools for one job", self.text)
        self.assertIn("its own item the person can decline", self.text)
        self.assertIn("give its cost", self.text)


class AgentsHoldTheBar(unittest.TestCase):
    def test_builder_does_not_copy_defects(self):
        text = read("agents", "builder.md")
        self.assertIn("A defect is not a habit to copy", text)
        self.assertIn("Name each such divergence in your report", text)
        self.assertIn("don't refactor old code outside the task", text)
        self.assertNotIn("follow the project. Mention the conflict", text)

    def test_test_writer_rules(self):
        text = read("agents", "test-writer.md")
        for needle in ("public entry point", "Mock only at process or network edges", "Each test can fail",
                       "never by a ticket, issue or release"):
            self.assertIn(needle, text)

    def test_reviewer_checks_test_rules(self):
        text = read("agents", "reviewer.md")
        self.assertIn("Hold every test in the diff to these", text)
        self.assertIn("process or network edges", text)


class Changelog(unittest.TestCase):
    def test_unreleased_entry_on_top(self):
        text = read("CHANGELOG.md")
        self.assertLess(text.index("## Unreleased"), text.index("## 0.5.0"))


if __name__ == "__main__":
    unittest.main()
