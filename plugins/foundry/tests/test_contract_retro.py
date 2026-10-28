"""Contract test for foundry's retro script, foundry ADR-0003 section 3 and "Seams" 2.

Written from the ADR before plugins/foundry/scripts/retro.py exists, so until it does every test
fails on "retro.py not found". The fixtures under fixtures/ are synthetic (P8), shaped like the two
real pre-0.4.0 session dirs and like a 0.4.0 dir; the expected counts are worked out by hand from
them and written here, not computed.
Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
FIXTURES = os.path.join(HERE, "fixtures")
PRE = os.path.join(FIXTURES, "retro-pre040")
NEW = os.path.join(FIXTURES, "retro-040")
NR = "not recorded"
TOP_KEYS = {"leftovers", "retro", "dir", "split", "runs", "judgeFiles", "plan", "eventsSkipped", "eventsOutsideRuns"}
RUN_KEYS = {"started", "goal", "decisions", "freeform", "recommendations", "messages", "spawns", "stalls", "escalations", "judges", "budgetsSpent"}


def snapshot(root):
    out = {}
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, root)] = fh.read()
    return out


class RetroContract(unittest.TestCase):
    cache = {}

    def run_retro(self, path):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        return subprocess.run([sys.executable, SCRIPT, path], capture_output=True, text=True, encoding="utf-8", timeout=60)

    def retro(self, path):
        if path not in self.cache:
            r = self.run_retro(path)
            self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
            self.cache[path] = json.loads(r.stdout)
        return self.cache[path]

    # ---------- shape ----------

    def test_output_shape(self):
        for path in (PRE, NEW):
            with self.subTest(os.path.basename(path)):
                out = self.retro(path)
                self.assertEqual(set(out.keys()), TOP_KEYS)
                self.assertEqual(out["retro"], 1)
                for run in out["runs"]:
                    self.assertEqual(set(run.keys()), RUN_KEYS)

    def test_writes_nothing(self):
        before = (snapshot(PRE), snapshot(NEW))
        self.run_retro(PRE)
        self.run_retro(NEW)
        self.assertEqual((snapshot(PRE), snapshot(NEW)), before)

    def test_missing_dir_exits_2_no_foundry_dir(self):
        tmp = tempfile.mkdtemp(prefix="retro-contract-")
        try:
            r = self.run_retro(os.path.join(tmp, "no-such-dir"))
            self.assertEqual(r.returncode, 2)
            self.assertTrue(r.stderr.startswith("retro: NO_FOUNDRY_DIR:"), "stderr: %r" % r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ---------- pre-0.4.0 dir: no headings, no events ----------

    def test_pre040_is_one_unsplit_run(self):
        out = self.retro(PRE)
        self.assertEqual(out["split"], NR)
        self.assertEqual(len(out["runs"]), 1)
        self.assertEqual(out["runs"][0]["started"], NR)
        self.assertEqual(out["runs"][0]["goal"], NR)

    def test_pre040_decisions(self):
        run = self.retro(PRE)["runs"][0]
        # 10 structured decision lines: 3 dated, 5 clock (one RFC 3339), 2 literal HH:MM.
        # Outcomes: 7 followed (one of them "followed (deferred)"; the other deferred line is a RECOMMEND, counted separately), 1 overruled, 2 "—".
        self.assertEqual(run["decisions"], {"total": 10, "clock": 5, "dateOnly": 3, "notRecorded": 2, "followed": 7, "overruled": 1, "other": 2})

    def test_pre040_freeform_lines_and_skipped_sub_bullets(self):
        # 5 free-form "- " lines; the indented sub-bullets (one shaped like a decision) don't count.
        self.assertEqual(self.retro(PRE)["runs"][0]["freeform"], 5)

    def test_pre040_recommendations(self):
        self.assertEqual(self.retro(PRE)["runs"][0]["recommendations"], {"total": 4, "answer": 2, "defer": 1, "pass": 1})

    def test_pre040_messages_include_rolled_logs(self):
        self.assertEqual(self.retro(PRE)["runs"][0]["messages"], 4)

    def test_pre040_event_categories_not_recorded(self):
        run = self.retro(PRE)["runs"][0]
        for key in ("spawns", "stalls", "escalations", "judges"):
            with self.subTest(key):
                self.assertEqual(run[key], NR)
        self.assertEqual(self.retro(PRE)["eventsSkipped"], 0)
        self.assertEqual(self.retro(PRE)["eventsOutsideRuns"], 0)

    def test_pre040_judge_files(self):
        # quartz-judge FAIL, quartz-judge-2 PASS, lantern-judge PASS, ferry-judge CHECKPOINT;
        # not .interim.md, not builder/redteam reports, not a report saved under an agent id.
        self.assertEqual(self.retro(PRE)["judgeFiles"], {"files": 4, "pass": 2, "fail": 1, "other": 1})

    def test_pre040_plan(self):
        # Read as: crews = len(crews), waves = distinct wave values, estAgents = sum (see report: ADR gap).
        self.assertEqual(self.retro(PRE)["plan"], {"crews": 3, "waves": 2, "estAgents": 12, "agentCap": 20, "status": {"merged": 2, "failed": 1}})

    # ---------- 0.4.0 dir: two headings and an event log ----------

    def test_040_split_into_pre_heading_run_and_two_runs(self):
        out = self.retro(NEW)
        self.assertEqual(out["split"], "headings")
        self.assertEqual([(r["started"], r["goal"]) for r in out["runs"]], [
            (NR, NR),
            ("2026-10-27T09:00:30Z", "build the retro script"),
            ("2026-10-27T13:00:00Z", "docs pass"),
        ])

    def test_040_decisions_per_run(self):
        runs = self.retro(NEW)["runs"]
        self.assertEqual([r["decisions"] for r in runs], [
            {"total": 1, "clock": 1, "dateOnly": 0, "notRecorded": 0, "followed": 1, "overruled": 0, "other": 0},
            {"total": 2, "clock": 1, "dateOnly": 0, "notRecorded": 1, "followed": 1, "overruled": 1, "other": 0},
            # the 14:00 line after "## Notes" stays in the second run
            {"total": 3, "clock": 2, "dateOnly": 1, "notRecorded": 0, "followed": 2, "overruled": 0, "other": 1},
        ])

    def test_040_freeform_and_recommendations_per_run(self):
        runs = self.retro(NEW)["runs"]
        self.assertEqual([r["freeform"] for r in runs], [0, 1, 0])
        self.assertEqual([r["recommendations"] for r in runs], [
            {"total": 0, "answer": 0, "defer": 0, "pass": 0},
            {"total": 1, "answer": 1, "defer": 0, "pass": 0},
            {"total": 2, "answer": 0, "defer": 1, "pass": 1},
        ])

    def test_040_messages_per_run(self):
        self.assertEqual([r["messages"] for r in self.retro(NEW)["runs"]], [1, 2, 1])

    def test_040_spawns_per_run(self):
        runs = self.retro(NEW)["runs"]
        self.assertEqual(runs[0]["spawns"], NR)
        self.assertEqual(runs[1]["spawns"], {"total": 3, "byModelEffort": {"sonnet/medium": 2, "opus/unset": 1}})
        # events.1.jsonl (rolled) counts too
        self.assertEqual(runs[2]["spawns"], {"total": 2, "byModelEffort": {"unset/unset": 1, "sonnet/low": 1}})

    def test_040_stalls_per_run(self):
        runs = self.retro(NEW)["runs"]
        self.assertEqual([r["stalls"] for r in runs], [NR, {"agent": 2, "idleLead": 1}, {"agent": 0, "idleLead": 0}])

    def test_040_escalations_per_run(self):
        runs = self.retro(NEW)["runs"]
        # the v:2 PROPOSAL line is skipped, not counted
        self.assertEqual([r["escalations"] for r in runs], [NR, {"QUESTION": 1, "BLOCKED": 1, "PROPOSAL": 0}, {"QUESTION": 0, "BLOCKED": 0, "PROPOSAL": 1}])

    def test_040_judges_count_only_judge_named_reports(self):
        runs = self.retro(NEW)["runs"]
        self.assertEqual([r["judges"] for r in runs], [NR, {"pass": 1, "fail": 1}, {"pass": 1, "fail": 0}])

    def test_040_skipped_and_outside_events(self):
        out = self.retro(NEW)
        self.assertEqual(out["eventsSkipped"], 2)
        self.assertEqual(out["eventsOutsideRuns"], 1)

    def test_040_judge_files_and_no_plan(self):
        out = self.retro(NEW)
        self.assertEqual(out["judgeFiles"], {"files": 3, "pass": 2, "fail": 1, "other": 0})
        self.assertEqual(out["plan"], NR)

    def test_crlf_and_bom_are_stripped(self):
        tmp = tempfile.mkdtemp(prefix="retro-contract-")
        try:
            dst = os.path.join(tmp, "dir")
            shutil.copytree(NEW, dst)
            p = os.path.join(dst, "decisions.md")
            with open(p, encoding="utf-8") as f:
                text = f.read()
            with open(p, "wb") as f:
                f.write(b"\xef\xbb\xbf" + text.replace("\n", "\r\n").encode("utf-8"))
            r = self.run_retro(dst)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = json.loads(r.stdout)
            want = self.retro(NEW)
            self.assertEqual([x["decisions"] for x in got["runs"]], [x["decisions"] for x in want["runs"]])
            self.assertEqual([x["goal"] for x in got["runs"]], [x["goal"] for x in want["runs"]])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
