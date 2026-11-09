"""kit 0.4.0: persona agents. Pins the persona skill's key rules and the files that point at it.

Run: python -m unittest discover -s plugins/kit/tests
"""
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..")


def read(*parts):
    with open(os.path.join(PLUGIN, *parts), encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def frontmatter(text):
    lines = text.split("\n")
    assert lines[0] == "---", "file doesn't open with ---"
    return lines[1:lines.index("---", 1)]


class PersonaSkill(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "persona", "SKILL.md")

    def test_frontmatter_names_the_skill(self):
        fm = frontmatter(self.text)
        self.assertIn("name: persona", fm)
        desc = [l for l in fm if l.startswith("description:")]
        self.assertEqual(len(desc), 1)
        self.assertIn("persona", desc[0])

    def test_body_sections_in_order(self):
        order = ["**Area.**", "**Stack.**", "**Standards.**", "**Proving it works.**", "**Skills.**",
                 "**Review checklist.**"]
        positions = [self.text.index(s) for s in order]
        self.assertEqual(positions, sorted(positions))

    def test_optional_sections(self):
        self.assertIn("Start from a known-good artifact", self.text)
        self.assertIn("Done means", self.text)

    def test_frontmatter_fields_and_names_by_stack(self):
        for field in ("`name`", "`description`", "`model`", "`effort`", "`tools`"):
            self.assertIn(field, self.text)
        self.assertIn("Never by pipeline step", self.text)

    def test_stack_idiomatic_examples(self):
        for needle in ("SNAPSHOT", "Caret ranges", "lockfile", "go.mod", "nothing blocks"):
            self.assertIn(needle, self.text)

    def test_judges_and_product_owner(self):
        self.assertIn("## 4. Judges", self.text)
        self.assertIn("`product-owner`", self.text)
        self.assertIn("never decides scope", self.text)
        self.assertIn("Optional", self.text)

    def test_read_only_is_enforced_in_tools_line(self):
        self.assertIn("`tools` line", self.text)
        self.assertIn("no `Write`, `Edit` or `NotebookEdit`", self.text)

    def test_tests_run_through_the_wrapper(self):
        self.assertIn("project's wrapper", self.text)
        self.assertIn("never a raw tool command", self.text)

    def test_no_rot_self_check(self):
        self.assertIn("## 5. Self-check before saving", self.text)
        for rule in ("Every path it names exists", "No counts, versions or line numbers", "No boilerplate",
                     "checkable from a diff", "Nothing the repo cannot follow"):
            self.assertIn(rule, self.text)

    def test_amend_from_evidence(self):
        self.assertIn("## 6. Amend", self.text)
        self.assertIn("cite the evidence", self.text)

    def test_cross_platform(self):
        self.assertNotRegex(self.text, r"/home/|/usr/|\bsudo\b|\bapt\b|\bbrew\b")


class InitProposesPersonas(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "init", "SKILL.md")

    def test_zero_agents_stance_is_gone(self):
        self.assertNotIn("Usually the right number is zero", self.text)
        self.assertNotIn("only where the repo clearly needs them", self.text)

    def test_day_0_persona_step(self):
        self.assertIn("Personas, on day 0", self.text)
        self.assertIn("kit:persona", self.text)
        self.assertIn("`product-owner`", self.text)
        self.assertIn("greenfield", self.text)

    def test_keeps_propose_first_and_grounding(self):
        self.assertIn("writes only after approval", self.text)
        self.assertIn("from this repo's code", self.text)
        self.assertIn("Write only what the person approved", self.text)

    def test_builder_and_test_writer_remain_fallback(self):
        self.assertIn("fallback", self.text)


class ReviewerLoadsPersonas(unittest.TestCase):
    def test_reviewer_holds_diff_to_persona_standards(self):
        text = read("agents", "reviewer.md")
        self.assertIn(".claude/agents/*.md", text)
        self.assertIn("Standards and Review checklist", text)
        self.assertIn("quote the item", text)
        self.assertIn("`product-owner`", text)

    def test_reviewer_stays_read_only(self):
        self.assertIn("tools: Read, Grep, Glob, Bash", frontmatter(read("agents", "reviewer.md")))


class ReviseAmendsPersonas(unittest.TestCase):
    def test_revise_amends_personas_from_evidence(self):
        text = read("skills", "revise", "SKILL.md")
        self.assertIn("A persona is amended from evidence", text)
        self.assertIn("no longer exists", text)
        self.assertIn("contradicts", text)
        self.assertIn("recurring review finding", text)


class BuilderIsFallback(unittest.TestCase):
    def test_builder_defers_to_persona(self):
        text = read("agents", "builder.md")
        self.assertIn("generic fallback", text)
        self.assertIn("project persona", text)


class ReadmeAndVersion(unittest.TestCase):
    def test_readme_stance_replaced(self):
        text = read("README.md")
        self.assertNotIn("There is no architect or product-owner agent", text)
        self.assertNotIn("adds cost, not quality", text)
        self.assertIn("personas", text)
        self.assertIn("`product-owner`", text)
        self.assertIn("kit:persona", text)

    def test_version_bumped(self):
        with open(os.path.join(PLUGIN, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["version"], "0.4.0")

    def test_manifest_schema_unchanged_by_personas(self):
        # personas fit the existing agents shape: bare name, declaredBy project
        with open(os.path.join(PLUGIN, "docs", "manifest.schema.json"), encoding="utf-8") as f:
            schema = json.load(f)
        self.assertEqual(schema.get("properties", {}).get("version", {}).get("const", 1), 1)


if __name__ == "__main__":
    unittest.main()
