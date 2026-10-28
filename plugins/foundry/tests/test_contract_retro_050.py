"""Contract test for retro's 0.5.0 key `budgetsSpent`, foundry ADR-0004 sections 5 and 8, Seams 4.

Written from the ADR. Fixtures are synthetic, under fixtures/contract-050/retro/:
  spent/     a `## Run` heading, 3 spawn lines, and budget-spent lines for crew auth (twice) and billing (once)
  none/      a `## Run` heading, events with spawn lines only (a 0.4.x log looks the same)
  noevents/  a `## Run` heading and no events*.jsonl
Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
ROOT = os.path.join(HERE, "fixtures", "contract-050", "retro")
NR = "not recorded"


class RetroBudgetsSpent(unittest.TestCase):
    cache = {}

    def retro(self, name):
        if name not in self.cache:
            if not os.path.isfile(SCRIPT):
                self.fail("producer missing: retro.py not found at %s" % SCRIPT)
            r = subprocess.run([sys.executable, SCRIPT, os.path.join(ROOT, name)], capture_output=True,
                               text=True, encoding="utf-8", timeout=60)
            self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
            self.cache[name] = json.loads(r.stdout)
        return self.cache[name]

    def run0(self, name):
        runs = self.retro(name)["runs"]
        self.assertEqual(len(runs), 1, "fixture %s should yield one run" % name)
        return runs[0]

    def test_two_crews_one_twice_counts_distinct_crews(self):
        run = self.run0("spent")
        self.assertIn("budgetsSpent", run)
        self.assertEqual(run["budgetsSpent"], 2)

    def test_run_with_events_but_no_budget_line_is_not_recorded_never_zero(self):
        run = self.run0("none")
        self.assertIn("budgetsSpent", run)
        self.assertEqual(run["budgetsSpent"], NR)
        self.assertNotEqual(run["budgetsSpent"], 0)

    def test_run_without_events_is_not_recorded(self):
        run = self.run0("noevents")
        self.assertIn("budgetsSpent", run)
        self.assertEqual(run["budgetsSpent"], NR)

    def test_budgetsSpent_is_a_per_run_key_after_judges(self):
        out = self.retro("spent")
        self.assertNotIn("budgetsSpent", out, "budgetsSpent is per run, not top level")
        keys = list(self.run0("spent").keys())
        self.assertIn("budgetsSpent", keys)
        self.assertIn("judges", keys)
        self.assertEqual(keys.index("budgetsSpent"), keys.index("judges") + 1)

    def test_retro_version_stays_1(self):
        for name in ("spent", "none", "noevents"):
            with self.subTest(name):
                self.assertEqual(self.retro(name)["retro"], 1)

    def test_top_level_keys_unchanged(self):
        want = {"retro", "dir", "split", "runs", "judgeFiles", "plan", "eventsSkipped", "eventsOutsideRuns"}
        self.assertEqual(set(self.retro("spent").keys()), want)

    def test_spawns_counted_from_spawn_lines_only(self):
        # Spawn lines gain no keys; the budget-spent lines are not spawns.
        run = self.run0("spent")
        self.assertIn("budgetsSpent", run, "fixture must be read as a 0.5.0 run")
        self.assertEqual(run["spawns"], {"total": 3, "byModelEffort": {"opus/high": 1, "sonnet/medium": 2}})

    def test_budget_lines_are_not_skipped_as_malformed(self):
        out = self.retro("spent")
        self.assertIn("budgetsSpent", out["runs"][0], "fixture must be read as a 0.5.0 run")
        self.assertEqual(out["eventsSkipped"], 0)
        self.assertEqual(out["eventsOutsideRuns"], 0)


if __name__ == "__main__":
    unittest.main()
