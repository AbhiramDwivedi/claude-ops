"""Contract test for kit's manifest producer, repo ADR-0013 "Seams".

Written from the ADR before plugins/kit/scripts/kit_manifest.py exists, so until it does every
test here fails on "kit_manifest.py not found", never on an import error.
Run: python -m unittest discover -s plugins/kit/tests
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.normpath(os.path.join(HERE, ".."))
SCRIPT = os.path.join(KIT, "scripts", "kit_manifest.py")
SCHEMA = os.path.join(KIT, "docs", "manifest.schema.json")
PLUGIN_JSON = os.path.join(KIT, ".claude-plugin", "plugin.json")
HOOKS_REF = os.path.join(KIT, "skills", "init", "hooks-reference.md")
FIXTURE = os.path.join(HERE, "fixtures", "manifest.json")

BEGIN = "# kit:read-only-agents:begin"
END = "# kit:read-only-agents:end"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def facts_from_fixture():
    m = load(FIXTURE)
    return {k: m[k] for k in ("checks", "agents", "riskyPaths", "setupScripts")}


def find_bash():
    """bash for the stop-gate test. On Windows prefer Git's bash over WSL's System32 shim."""
    if os.name == "nt":
        for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
            if os.path.exists(p):
                return p
    found = shutil.which("bash")
    if found and os.name == "nt" and "system32" in found.lower():
        return None
    return found


class ManifestContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kit-contract-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.manifest = os.path.join(self.repo, ".claude", "kit", "manifest.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------- helpers ----------

    def run_script(self, *args, stdin=None):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: kit_manifest.py not found at %s" % SCRIPT)
        return subprocess.run(
            [sys.executable, SCRIPT] + list(args),
            input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=60,
        )

    def facts_file(self, facts, name="facts.json", raw=None):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(raw if raw is not None else json.dumps(facts))
        return path

    def write(self, facts=None, raw=None):
        path = self.facts_file(facts if facts is not None else facts_from_fixture(), raw=raw)
        return self.run_script("write", "--repo", self.repo, "--facts", path)

    def declare(self, by, names):
        return self.run_script("declare", "--repo", self.repo, "--by", by, "--read-only", names)

    def ok_json(self, r):
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, "stdout must be one JSON line, got: %r" % r.stdout)
        return json.loads(lines[0])

    def assert_error(self, r, code, exit_code):
        self.assertEqual(r.returncode, exit_code, "stderr: %s" % r.stderr.strip())
        self.assertRegex(r.stderr.strip(), r"^kit_manifest: %s: " % code)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1, "stderr must be one line: %r" % r.stderr)

    def manifest_bytes(self):
        with open(self.manifest, "rb") as f:
            return f.read()

    # ---------- 1. producer ----------

    def test_fixture_matches_schema_required(self):
        # The fixture itself (ajv validates it fully; this pins the keys for the tests below).
        self.assertEqual(list(load(FIXTURE).keys()), load(SCHEMA)["required"])

    def test_write_makes_manifest_with_schema_keys_version_and_kit(self):
        out = self.ok_json(self.write())
        self.assertTrue(os.path.isfile(self.manifest), "no manifest at %s" % self.manifest)
        m = load(self.manifest)
        self.assertEqual(list(m.keys()), load(SCHEMA)["required"], "keys in schema order")
        self.assertEqual(m["version"], 1)
        self.assertEqual(m["kit"], load(PLUGIN_JSON)["version"])
        facts = facts_from_fixture()
        self.assertEqual(m["checks"], facts["checks"])
        self.assertEqual(m["agents"], sorted(facts["agents"], key=lambda a: a["name"]))
        self.assertEqual(m["riskyPaths"], facts["riskyPaths"])
        self.assertEqual(m["setupScripts"], facts["setupScripts"])
        self.assertEqual(os.path.normcase(os.path.abspath(out["manifest"])), os.path.normcase(os.path.abspath(self.manifest)))
        self.assertIs(out["changed"], True)
        self.assertEqual(out["gates"], {"stop-gate.sh": "absent", "stop-gate.ps1": "absent"})

    def test_write_sorts_agents_by_name(self):
        facts = facts_from_fixture()
        facts["agents"] = list(reversed(facts["agents"]))
        self.ok_json(self.write(facts))
        names = [a["name"] for a in load(self.manifest)["agents"]]
        self.assertEqual(names, sorted(names))

    def test_write_bytes_are_lf_indent2_no_bom_one_trailing_newline(self):
        self.ok_json(self.write())
        raw = self.manifest_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "no BOM")
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"}\n") and not raw.endswith(b"\n\n"), "one trailing newline")
        text = raw.decode("utf-8")
        self.assertEqual(text, json.dumps(json.loads(text), indent=2) + "\n", "indent 2")

    def test_write_twice_is_byte_identical_and_reports_unchanged(self):
        self.ok_json(self.write())
        first = self.manifest_bytes()
        out = self.ok_json(self.write())
        self.assertEqual(self.manifest_bytes(), first)
        self.assertIs(out["changed"], False)

    def test_bad_input_exits_2_with_named_code_and_writes_nothing(self):
        bare_judge = facts_from_fixture()
        bare_judge["agents"].append({"name": "judge", "readOnly": True, "declaredBy": "foundry"})
        no_checks = facts_from_fixture()
        del no_checks["checks"]
        cases = [
            ("bare judge declared by foundry", "DECLARER_MISMATCH", bare_judge, None),
            ("missing checks", "MISSING_FIELD", no_checks, None),
            ("non-JSON facts file", "BAD_JSON", None, "{not json"),
        ]
        for label, code, facts, raw in cases:
            with self.subTest(label):
                r = self.write(facts if facts is not None else {}, raw=raw)
                self.assert_error(r, code, 2)
                self.assertFalse(os.path.exists(os.path.join(self.repo, ".claude")), "%s wrote something" % label)

    def test_bad_input_leaves_an_existing_manifest_untouched(self):
        self.ok_json(self.write())
        before = self.manifest_bytes()
        r = self.write(raw="{not json")
        self.assert_error(r, "BAD_JSON", 2)
        self.assertEqual(self.manifest_bytes(), before)

    def test_missing_repo_exits_3_no_repo(self):
        r = self.run_script("write", "--repo", os.path.join(self.tmp, "nope"), "--facts", self.facts_file(facts_from_fixture()))
        self.assert_error(r, "NO_REPO", 3)

    # ---------- declare ----------

    def test_declare_without_manifest_exits_3_no_manifest(self):
        r = self.declare("foundry", "foundry:judge")
        self.assert_error(r, "NO_MANIFEST", 3)
        self.assertFalse(os.path.exists(self.manifest))

    def test_declare_adds_read_only_agents_declared_by_the_plugin(self):
        self.ok_json(self.write())
        out = self.ok_json(self.declare("foundry", "foundry:judge,foundry:cynic"))
        self.assertIs(out["changed"], True)
        agents = load(self.manifest)["agents"]
        self.assertEqual([a["name"] for a in agents], sorted(a["name"] for a in agents))
        by_name = {a["name"]: a for a in agents}
        for name in ("foundry:judge", "foundry:cynic"):
            self.assertEqual(by_name.get(name), {"name": name, "readOnly": True, "declaredBy": "foundry"})
        for a in facts_from_fixture()["agents"]:
            self.assertEqual(by_name.get(a["name"]), a, "declare must leave other agents alone")

    def test_declare_twice_is_unchanged(self):
        self.ok_json(self.write())
        self.ok_json(self.declare("foundry", "foundry:judge"))
        first = self.manifest_bytes()
        out = self.ok_json(self.declare("foundry", "foundry:judge"))
        self.assertIs(out["changed"], False)
        self.assertEqual(self.manifest_bytes(), first)

    def test_declare_with_prefix_other_than_by_is_refused(self):
        self.ok_json(self.write())
        before = self.manifest_bytes()
        r = self.declare("foundry", "kit:sneaky")
        self.assert_error(r, "DECLARER_MISMATCH", 2)
        self.assertEqual(self.manifest_bytes(), before)

    def test_write_keeps_agents_another_plugin_declared(self):
        self.ok_json(self.write())
        self.ok_json(self.declare("foundry", "foundry:judge"))
        self.ok_json(self.write())  # facts don't name foundry:judge
        names = [a["name"] for a in load(self.manifest)["agents"]]
        self.assertIn("foundry:judge", names)

    # ---------- 2. stop-gate skip list ----------

    def gate_template(self):
        with open(HOOKS_REF, encoding="utf-8") as f:
            text = f.read().replace("\r\n", "\n")
        at = text.find("## `.claude/kit/stop-gate.sh`")
        self.assertNotEqual(at, -1, "hooks-reference.md has no stop-gate.sh section")
        m = re.search(r"```sh\n(.*?)\n```", text[at:], re.S)
        self.assertIsNotNone(m, "no sh block under the stop-gate.sh heading")
        return m.group(1).replace("<TEST_COMMAND>", "false") + "\n"

    def test_stop_gate_skips_declared_read_only_agent_and_tests_an_editing_one(self):
        bash = find_bash()
        if bash is None:
            self.skipTest("no bash on PATH: the stop-gate.sh template needs bash")
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: kit_manifest.py not found at %s" % SCRIPT)
        subprocess.run(["git", "init", "-q", self.repo], check=True, capture_output=True)
        self.ok_json(self.write())
        gate = os.path.join(self.repo, ".claude", "kit", "stop-gate.sh")
        template = self.gate_template()
        with open(gate, "w", encoding="utf-8", newline="\n") as f:
            f.write(template)

        out = self.ok_json(self.declare("foundry", "foundry:judge"))
        self.assertEqual(out["gates"]["stop-gate.sh"], "updated")
        self.assertEqual(out["gates"]["stop-gate.ps1"], "absent")
        again = self.ok_json(self.declare("foundry", "foundry:judge"))
        self.assertEqual(again["gates"]["stop-gate.sh"], "unchanged")

        with open(gate, encoding="utf-8") as f:
            rendered = f.read()
        self.assertIn(
            BEGIN + "\ncase \"$agent\" in Explore|Plan|claude-code-guide|foundry:judge|kit:reviewer|kit:scout) exit 0 ;; esac\n" + END,
            rendered,
        )

        def outside(t):
            return re.sub(re.escape(BEGIN) + r".*?" + re.escape(END), "", t, flags=re.S)

        self.assertEqual(outside(rendered), outside(template), "nothing outside the markers changes")

        def gate_exit(agent_type):
            return subprocess.run(
                [bash, ".claude/kit/stop-gate.sh"], cwd=self.repo, input=json.dumps({"agent_type": agent_type}),
                capture_output=True, text=True, timeout=60,
            ).returncode

        self.assertEqual(gate_exit("foundry:judge"), 0, "a declared read-only agent is skipped")
        self.assertEqual(gate_exit("kit:builder"), 2, "an editing agent is still tested (TEST_COMMAND is false)")


    # ---------- 3. ADR-0013 amendment: refused read-only types ----------
    # Names are listed literally (ADR-0013 "Seams added"). Error code: READ_ONLY_EDITING_TYPE.

    REFUSED = ("general-purpose", "kit:builder", "kit:test-writer", "foundry:architect",
               "foundry:devops", "foundry:lead", "foundry:writer")
    CODE = "READ_ONLY_EDITING_TYPE"

    @staticmethod
    def declarer(name):
        """The declaredBy a name's prefix needs, or 'project' for a bare name."""
        return name.split(":", 1)[0] if ":" in name else "project"

    @staticmethod
    def clean_facts(agents=None):
        """Inline facts for the refused-types cases (no fixture file), with no case-folded duplicate among the
        agents, so the refusal is the only bad-input code the script can reach."""
        return {
            "checks": [{"name": "unit", "kind": "test", "command": "npm test", "gate": "stop"}],
            "agents": agents if agents is not None else [
                {"name": "kit:reviewer", "readOnly": True, "declaredBy": "kit"},
                {"name": "kit:scout", "readOnly": True, "declaredBy": "kit"},
                {"name": "migrator", "readOnly": False, "declaredBy": "project"},
            ],
            "riskyPaths": [{"path": "db/migrations/", "why": "a wrong migration corrupts production data"}],
            "setupScripts": [".claude/worktree-setup.sh"],
        }

    def facts_with(self, name, read_only, declared_by=None):
        """Facts whose only agent is `name`, so no exact or case-folded duplicate exists."""
        return self.clean_facts([{"name": name, "readOnly": read_only, "declaredBy": declared_by or self.declarer(name)}])

    def store(self, extra_agents):
        """Write a good manifest, then add hand-written agents to it (bypassing the script's input guard)."""
        self.ok_json(self.write(self.clean_facts()))
        m = load(self.manifest)
        m["agents"] = sorted(m["agents"] + extra_agents, key=lambda a: a["name"])
        with open(self.manifest, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(m, indent=2) + "\n")
        return self.manifest_bytes()

    def warning(self, name, declared_by):
        return "kit_manifest: warning: dropped %s (declaredBy %s): READ_ONLY_EDITING_TYPE" % (name, declared_by)

    def test_write_refuses_each_refused_type_read_only(self):
        for name in self.REFUSED:
            with self.subTest(name):
                r = self.write(self.facts_with(name, True))
                self.assert_error(r, self.CODE, 2)
                self.assertIn(name, r.stderr)
                self.assertFalse(os.path.exists(os.path.join(self.repo, ".claude")), "%s wrote something" % name)

    def test_write_refusal_leaves_an_existing_manifest_untouched(self):
        self.ok_json(self.write(self.clean_facts()))
        before = self.manifest_bytes()
        r = self.write(self.facts_with("foundry:lead", True))
        self.assert_error(r, self.CODE, 2)
        self.assertEqual(self.manifest_bytes(), before)

    def test_write_refuses_casing_variants(self):
        # "Kit:Builder" cannot get past the declaredBy checks (its prefix must equal declaredBy, which the schema
        # lowercases), so the schema code wins there (see the next test); kit:BUILDER is the reachable kit variant.
        for name, by in (("kit:BUILDER", "kit"), ("General-Purpose", "project"), ("foundry:LEAD", "foundry"),
                         ("GENERAL-PURPOSE", "project")):
            with self.subTest(name):
                r = self.write(self.facts_with(name, True, by))
                self.assert_error(r, self.CODE, 2)
                self.assertIn(name, r.stderr, "the detail names the refused name as given")

    def test_kit_builder_mixed_case_is_never_accepted(self):
        for by in ("Kit", "kit"):
            with self.subTest(by):
                r = self.write(self.facts_with("Kit:Builder", True, by))
                self.assertEqual(r.returncode, 2, "stderr: %s" % r.stderr)
                self.assertFalse(os.path.exists(os.path.join(self.repo, ".claude")))

    def test_other_bad_input_codes_win_over_the_refusal(self):
        facts = self.facts_with("foundry:lead", True, "kit")  # refused name AND declarer mismatch
        self.assert_error(self.write(facts), "DECLARER_MISMATCH", 2)
        facts = self.facts_with("foundry:lead", True)
        facts["agents"][-1]["extra"] = 1  # unknown key: BAD_FIELD
        self.assert_error(self.write(facts), "BAD_FIELD", 2)

    def test_refused_types_at_read_only_false_write_fine(self):
        for name in self.REFUSED:
            with self.subTest(name):
                self.ok_json(self.write(self.facts_with(name, False)))
                entry = [a for a in load(self.manifest)["agents"] if a["name"] == name]
                self.assertEqual(entry, [{"name": name, "readOnly": False, "declaredBy": self.declarer(name)}])

    def test_lookalikes_at_read_only_true_write_fine(self):
        for name, by in (("plugin:general-purpose", "plugin"), ("kit:builder2", "kit"), ("builder", "project")):
            with self.subTest(name):
                self.ok_json(self.write(self.facts_with(name, True, by)))
                self.assertIn({"name": name, "readOnly": True, "declaredBy": by}, load(self.manifest)["agents"])

    def test_declare_refuses_refused_names_with_and_without_a_manifest(self):
        for by, name in (("foundry", "foundry:lead"), ("foundry", "foundry:LEAD"), ("foundry", "foundry:architect"),
                         ("foundry", "foundry:devops"), ("foundry", "foundry:writer"),
                         ("kit", "kit:builder"), ("kit", "kit:test-writer")):
            with self.subTest("no manifest " + name):
                r = self.declare(by, name)
                self.assert_error(r, self.CODE, 2)
                self.assertIn(name, r.stderr)
                self.assertFalse(os.path.exists(self.manifest))
        self.ok_json(self.write(self.clean_facts()))
        before = self.manifest_bytes()
        for by, name in (("foundry", "foundry:lead"), ("foundry", "foundry:LEAD"), ("kit", "kit:test-writer"),
                         ("foundry", "foundry:judge,foundry:lead")):
            with self.subTest("manifest " + name):
                self.assert_error(self.declare(by, name), self.CODE, 2)
                self.assertEqual(self.manifest_bytes(), before)

    def test_declare_qualified_prefix_mismatch_beats_the_refusal(self):
        self.ok_json(self.write(self.clean_facts()))
        self.assert_error(self.declare("foundry", "Foundry:Lead"), "DECLARER_MISMATCH", 2)

    def test_declare_non_refused_name_still_works(self):
        self.ok_json(self.write(self.clean_facts()))
        self.ok_json(self.declare("foundry", "foundry:judge"))
        self.assertIn("foundry:judge", [a["name"] for a in load(self.manifest)["agents"]])

    def test_stored_refused_read_only_entry_reads_fine_and_plain_write_repairs_it(self):
        self.store([{"name": "general-purpose", "readOnly": True, "declaredBy": "project"}])
        r = self.write(self.clean_facts())
        out = self.ok_json(r)  # not MANIFEST_CORRUPT (exit 3)
        self.assertIs(out["changed"], True)
        bad = [a for a in load(self.manifest)["agents"] if a["readOnly"] and a["name"].casefold() in self.REFUSED]
        self.assertEqual(bad, [])
        self.assertNotIn("dropped", r.stderr, "kit/project entries are replaced by the facts, not dropped")

    def test_carried_over_refused_entry_is_dropped_by_write(self):
        self.store([{"name": "foundry:lead", "readOnly": True, "declaredBy": "foundry"}])
        r = self.write(self.clean_facts())
        out = self.ok_json(r)
        self.assertIs(out["changed"], True)
        self.assertNotIn("foundry:lead", [a["name"] for a in load(self.manifest)["agents"]])
        self.assertEqual(r.stderr.strip().splitlines(), [self.warning("foundry:lead", "foundry")])

    def test_carried_over_refused_entry_is_dropped_by_declare(self):
        self.store([{"name": "foundry:lead", "readOnly": True, "declaredBy": "foundry"}])
        r = self.declare("foundry", "foundry:judge")
        out = self.ok_json(r)
        self.assertIs(out["changed"], True)
        names = [a["name"] for a in load(self.manifest)["agents"]]
        self.assertNotIn("foundry:lead", names)
        self.assertIn("foundry:judge", names)
        self.assertEqual(r.stderr.strip().splitlines(), [self.warning("foundry:lead", "foundry")])

    def test_several_dropped_entries_warn_in_stored_order(self):
        self.store([{"name": "foundry:writer", "readOnly": True, "declaredBy": "foundry"},
                    {"name": "foundry:architect", "readOnly": True, "declaredBy": "foundry"}])
        r = self.write(self.clean_facts())
        self.ok_json(r)
        self.assertEqual(r.stderr.strip().splitlines(),
                         [self.warning("foundry:architect", "foundry"), self.warning("foundry:writer", "foundry")])

    def test_carried_over_refused_name_at_read_only_false_is_kept(self):
        self.store([{"name": "foundry:lead", "readOnly": False, "declaredBy": "foundry"}])
        r = self.write(self.clean_facts())
        self.ok_json(r)
        self.assertIn({"name": "foundry:lead", "readOnly": False, "declaredBy": "foundry"}, load(self.manifest)["agents"])
        self.assertNotIn("dropped", r.stderr)

    def test_stop_gate_skip_line_never_names_a_refused_type(self):
        subprocess.run(["git", "init", "-q", self.repo], check=True, capture_output=True)
        self.store([{"name": "foundry:lead", "readOnly": True, "declaredBy": "foundry"},
                    {"name": "foundry:writer", "readOnly": True, "declaredBy": "foundry"},
                    {"name": "foundry:judge", "readOnly": True, "declaredBy": "foundry"}])
        gate = os.path.join(self.repo, ".claude", "kit", "stop-gate.sh")
        with open(gate, "w", encoding="utf-8", newline="\n") as f:
            f.write(self.gate_template())
        out = self.ok_json(self.write(self.clean_facts()))
        self.assertEqual(out["gates"]["stop-gate.sh"], "updated")
        with open(gate, encoding="utf-8") as f:
            rendered = f.read()
        m = re.search(re.escape(BEGIN) + r"\n(.*?)\n" + re.escape(END), rendered, re.S)
        self.assertIsNotNone(m, "markers missing in rendered gate")
        for name in self.REFUSED:
            self.assertNotIn(name, m.group(1), "skip line names %s" % name)
        self.assertIn("foundry:judge", m.group(1), "a legitimate read-only type is still skipped")

    def test_error_text_carries_the_code_literally(self):
        r = self.write(self.facts_with("kit:builder", True))
        self.assertTrue(r.stderr.startswith("kit_manifest: READ_ONLY_EDITING_TYPE: "), "stderr: %r" % r.stderr)


if __name__ == "__main__":
    unittest.main()
