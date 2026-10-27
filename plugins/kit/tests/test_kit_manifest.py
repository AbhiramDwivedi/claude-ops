"""Edge cases for kit_manifest.py beyond the ADR-0013 contract test (test_contract_manifest.py).

Run: python -m unittest discover -s plugins/kit/tests
"""
import contextlib
import getpass
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

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

    def test_any_number_above_1_is_a_newer_version(self):
        with open(FIXTURE, "rb") as f:
            fixture = f.read()
        cases = [("2.0", "NEWER_VERSION"), ("1.5", "NEWER_VERSION"), ("2", "NEWER_VERSION"),
                 ("true", "MANIFEST_CORRUPT"), ("0.5", "MANIFEST_CORRUPT")]
        for version, code in cases:
            with self.subTest(version=version):
                data = fixture.replace(b'"version": 1,', b'"version": ' + version.encode() + b",")
                self.put("manifest.json", data)
                self.err(self.declare("foundry", "foundry:judge"), code, 3)
                self.assertEqual(self.raw(self.manifest), data)
        with self.subTest(version="1.0"):  # ajv's const accepts 1.0, so the script does too
            self.put("manifest.json", fixture.replace(b'"version": 1,', b'"version": 1.0,'))
            self.ok(self.declare("foundry", "foundry:judge"))

    def test_infinity_and_nan_are_not_json(self):
        with open(FIXTURE, "rb") as f:
            fixture = f.read()
        for constant in ("Infinity", "-Infinity", "NaN"):
            with self.subTest(constant=constant):
                facts = json.dumps(fixture_facts()).replace('"checks": [', '"checks": [%s, ' % constant, 1)
                self.err(self.run_script("write", "--repo", self.repo, "--facts", "-", stdin=facts), "BAD_JSON", 2)
                data = fixture.replace(b'"version": 1,', b'"version": ' + constant.encode() + b",")
                self.put("manifest.json", data)
                for r in (self.write(), self.declare("foundry", "foundry:judge")):
                    self.err(r, "MANIFEST_CORRUPT", 3)
                    self.assertIn("isn't JSON", r.stderr)
                    self.assertEqual(self.raw(self.manifest), data)

    @unittest.skipIf(os.name != "nt" and os.geteuid() == 0, "root reads a mode-000 file")
    def test_unreadable_manifest_is_an_io_error_not_corrupt(self):
        self.put("stop-gate.sh", self.SH.encode())
        self.ok(self.write())
        if os.name == "nt":
            user = getpass.getuser()
            subprocess.run(["icacls", self.manifest, "/deny", user + ":(R)"], check=True, capture_output=True)
            self.addCleanup(subprocess.run, ["icacls", self.manifest, "/remove:d", user], capture_output=True)
        else:
            os.chmod(self.manifest, 0)
            self.addCleanup(os.chmod, self.manifest, 0o644)
        before = self.snapshot()
        for r in (self.write(), self.declare("foundry", "foundry:judge")):
            self.err(r, "IO_ERROR", 1)
            self.assertIn("can't read %s: " % self.manifest, r.stderr)
            self.assertEqual(self.snapshot(), before)

    def test_deeply_nested_json_is_one_line_not_a_traceback(self):
        deep = "[" * 200000 + "]" * 200000
        self.err(self.run_script("write", "--repo", self.repo, "--facts", "-", stdin=deep), "BAD_JSON", 2)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".claude")))
        self.put("manifest.json", deep.encode())
        for r in (self.write(), self.declare("foundry", "foundry:judge")):
            self.err(r, "MANIFEST_CORRUPT", 3)
            self.assertEqual(sorted(os.listdir(self.kitdir)), ["manifest.json"])
            self.assertEqual(self.raw(self.manifest), deep.encode())

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

    # ---------- the OS refusing a read or write ----------

    def snapshot(self):
        """Every file in .claude/kit with its bytes (None when unreadable)."""
        out = {}
        for name in sorted(os.listdir(self.kitdir)):
            try:
                out[name] = self.raw(os.path.join(self.kitdir, name))
            except OSError:
                out[name] = None
        return out

    def three_files(self):
        """A manifest and both gates, and a snapshot of them, before a declare that changes all three."""
        self.put("stop-gate.sh", self.SH.encode())
        self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        self.ok(self.write())
        return self.snapshot()

    @unittest.skipIf(os.name != "nt", "a POSIX rename replaces a read-only file; Windows refuses it")
    def test_read_only_gate_fails_declare_and_changes_nothing(self):
        before = self.three_files()
        ps1 = os.path.join(self.kitdir, "stop-gate.ps1")
        os.chmod(ps1, stat.S_IREAD)
        self.addCleanup(os.chmod, ps1, stat.S_IREAD | stat.S_IWRITE)
        r = self.declare("foundry", "foundry:judge")
        self.err(r, "IO_ERROR", 1)
        self.assertIn("stop-gate.ps1: ", r.stderr)
        self.assertNotIn(".tmp", r.stderr, "the error names the gate, not a temp file")
        self.assertEqual(self.snapshot(), before, "manifest and stop-gate.sh restored, no .tmp left")

    @unittest.skipIf(os.name != "nt" and os.geteuid() == 0, "root reads a mode-000 file")
    def test_unreadable_gate_is_one_line_and_changes_nothing(self):
        before = self.three_files()
        ps1 = os.path.join(self.kitdir, "stop-gate.ps1")
        if os.name == "nt":
            user = getpass.getuser()
            subprocess.run(["icacls", ps1, "/deny", user + ":(R)"], check=True, capture_output=True)
            self.addCleanup(subprocess.run, ["icacls", ps1, "/remove:d", user], capture_output=True)
        else:
            os.chmod(ps1, 0)
            self.addCleanup(os.chmod, ps1, 0o644)
        before["stop-gate.ps1"] = None
        r = self.declare("foundry", "foundry:judge")
        self.err(r, "IO_ERROR", 1)
        self.assertIn("can't read %s: " % ps1, r.stderr)
        self.assertEqual(self.snapshot(), before)

    def in_process(self, *args):
        """Run main() in this process, so a test can make one OS call fail; returns (exit, stderr)."""
        spec = importlib.util.spec_from_file_location("kit_manifest_under_test", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = mod.main(list(args))
        self.out = out.getvalue()
        return mod, code, err.getvalue()

    def fail_nth(self, real, n):
        """real, but the nth call (1-based) raises PermissionError."""
        calls = []

        def fake(*a, **k):
            calls.append(a)
            if len(calls) == n:
                raise PermissionError(13, "Permission denied")
            return real(*a, **k)
        return fake

    def test_failed_rename_restores_the_files_already_replaced(self):
        before = self.three_files()
        for n in (1, 2, 3):  # manifest, stop-gate.sh, stop-gate.ps1
            with self.subTest(failing_rename=n), mock.patch("os.replace", self.fail_nth(os.replace, n)):
                _, code, err = self.in_process("declare", "--repo", self.repo, "--by", "foundry",
                                               "--read-only", "foundry:judge")
                self.assertEqual(code, 1, err)
                self.assertRegex(err, r"^kit_manifest: IO_ERROR: can't write .*(manifest\.json|stop-gate\.(sh|ps1)): "
                                      r"Permission denied\n$")
                self.assertEqual(self.snapshot(), before)

    def test_failed_temp_write_changes_nothing(self):
        before = self.three_files()
        for n in range(1, 7):  # new + backup temp for each of the three files
            with self.subTest(failing_temp=n), mock.patch("tempfile.mkstemp", self.fail_nth(tempfile.mkstemp, n)):
                _, code, err = self.in_process("declare", "--repo", self.repo, "--by", "foundry",
                                               "--read-only", "foundry:judge")
                self.assertEqual(code, 1, err)
                self.assertTrue(err.startswith("kit_manifest: IO_ERROR: can't write "), err)
                self.assertEqual(self.snapshot(), before)

    def test_no_os_error_escapes_as_a_traceback(self):
        self.three_files()
        with mock.patch("os.path.isdir", side_effect=OSError(5, "I/O error")):
            _, code, err = self.in_process("declare", "--repo", self.repo, "--by", "foundry", "--read-only", "foundry:judge")
        self.assertEqual((code, err), (1, "kit_manifest: IO_ERROR: [Errno 5] I/O error\n"))

    def fail_from(self, real, n):
        """real, but every call from the nth (1-based) on raises PermissionError."""
        calls = []

        def fake(*a, **k):
            calls.append(a)
            if len(calls) >= n:
                raise PermissionError(13, "Permission denied")
            return real(*a, **k)
        return fake

    def declare_in_process(self):
        return self.in_process("declare", "--repo", self.repo, "--by", "foundry", "--read-only", "foundry:judge")

    def temps(self):
        return sorted(n for n in os.listdir(self.kitdir) if n.endswith(".tmp"))

    def test_one_failed_backup_removal_is_retried(self):
        self.three_files()
        with mock.patch("os.remove", self.fail_nth(os.remove, 1)):  # the first backup's removal, after every rename
            _, code, err = self.declare_in_process()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(self.out)["gates"], {"stop-gate.sh": "updated", "stop-gate.ps1": "updated"})
        self.assertEqual(self.temps(), [])
        self.assertTrue(self.agents()["foundry:judge"]["readOnly"])

    def test_backup_left_after_a_complete_write_is_a_warning_not_an_error(self):
        self.three_files()
        with mock.patch("os.remove", self.fail_from(os.remove, 1)):
            _, code, err = self.declare_in_process()
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(self.out)["gates"], {"stop-gate.sh": "updated", "stop-gate.ps1": "updated"})
        self.assertRegex(err, r"^kit_manifest: warning: wrote everything, but left [^\n]*\.tmp: Permission denied\n$")
        self.assertEqual(len(self.temps()), 3)  # a backup per file, each named in the warning
        for name in self.temps():
            self.assertIn(os.path.join(self.kitdir, name) + ": Permission denied", err)
        for name in self.temps():
            os.remove(os.path.join(self.kitdir, name))
        again = self.ok(self.declare("foundry", "foundry:judge"))  # every file already holds its new bytes
        self.assertEqual((again["changed"], again["gates"]), (False, {"stop-gate.sh": "unchanged",
                                                                      "stop-gate.ps1": "unchanged"}))

    def test_backup_whose_restore_failed_is_kept_and_named(self):
        before = self.three_files()
        # The third rename (stop-gate.ps1) fails, and so does every rename that would restore the other two.
        with mock.patch("os.replace", self.fail_from(os.replace, 3)):
            _, code, err = self.declare_in_process()
        self.assertEqual(code, 1, err)
        self.assertTrue(err.startswith("kit_manifest: IO_ERROR: can't write "), err)
        self.assertEqual(len(err.splitlines()), 1, err)
        kept = {}
        for target, backup in re.findall(
                r"; ([^;]+) now holds the new bytes \(couldn't restore it: Permission denied\), "
                r"old bytes kept in ([^;\n]+)", err):
            kept[os.path.basename(target)] = backup
        self.assertEqual(sorted(kept), ["manifest.json", "stop-gate.sh"])
        for name, backup in kept.items():
            self.assertEqual(self.raw(backup), before[name])
        self.assertEqual(sorted(os.path.join(self.kitdir, n) for n in self.temps()), sorted(kept.values()))
        self.assertEqual(self.raw(os.path.join(self.kitdir, "stop-gate.ps1")), before["stop-gate.ps1"])

    def test_temp_left_by_a_failed_stage_is_reported(self):
        self.three_files()
        with mock.patch("shutil.copymode", self.fail_nth(shutil.copymode, 1)), \
                mock.patch("os.remove", self.fail_from(os.remove, 1)):
            _, code, err = self.declare_in_process()
        self.assertEqual(code, 1, err)
        [left] = self.temps()
        self.assertRegex(err, r"^kit_manifest: IO_ERROR: can't write [^\n]*manifest\.json: Permission denied; left "
                              r"[^\n]*\.tmp: Permission denied\n$")
        self.assertIn(os.path.join(self.kitdir, left), err)

    def test_failed_first_write_names_the_manifest_it_could_not_remove(self):
        self.put("stop-gate.sh", self.SH.encode())
        self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        before = self.snapshot()
        # The manifest is renamed into place, stop-gate.sh's rename fails, and so does removing the new manifest.
        with mock.patch("os.replace", self.fail_from(os.replace, 2)), mock.patch("os.remove", self.fail_from(os.remove, 1)):
            _, code, err = self.in_process("write", "--repo", self.repo, "--facts", self.facts_file())
        self.assertEqual(code, 1, err)
        self.assertIn("; %s now holds the new bytes (couldn't remove it: Permission denied)" % self.manifest, err)
        self.assertEqual(self.raw(self.manifest), self.clean_run(before, "write")["manifest.json"])
        for gate in ("stop-gate.sh", "stop-gate.ps1"):
            self.assertEqual(self.raw(os.path.join(self.kitdir, gate)), before[gate])

    def test_every_failed_write_names_exactly_the_files_holding_new_bytes(self):
        """Fault the renames and removals many ways; the line's claims must match the bytes on disk."""
        self.put("stop-gate.sh", self.SH.encode())
        self.put("stop-gate.ps1", self.PS1.encode("utf-8"))
        gates_only = self.snapshot()
        self.ok(self.write())
        with_manifest = self.snapshot()
        faults = [("replace#%d" % n, [("replace", self.fail_nth, n)]) for n in (1, 2, 3)]
        faults += [("replace#%d+" % n, [("replace", self.fail_from, n)]) for n in (1, 2, 3, 4)]
        faults += [(label + ",remove+", fs + [("remove", self.fail_from, 1)]) for label, fs in list(faults)]
        failed = 0
        for command, before in (("declare", with_manifest), ("write", gates_only)):
            new = self.clean_run(before, command)
            for label, fs in faults:
                with self.subTest(command=command, faults=label):
                    self.reset(before)
                    args = (["declare", "--repo", self.repo, "--by", "foundry", "--read-only", "foundry:judge"]
                            if command == "declare" else ["write", "--repo", self.repo, "--facts", self.facts_file()])
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(mock.patch("time.sleep"))  # retried's pauses only slow the sweep
                        for name, how, n in fs:  # each os call fails as how says
                            stack.enter_context(mock.patch.object(os, name, how(getattr(os, name), n)))
                        _, code, err = self.in_process(*args)
                    if code != 0:
                        failed += 1
                        self.assert_claims_match_disk(err, before, new)
        self.assertGreater(failed, 20)

    def facts_file(self):
        path = os.path.join(self.tmp, "facts.json")
        facts = fixture_facts()
        facts["agents"] = [a for a in facts["agents"] if a["declaredBy"] in ("kit", "project")]
        facts["agents"].append({"name": "newone", "readOnly": True, "declaredBy": "project"})
        with open(path, "w", encoding="utf-8") as f:
            json.dump(facts, f)
        return path

    def reset(self, files):
        shutil.rmtree(self.kitdir)
        for name, data in files.items():
            self.put(name, data)

    def clean_run(self, before, command):
        """The bytes each file in .claude/kit holds after the command runs with no faults, from before."""
        self.reset(before)
        args = (["declare", "--repo", self.repo, "--by", "foundry", "--read-only", "foundry:judge"]
                if command == "declare" else ["write", "--repo", self.repo, "--facts", self.facts_file()])
        _, code, err = self.in_process(*args)
        self.assertEqual((code, err), (0, ""))
        after = self.snapshot()
        self.assertTrue(all(after[n] != before.get(n) for n in after), "a clean run changes every file")
        self.reset(before)
        return after

    def assert_claims_match_disk(self, err, before, new):
        """Every file the line names as holding new bytes does, with its old bytes where it says; nothing else changed."""
        self.assertTrue(err.startswith("kit_manifest: IO_ERROR: can't write "), err)
        self.assertEqual(len(err.splitlines()), 1, err)
        clauses = err.rstrip("\n").split("; ")[1:]
        claimed, kept, left = set(), set(), set()
        for clause in clauses:
            m = re.fullmatch(r"(.+) now holds the new bytes \(couldn't (restore|remove) it: Permission denied\)"
                             r"(?:, old bytes kept in (.+))?", clause)
            if m:
                path, verb, backup = m.groups()
                name = os.path.relpath(path, self.kitdir)
                claimed.add(name)
                self.assertEqual(self.raw(path), new[name], clause)
                self.assertEqual(verb == "remove", name not in before, clause)
                self.assertEqual(backup is None, name not in before, clause)
                if backup:
                    self.assertEqual(self.raw(backup), before[name], clause)
                    kept.add(os.path.basename(backup))
                continue
            m = re.fullmatch(r"left (.+\.tmp): Permission denied", clause)
            self.assertIsNotNone(m, "a clause that is neither a claim nor a leftover: %r" % clause)
            self.assertTrue(os.path.exists(m.group(1)), clause)
            left.add(os.path.basename(m.group(1)))
        for name in new:
            if name not in claimed:
                self.assertEqual(self.snapshot().get(name), before.get(name), "%s changed but isn't named: %s" % (name, err))
        self.assertEqual(set(self.temps()), kept | left, err)

    def test_details_keep_their_spaces_but_not_their_line_breaks(self):
        spaced = os.path.join(self.tmp, "two  spaces   three")
        os.makedirs(spaced)
        r = self.run_script("declare", "--repo", spaced, "--by", "foundry", "--read-only", "foundry:judge")
        self.err(r, "NO_MANIFEST", 3)
        self.assertIn(os.path.join(spaced, ".claude", "kit", "manifest.json") + " doesn't exist", r.stderr)
        with mock.patch("os.path.isdir", side_effect=OSError(5, "I/O\r\n\nerror  here")):
            _, code, err = self.declare_in_process()
        self.assertEqual((code, err), (1, "kit_manifest: IO_ERROR: [Errno 5] I/O error  here\n"))

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
