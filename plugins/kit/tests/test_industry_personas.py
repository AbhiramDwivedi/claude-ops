"""kit 0.5.0: skill guidance for industry-specific product owners and per-stack personas, and the
builder and test-writer fallback report.

Run: python -m unittest discover -s plugins/kit/tests
"""
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..")
ROOT = os.path.join(PLUGIN, "..", "..")


def read(*parts, base=PLUGIN):
    with open(os.path.join(base, *parts), encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def section(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i + len(start))] if end else text[i:]


class InitStatesIndustry(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "init", "SKILL.md")

    def test_runs_the_scan_helper(self):
        self.assertIn("scripts/kit_scan.py", self.text)

    def test_industry_step_reads_repo_and_asks_only_when_it_cannot_tell(self):
        for needle in ("Industry and domain", "README", "data models", "Ask the person only when the repo"):
            self.assertIn(needle, self.text)

    def test_proposal_states_industry_with_files_read(self):
        self.assertIn("states the industry and domain", self.text)
        self.assertIn("files it read", self.text)

    def test_one_persona_per_stack_area_rule_is_plain(self):
        self.assertIn("one persona per stack-area", self.text)
        self.assertIn("every area the code has gets a persona", self.text)

    # The three tests below pin required sentences. They are not proof of behaviour; the proof is
    # test_stack_scan.py and test_persona_check.py.
    def test_init_reads_evidence_and_names_the_industry_itself(self):
        self.assertIn("It names no industry; that is your job.", self.text)
        self.assertIn("A dev tool, a library or a template has no industry", self.text)

    def test_init_runs_the_persona_checker_before_showing_personas(self):
        self.assertIn("scripts/kit_persona_check.py", self.text)
        self.assertIn("Fix every error and run it again before you show anything", self.text)

    def test_persona_skill_runs_the_checker_and_names_the_po_headings(self):
        text = read("skills", "persona", "SKILL.md")
        self.assertIn("scripts/kit_persona_check.py", text)
        self.assertIn("`Regulations and compliance`", text)

    def test_persona_proposals_cite_repo_files_and_are_not_generic(self):
        self.assertIn("cite repo files", self.text)
        self.assertIn("generic", self.text)


class PersonaProductOwnerIndustry(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "persona", "SKILL.md")
        self.po = section(self.text, "- **`product-owner`.**", "- **An architect reviewer.**")

    def test_requires_an_industry_specific_judge(self):
        self.assertIn("industry-specific", self.po)
        self.assertIn("never a generic product owner", self.po)

    def test_names_the_required_parts(self):
        for needle in ("users and buyers", "regulations and compliance rules", "evidence in the repo",
                       "marked as an inference", "domain invariants", "vocabulary",
                       "failures users in that industry care most about", "acceptance checks"):
            self.assertIn(needle, self.po.lower())

    def test_forbids_generic_po_text(self):
        self.assertIn("Forbidden", self.po)
        self.assertIn("generic", self.po)

    def test_has_a_short_example_for_one_industry(self):
        self.assertIn("Example (healthcare", self.po)
        self.assertIn("HIPAA", self.po)

    def test_gets_industry_from_init(self):
        self.assertIn("industry kit:init stated", self.po)


class PersonaStackSpecific(unittest.TestCase):
    def setUp(self):
        self.text = read("skills", "persona", "SKILL.md")

    def test_standards_are_stack_and_area_specific_and_cite_files(self):
        self.assertIn("A Standard that fits any stack is generic", self.text)
        self.assertIn("cite a repo file", self.text)

    def test_self_check_rejects_generic_standards(self):
        self.assertIn("Swap the stack", self.text)

    def test_jvm_and_typescript_and_python_idioms_are_listed(self):
        for needle in ("Spring", "TypeScript", "FastAPI"):
            self.assertIn(needle, self.text)


class FallbackReport(unittest.TestCase):
    def test_builder_and_test_writer_are_the_fallback_and_report_a_missing_persona(self):
        for name in ("builder.md", "test-writer.md"):
            text = read("agents", name)
            fm = text.split("---")[1]
            self.assertIn("fallback when no project persona covers the area", fm)
            body = text.split("---", 2)[2]
            self.assertIn("fallback when no project persona covers the area", body)
            self.assertIn("first line", body)
            self.assertIn("missing persona", body)
            self.assertIn("/kit:init", body)
            self.assertIn("/kit:revise", body)
            self.assertIn(".claude/kit", body)

    def test_revise_covers_a_missing_persona_recommendation(self):
        self.assertIn("missing persona", read("skills", "revise", "SKILL.md"))


class VersionAndDocs(unittest.TestCase):
    def test_plugin_and_manifest_script_version(self):
        with open(os.path.join(PLUGIN, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
            version = json.load(f)["version"]
        self.assertIn('KIT_VERSION = "%s"' % version, read("scripts", "kit_manifest.py"))

    def test_changelog_has_the_entry(self):
        text = read("CHANGELOG.md")
        self.assertIn("## 0.5.0", text)
        for needle in ("industry", "kit_scan.py", "fallback"):
            self.assertIn(needle, text)

    def test_readme_has_from_0_5_0(self):
        self.assertIn("From 0.5.0", read("README.md", base=ROOT))


if __name__ == "__main__":
    unittest.main()
