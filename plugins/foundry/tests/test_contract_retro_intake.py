"""Contract test for retro's per-goal `goals` key, foundry ADR-0010 (mid-run intake) section 6 and line 87.

Written from the ADR before the producer exists. Fixtures are built in a tempdir (plan.json and decisions.md)
and retro.py is run by subprocess; only the printed JSON is checked. Expected counts are worked out by hand.
Run: python -m unittest discover -s plugins/foundry/tests -p test_contract_retro_intake.py
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
NR = "not recorded"
ENTRY_KEYS = {"id", "goal", "addedAt", "crews", "estAgents", "status", "decisions"}

GOALS = [
    {"id": "alpha", "goal": "add the alpha feature", "addedAt": "2026-10-28T10:00:00Z",
     "approval": "auto", "approvedAt": "2026-10-28T10:01:00Z"},
    {"id": "beta-two", "goal": "fix the beta bug", "addedAt": "2026-10-28T11:30:00Z",
     "approval": "owner", "approvedAt": None},
]
# run: a, b, c (no goal, "run", non-string goal). alpha: d, e. beta-two: f.
CREWS = [
    {"slug": "a", "wave": 0, "estAgents": 2, "status": "merged"},
    {"slug": "b", "goal": "run", "wave": 0, "estAgents": 3, "status": "merged"},
    {"slug": "c", "goal": 5, "wave": 1, "estAgents": 1},
    {"slug": "d", "goal": "alpha", "wave": 0, "estAgents": 4, "status": "merged"},
    {"slug": "e", "goal": "alpha", "wave": 1, "estAgents": 5, "status": "running"},
    {"slug": "f", "goal": "beta-two", "wave": 0, "estAgents": 6},
]


def plan(goals=None, crews=None, version=3):
    p = {"version": version, "goal": "ship the thing", "approval": "owner",
         "approvedAt": "2026-10-27T09:00:00Z", "agentCap": 10, "repairBudget": 2,
         "crews": CREWS if crews is None else crews}
    if goals is not None:
        p["goals"] = goals
    return p


def line(text, hhmm="10:00"):
    return "- %s | %s | because | cynic: none | followed\n" % (hhmm, text)


class RetroIntake(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="retro-intake-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def retro(self, plan_obj, decisions):
        d = os.path.join(self.tmp, "session")
        os.makedirs(d, exist_ok=True)
        if plan_obj is not None:
            with open(os.path.join(d, "plan.json"), "w", encoding="utf-8", newline="\n") as f:
                json.dump(plan_obj, f)
        with open(os.path.join(d, "decisions.md"), "w", encoding="utf-8", newline="\n") as f:
            f.write("# Decisions\n" + decisions)
        r = subprocess.run([sys.executable, SCRIPT, d], capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        return json.loads(r.stdout)

    def goals_by_id(self, out):
        self.assertIn("goals", out)
        self.assertIsInstance(out["goals"], list)
        return {g["id"]: g for g in out["goals"]}

    # ---------- entries ----------

    def test_run_first_then_plan_goals_in_order(self):
        out = self.retro(plan(GOALS), line("untagged"))
        self.assertEqual([g["id"] for g in out["goals"]], ["run", "alpha", "beta-two"])

    def test_every_entry_has_exactly_the_seven_keys(self):
        out = self.retro(plan(GOALS), line("untagged"))
        self.assertIn("goals", out)
        for g in out["goals"]:
            with self.subTest(g["id"]):
                self.assertEqual(set(g.keys()), ENTRY_KEYS)

    def test_run_entry_goal_and_added_at(self):
        g = self.goals_by_id(self.retro(plan(GOALS), ""))["run"]
        self.assertEqual(g["goal"], "ship the thing")
        self.assertEqual(g["addedAt"], NR)

    def test_plan_goal_entries_take_goal_and_added_at_from_plan(self):
        by = self.goals_by_id(self.retro(plan(GOALS), ""))
        self.assertEqual(by["alpha"]["goal"], "add the alpha feature")
        self.assertEqual(by["alpha"]["addedAt"], "2026-10-28T10:00:00Z")
        self.assertEqual(by["beta-two"]["goal"], "fix the beta bug")
        self.assertEqual(by["beta-two"]["addedAt"], "2026-10-28T11:30:00Z")

    # ---------- crews, estAgents, status ----------

    def test_crews_est_agents_status_per_goal(self):
        by = self.goals_by_id(self.retro(plan(GOALS), ""))
        self.assertEqual((by["run"]["crews"], by["run"]["estAgents"], by["run"]["status"]),
                         (3, 6, {"merged": 2, "unset": 1}))
        self.assertEqual((by["alpha"]["crews"], by["alpha"]["estAgents"], by["alpha"]["status"]),
                         (2, 9, {"merged": 1, "running": 1}))
        self.assertEqual((by["beta-two"]["crews"], by["beta-two"]["estAgents"], by["beta-two"]["status"]),
                         (1, 6, {"unset": 1}))

    def test_goal_absent_run_and_non_string_all_count_to_run(self):
        crews = [{"slug": "a", "wave": 0, "estAgents": 1, "status": "merged"},
                 {"slug": "b", "goal": "run", "wave": 0, "estAgents": 1, "status": "merged"},
                 {"slug": "c", "goal": ["x"], "wave": 0, "estAgents": 1, "status": "merged"}]
        by = self.goals_by_id(self.retro(plan(GOALS, crews), ""))
        self.assertEqual((by["run"]["crews"], by["run"]["estAgents"], by["run"]["status"]),
                         (3, 3, {"merged": 3}))
        self.assertEqual((by["alpha"]["crews"], by["alpha"]["estAgents"], by["alpha"]["status"]),
                         (0, 0, {}))

    # ---------- decisions ----------

    def test_decisions_count_last_run_only(self):
        log = ("## Run 2026-10-27T09:00:00Z | first\n"
               + line("[alpha] early one") + line("[alpha] early two") + line("[beta-two] early") + line("untagged early")
               + "## Run 2026-10-28T09:00:00Z | second\n"
               + line("[alpha] late one") + line("[beta-two] late one") + line("[beta-two] late two")
               + line("[beta-two] late three") + line("untagged late"))
        by = self.goals_by_id(self.retro(plan(GOALS), log))
        self.assertEqual(by["alpha"]["decisions"], 1)
        self.assertEqual(by["beta-two"]["decisions"], 3)
        self.assertEqual(by["run"]["decisions"], 1)

    def test_no_heading_counts_whole_log(self):
        log = line("[alpha] one") + line("[alpha] two") + line("[beta-two] three") + line("plain")
        by = self.goals_by_id(self.retro(plan(GOALS), log))
        self.assertEqual(by["alpha"]["decisions"], 2)
        self.assertEqual(by["beta-two"]["decisions"], 1)
        self.assertEqual(by["run"]["decisions"], 1)

    def test_unknown_tag_and_untagged_count_to_run(self):
        log = line("[ghost] unknown id") + line("[other-thing] also unknown") + line("no tag") + line("[alpha] known")
        by = self.goals_by_id(self.retro(plan(GOALS), log))
        self.assertEqual(by["run"]["decisions"], 3)
        self.assertEqual(by["alpha"]["decisions"], 1)
        self.assertEqual(by["beta-two"]["decisions"], 0)

    def test_malformed_tags_are_untagged(self):
        log = (line("[Alpha] upper case") + line("[alpha]no space") + line("[alpha-] trailing dash")
               + line("[-alpha] leading dash") + line("[alpha beta] inner space") + line("x [alpha] not first")
               + line("[alpha] good"))
        by = self.goals_by_id(self.retro(plan(GOALS), log))
        self.assertEqual(by["alpha"]["decisions"], 1)
        self.assertEqual(by["run"]["decisions"], 6)

    def test_run_tag_counts_to_run(self):
        # `run` is the reserved id and never a plan goal; a [run] tag is not in the plan, so it is the run's.
        by = self.goals_by_id(self.retro(plan(GOALS), line("[run] explicit") + line("[alpha] a")))
        self.assertEqual(by["run"]["decisions"], 1)
        self.assertEqual(by["alpha"]["decisions"], 1)

    def test_entry_decisions_sum_to_last_run_decisions_total(self):
        log = ("## Run 2026-10-27T09:00:00Z | first\n" + line("[alpha] x")
               + "## Run 2026-10-28T09:00:00Z | second\n"
               + line("[alpha] a") + line("[beta-two] b") + line("[ghost] c") + line("d"))
        out = self.retro(plan(GOALS), log)
        self.assertIn("goals", out)
        self.assertEqual(sum(g["decisions"] for g in out["goals"]), out["runs"][-1]["decisions"]["total"])

    # ---------- absence ----------

    def test_no_goals_key_without_goals_in_plan(self):
        out = self.retro(plan(None, version=2), line("[alpha] x"))
        self.assertNotIn("goals", out)

    def test_no_goals_key_with_empty_goals_array(self):
        out = self.retro(plan([]), line("[alpha] x"))
        self.assertNotIn("goals", out)

    def test_no_goals_key_without_plan_file(self):
        out = self.retro(None, line("[alpha] x"))
        self.assertNotIn("goals", out)


if __name__ == "__main__":
    unittest.main()
