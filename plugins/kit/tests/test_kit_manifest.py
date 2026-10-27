"""Edge cases for kit_manifest.py beyond the ADR-0013 contract test (test_contract_manifest.py).

Run: python -m unittest discover -s plugins/kit/tests
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "kit_manifest.py")
FIXTURE = os.path.join(HERE, "fixtures", "manifest.json")
BEGIN = "# kit:read-only-agents:begin"
END = "# kit:read-only-agents:end"


def fixture_facts():
    with open(FIXTURE, encoding="utf-8") as f:
        m = json.load(f)
    return {k: m[k] for k in ("checks", "agents", "riskyPaths", "setupScripts")}


class KitManifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kit-manifest-")
        self.repo = os.path.join(self.tmp, "repo")
        self.kitdir = os.path.join(self.repo, ".claude", "kit")
        os.makedirs(self.repo)
        self.manifest = os.path.join(self.kitdir, "manifest.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, *args, stdin=None):
        return subprocess.run([sys.executable, SCRIPT] + list(args), input=stdin, capture_output=True,
                              text=True, encoding="utf-8", timeout=60)

    def write(self, facts=None):
        return self.run_script("write", "--repo", self.repo, "--facts", "-",
                               stdin=json.dumps(facts if facts is not None else fixture_facts()))

    def declare(self, by, names):
        return self.run_script("declare", "--repo", self.repo, "--by", by, "--read-only", names)

    def ok(self, r):
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def err(self, r, code, exit_code):
        self.assertEqual(r.returncode, exit_code, r.stderr)
        self.assertTrue(r.stderr.startswith("kit_manifest: %s: " % code), r.stderr)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1, r.stderr)
        self.assertEqual(r.stdout, "")

    def put(self, name, data):
        os.makedirs(self.kitdir, exist_ok=True)
        path = os.path.join(self.kitdir, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def raw(self, path):
        with open(path, "rb") as f:
            return f.read()

    def agents(self):
        with open(self.manifest, encoding="utf-8") as f:
            return {a["name"]: a for a in json.load(f)["agents"]}

    # ---------- existing manifest state ----------

    def test_existing_manifest_that_is_broken_is_corrupt_and_left_alone(self):
        cases = [("empty", b""), ("not JSON", b"{nope"), ("array", b"[]"), ("missing field", b'{"version": 1}'),
                 ("bad agent", json.dumps(dict(version=1, kit="0.2.0", checks=[], riskyPaths=[], setupScripts=[],
                                               agents=[{"name": "a b", "readOnly": True, "declaredBy": "project"}])).encode())]
        for label, data in cases:
            with self.subTest(label):
                self.put("manifest.json", data)
                for r in (self.write(), self.declare("foundry", "foundry:judge")):
                    self.err(r, "MANIFEST_CORRUPT", 3)
                    self.assertEqual(self.raw(self.manifest), data)

    def test_newer_version_is_refused(self):
        data = json.dumps({"version": 2, "whatever": True}).encode()
        self.put("manifest.json", data)
        self.err(self.write(), "NEWER_VERSION", 3)
        self.err(self.declare("foundry", "foundry:judge"), "NEWER_VERSION", 3)
        self.assertEqual(self.raw(self.manifest), data)

    # ---------- bad input ----------

    def test_bad_facts_codes(self):
        def facts(**change):
            f = fixture_facts()
            f.update(change)
            return f
        agent = lambda name, by, ro=True: {"name": name, "readOnly": ro, "declaredBy": by}
        cases = [
            ("unknown top-level key", "BAD_FIELD", facts(extra=1)),
            ("not an object", "BAD_FIELD", []),
            ("bad kind", "BAD_FIELD", facts(checks=[{"name": "x", "kind": "fmt", "command": "c", "gate": "stop"}])),
            ("check missing gate", "MISSING_FIELD", facts(checks=[{"name": "x", "kind": "test", "command": "c"}])),
            ("multi-line command", "BAD_FIELD", facts(checks=[{"name": "x", "kind": "test", "command": "a\nb", "gate": "stop"}])),
            ("readOnly not bool", "BAD_FIELD", facts(agents=[agent("kit:scout", "kit", 1)])),
            ("shell metacharacter", "BAD_AGENT_NAME", facts(agents=[agent("kit:x;rm", "kit")])),
            ("trailing newline", "BAD_AGENT_NAME", facts(agents=[agent("kit:x\n", "kit")])),
            ("bare name not project", "DECLARER_MISMATCH", facts(agents=[agent("judge", "foundry")])),
            ("prefix not declarer", "DECLARER_MISMATCH", facts(agents=[agent("foundry:judge", "kit")])),
            ("case-folded duplicate", "DUPLICATE_AGENT", facts(agents=[agent("kit:scout", "kit"), agent("kit:Scout", "kit")])),
            ("unknown setup script", "BAD_FIELD", facts(setupScripts=["setup.sh"])),
            ("repeated setup script", "BAD_FIELD", facts(setupScripts=[".claude/worktree-setup.sh"] * 2)),
        ]
        for label, code, f in cases:
            with self.subTest(label):
                self.err(self.write(f), code, 2)
                self.assertFalse(os.path.exists(os.path.join(self.repo, ".claude")))

    def test_bad_args_is_one_line(self):
        self.err(self.run_script("write", "--repo", self.repo), "BAD_ARGS", 2)
        self.err(self.run_script("frobnicate"), "BAD_ARGS", 2)
        self.err(self.run_script(), "BAD_ARGS", 2)
        self.err(self.run_script("write", "--repo", self.repo, "--facts", os.path.join(self.tmp, "none.json")), "BAD_ARGS", 2)

    def test_declare_refusals(self):
        self.ok(self.write())
        before = self.raw(self.manifest)
        for label, by, names, code in [
            ("bare name for a plugin", "foundry", "judge", "DECLARER_MISMATCH"),
            ("one of two mismatched", "foundry", "foundry:judge,other:cynic", "DECLARER_MISMATCH"),
            ("bad name", "foundry", "foundry:ju dge", "BAD_AGENT_NAME"),
            ("case-folded twice", "foundry", "foundry:judge,foundry:JUDGE", "DUPLICATE_AGENT"),
            ("empty name", "foundry", "foundry:judge,", "BAD_ARGS"),
            ("upper-case --by", "Foundry", "Foundry:judge", "BAD_ARGS"),
        ]:
            with self.subTest(label):
                self.err(self.declare(by, names), code, 2)
                self.assertEqual(self.raw(self.manifest), before)

    # ---------- merging ----------

    def test_declare_updates_an_existing_entry_to_read_only(self):
        f = fixture_facts()
        f["agents"].append({"name": "migrator2", "readOnly": False, "declaredBy": "project"})
        self.ok(self.write(f))
        out = self.ok(self.declare("project", "migrator"))
        self.assertIs(out["changed"], True)
        self.assertEqual(self.agents()["migrator"], {"name": "migrator", "readOnly": True, "declaredBy": "project"})
        self.assertFalse(self.agents()["migrator2"]["readOnly"])

    def test_write_keeps_foreign_declarers_but_replaces_kit_and_project_agents(self):
        self.ok(self.write())
        self.ok(self.declare("foundry", "foundry:judge,foundry:cynic"))
        f = fixture_facts()
        f["agents"] = [a for a in f["agents"] if a["name"] not in ("migrator", "kit:scout")]
        f["agents"].append({"name": "foundry:cynic", "readOnly": False, "declaredBy": "foundry"})  # facts name it
        self.ok(self.write(f))
        agents = self.agents()
        self.assertNotIn("migrator", agents)
        self.assertNotIn("kit:scout", agents)
        self.assertTrue(agents["foundry:judge"]["readOnly"])
        self.assertFalse(agents["foundry:cynic"]["readOnly"], "facts that name a foreign agent win")

    def test_write_with_a_case_variant_of_a_foreign_agent_does_not_duplicate_it(self):
        self.ok(self.write())
        self.ok(self.declare("foundry", "foundry:judge"))
        f = fixture_facts()
        f["agents"].append({"name": "foundry:Judge", "readOnly": True, "declaredBy": "foundry"})
        self.ok(self.write(f))
        self.assertEqual([n for n in self.agents() if n.lower() == "foundry:judge"], ["foundry:Judge"])

    # ---------- gates ----------

    SH = ("#!/usr/bin/env bash\nagent=x\n" + BEGIN + "\ncase \"$agent\" in Explore|Plan|claude-code-guide|kit:reviewer|kit:scout)"
          " exit 0 ;; esac\n" + END + "\necho tested\n")
    PS1 = ("﻿$in = [Console]::In.ReadToEnd() | ConvertFrom-Json\r\n" + BEGIN + "\r\nif ($in.agent_type -in 'Explore',"
           "'Plan','claude-code-guide','kit:reviewer','kit:scout') { exit 0 }\r\n" + END + "\r\nexit 2\r\n")

    def test_ps1_rendered_with_crlf_and_bom_kept(self):
        ps1 = self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        self.ok(self.write())
        self.assertEqual(self.ok(self.declare("foundry", "foundry:judge"))["gates"]["stop-gate.ps1"], "updated")
        want = self.PS1.replace("'claude-code-guide',", "'claude-code-guide','foundry:judge',").encode("utf-8")
        self.assertEqual(self.raw(ps1), want, "only the marked line changes; CRLF and BOM stay")

    def test_template_list_is_what_a_fresh_write_renders(self):
        sh = self.put("stop-gate.sh", self.SH.encode())
        ps1 = self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        out = self.ok(self.write())
        self.assertEqual(out["gates"], {"stop-gate.sh": "unchanged", "stop-gate.ps1": "unchanged"})
        self.assertEqual(self.raw(sh), self.SH.encode())
        self.assertEqual(self.raw(ps1), self.PS1.encode("utf-8"))

    def test_built_ins_first_and_case_folded_once(self):
        f = fixture_facts()
        f["agents"] += [{"name": "explore", "readOnly": True, "declaredBy": "project"},
                        {"name": "aaa", "readOnly": True, "declaredBy": "project"}]
        sh = self.put("stop-gate.sh", self.SH.encode())
        self.ok(self.write(f))
        self.assertIn("case \"$agent\" in Explore|Plan|claude-code-guide|aaa|kit:reviewer|kit:scout) exit 0", self.raw(sh).decode())

    def test_gate_without_markers_or_with_two_begins_is_left_alone(self):
        for label, text in [("no markers", "case \"$agent\" in kit:scout) exit 0 ;; esac\n"),
                            ("two begins", BEGIN + "\n" + BEGIN + "\nx\n" + END + "\n"),
                            ("end before begin", END + "\nx\n" + BEGIN + "\n")]:
            with self.subTest(label):
                sh = self.put("stop-gate.sh", text.encode())
                self.assertEqual(self.ok(self.write())["gates"]["stop-gate.sh"], "no-markers")
                self.assertEqual(self.raw(sh), text.encode())

    @unittest.skipIf(os.name == "nt", "file modes are POSIX-only")
    def test_gate_keeps_its_executable_bit(self):
        sh = self.put("stop-gate.sh", self.SH.encode())
        os.chmod(sh, 0o755)
        self.ok(self.write())
        self.ok(self.declare("foundry", "foundry:judge"))
        self.assertTrue(os.stat(sh).st_mode & stat.S_IXUSR)

    def test_no_temp_files_left_behind(self):
        self.put("stop-gate.sh", self.SH.encode())
        self.ok(self.write())
        self.ok(self.declare("foundry", "foundry:judge"))
        self.assertEqual(sorted(os.listdir(self.kitdir)), ["manifest.json", "stop-gate.sh"])

    @unittest.skipIf(shutil.which("pwsh") is None, "no pwsh on PATH")
    def test_rendered_ps1_skips_declared_agent_case_insensitively(self):
        ps1 = self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        self.ok(self.write())
        self.ok(self.declare("foundry", "foundry:judge"))

        def gate_exit(agent_type):
            return subprocess.run(["pwsh", "-NoProfile", "-File", ps1], input=json.dumps({"agent_type": agent_type}),
                                  capture_output=True, text=True, timeout=120).returncode

        self.assertEqual(gate_exit("foundry:judge"), 0)
        self.assertEqual(gate_exit("Foundry:Judge"), 0)
        self.assertEqual(gate_exit("kit:builder"), 2)


if __name__ == "__main__":
    unittest.main()
