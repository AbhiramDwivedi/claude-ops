"""Edge-case tests for retro's 0.5.0 per-run key `budgetsSpent` (ADR-0004 sections 5 and 8).

Beyond test_contract_retro_050.py. Written from the ADR before reading retro.py.
Readings where the ADR is silent follow test_retro.py: retro skips only lines that are not JSON
objects, not v 1, have no parsable ts, or exceed the line cap; wrong-typed or missing fields are
ignored, not skipped. So a budget line with a missing or non-string crew adds no crew and is not
counted in eventsSkipped; extra keys or a missing agent do not matter, because retro counts
distinct crews only.
Fixtures: fixtures/retro-050/ (synthetic); other data goes to temp dirs.
Run: python -m unittest discover -s plugins/foundry/tests -p "test_*retro*.py"
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
FIX = os.path.join(HERE, "fixtures", "retro-050")
NR = "not recorded"
HEAD = "## Run 2026-10-27T09:00:00Z | g\n"


def bl(ts, crew="auth", **kw):
    d = {"v": 1, "ts": ts, "event": "budget-spent", "crew": crew, "agent": str(crew) + "-judge-3"}
    d.update(kw)
    return json.dumps(d)


def sp(ts, crew="auth"):
    return json.dumps({"v": 1, "ts": ts, "event": "spawn", "crew": crew, "agent": crew, "agentId": "x",
                       "type": "foundry:lead", "model": "opus", "effort": "high", "by": "main"})


class Base(unittest.TestCase):
    def go(self, path):
        r = subprocess.run([sys.executable, SCRIPT, path], capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
        return json.loads(r.stdout.decode("utf-8"))


class Fixtures(Base):
    def test_budget_line_in_second_run_belongs_to_second_run_only(self):
        out = self.go(os.path.join(FIX, "tworuns"))
        first, second = out["runs"]
        self.assertEqual(first["budgetsSpent"], NR)
        self.assertEqual(second["budgetsSpent"], 1)
        self.assertEqual(first["spawns"]["total"], 1)
        self.assertEqual(second["spawns"]["total"], 1)
        self.assertEqual(out["eventsSkipped"], 0)

    def test_same_crew_in_two_events_files_counts_once_and_new_crew_adds_one(self):
        # events.1.jsonl: auth; events.jsonl: auth (other agent) and billing.
        out = self.go(os.path.join(FIX, "twofiles"))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 2)
        self.assertEqual(out["eventsSkipped"], 0)


class Edges(Base):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="retro050-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def write(self, name, data):
        mode = "wb" if isinstance(data, bytes) else "w"
        kw = {} if isinstance(data, bytes) else {"encoding": "utf-8", "newline": ""}
        with open(os.path.join(self.dir, name), mode, **kw) as f:
            f.write(data)

    def events(self, *lines, head=HEAD):
        if head is not None:
            self.write("decisions.md", head)
        self.write("events.jsonl", "\n".join(lines) + "\n")
        return self.go(self.dir)

    def test_single_budget_line_is_one(self):
        self.assertEqual(self.events(bl("2026-10-27T09:30:00Z"))["runs"][0]["budgetsSpent"], 1)

    def test_repeated_lines_for_one_crew_stay_one(self):
        out = self.events(*[bl("2026-10-27T09:3%d:00Z" % i) for i in range(5)])
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)

    def test_same_crew_name_with_different_agents_is_one_crew(self):
        out = self.events(bl("2026-10-27T09:30:00Z", agent="auth-judge-3"),
                          bl("2026-10-27T09:31:00Z", agent="auth-judge-4"))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)

    def test_distinct_crew_values_are_distinct(self):
        out = self.events(bl("2026-10-27T09:30:00Z", "auth"), bl("2026-10-27T09:31:00Z", "auth-2"))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 2)

    def test_same_crew_in_two_runs_counts_in_each(self):
        self.write("decisions.md", HEAD + "## Run 2026-10-27T12:00:00Z | g2\n")
        self.write("events.jsonl", bl("2026-10-27T09:30:00Z") + "\n" + bl("2026-10-27T12:30:00Z") + "\n")
        runs = self.go(self.dir)["runs"]
        self.assertEqual([r["budgetsSpent"] for r in runs], [1, 1])

    def test_budget_line_before_first_heading_is_outside_every_run(self):
        out = self.events(bl("2026-10-27T08:00:00Z"), sp("2026-10-27T09:01:00Z"))
        self.assertEqual(out["eventsOutsideRuns"], 1)
        self.assertEqual(out["runs"][0]["budgetsSpent"], NR)

    def test_budget_lines_without_run_heading_are_not_recorded(self):
        out = self.events(bl("2026-10-27T09:30:00Z"), head="- 09:00 | a | b | c | followed\n")
        run = out["runs"][0]
        self.assertEqual(out["split"], NR)
        self.assertIn("budgetsSpent", run)
        self.assertEqual(run["budgetsSpent"], NR)
        self.assertEqual(out["eventsOutsideRuns"], 1)

    def test_budget_line_with_extra_key_still_counts(self):
        out = self.events(bl("2026-10-27T09:30:00Z", reason="x", n=3))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)
        self.assertEqual(out["eventsSkipped"], 0)

    def test_budget_line_missing_agent_still_counts_its_crew(self):
        d = json.loads(bl("2026-10-27T09:30:00Z"))
        del d["agent"]
        out = self.events(json.dumps(d))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)
        self.assertEqual(out["eventsSkipped"], 0)

    def test_budget_lines_missing_or_wrong_typed_crew_add_no_crew_and_are_not_skipped(self):
        d = json.loads(bl("2026-10-27T09:30:00Z"))
        del d["crew"]
        out = self.events(json.dumps(d), bl("2026-10-27T09:31:00Z", crew=["auth"]),
                          bl("2026-10-27T09:32:00Z", crew={"a": 1}), bl("2026-10-27T09:33:00Z", crew="billing"))
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)
        self.assertEqual(out["eventsSkipped"], 0)

    def test_budget_line_with_bad_ts_or_wrong_v_is_skipped_and_not_counted(self):
        wrong_v = json.dumps({"v": 2, "ts": "2026-10-27T09:30:00Z", "event": "budget-spent",
                              "crew": "y", "agent": "y-judge"})
        out = self.events(bl("not a time", "x"), wrong_v, bl("2026-10-27T09:30:00Z", "auth"))
        self.assertEqual(out["eventsSkipped"], 2)
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)

    def test_only_skipped_budget_lines_leave_not_recorded(self):
        out = self.events(bl("garbage", "x"))
        self.assertEqual(out["runs"][0]["budgetsSpent"], NR)

    def test_budget_lines_are_not_spawns_and_do_not_move_other_categories(self):
        base = self.events(sp("2026-10-27T09:01:00Z"))["runs"][0]
        with_budget = self.events(sp("2026-10-27T09:01:00Z"), bl("2026-10-27T09:30:00Z"))["runs"][0]
        self.assertEqual(with_budget["budgetsSpent"], 1)
        for k in base:
            if k != "budgetsSpent":
                self.assertEqual(base[k], with_budget[k], k)
        self.assertEqual(with_budget["spawns"]["total"], 1)

    def test_spawns_only_run_is_not_recorded_not_zero(self):
        run = self.events(sp("2026-10-27T09:01:00Z"))["runs"][0]
        self.assertEqual(run["budgetsSpent"], NR)

    def test_empty_events_file_with_heading_is_not_recorded_never_zero(self):
        self.write("decisions.md", HEAD)
        self.write("events.jsonl", "")
        run = self.go(self.dir)["runs"][0]
        self.assertEqual(run["budgetsSpent"], NR)
        self.assertEqual(run["stalls"], {"agent": 0, "idleLead": 0})

    def test_key_order_budgetsSpent_right_after_judges_and_old_keys_remain(self):
        run = self.events(bl("2026-10-27T09:30:00Z"))["runs"][0]
        keys = list(run)
        self.assertEqual(keys[keys.index("judges") + 1], "budgetsSpent")
        other = list(self.go(os.path.join(FIX, "twofiles"))["runs"][0])
        self.assertEqual(keys, other)

    def test_key_present_on_every_run_even_without_events(self):
        self.write("decisions.md", HEAD + "## Run 2026-10-27T12:00:00Z | g2\n")
        out = self.go(self.dir)
        for run in out["runs"]:
            keys = list(run)
            self.assertIn("budgetsSpent", keys)
            self.assertEqual(run["budgetsSpent"], NR)
            self.assertEqual(keys[keys.index("judges") + 1], "budgetsSpent")

    def test_retro_version_stays_1_with_budget_lines(self):
        self.assertEqual(self.events(bl("2026-10-27T09:30:00Z"))["retro"], 1)

    def test_oversize_budget_line_is_skipped_by_line_cap(self):
        self.write("decisions.md", HEAD)
        big = (b'{"v":1,"ts":"2026-10-27T09:30:00Z","event":"budget-spent","crew":"big","agent":"'
               + b"x" * (3 << 20) + b'"}\n')
        self.write("events.jsonl", big + bl("2026-10-27T09:31:00Z").encode() + b"\n")
        out = self.go(self.dir)
        self.assertEqual(out["eventsSkipped"], 1)
        self.assertEqual(out["runs"][0]["budgetsSpent"], 1)

    def snapshot(self, root):
        snap = {}
        for base, dirs, files in os.walk(root):
            for n in dirs + files:
                p = os.path.join(base, n)
                rel = os.path.relpath(p, root)
                if os.path.isfile(p):
                    with open(p, "rb") as f:
                        snap[rel] = (os.path.getsize(p), os.stat(p).st_mtime_ns,
                                     hashlib.sha256(f.read()).hexdigest())
                else:
                    snap[rel] = None
        return snap

    def test_script_writes_nothing_into_the_foundry_dir(self):
        d = os.path.join(self.dir, "d")
        shutil.copytree(os.path.join(FIX, "tworuns"), d)
        before = self.snapshot(d)
        out = self.go(d)
        self.assertEqual(out["runs"][1]["budgetsSpent"], 1)
        self.assertEqual(self.snapshot(d), before)


if __name__ == "__main__":
    unittest.main()
