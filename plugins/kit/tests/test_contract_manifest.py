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


if __name__ == "__main__":
    unittest.main()
