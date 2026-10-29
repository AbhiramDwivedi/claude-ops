"""Contract test for retro's 0.8.0 per-run keys, foundry ADR-0005 (growth model) point 4, written from the spec
before the producer exists: `fetches` {total, perAgent}, `extendPasses`, `defaultDecisions`, `openOwnerActions`,
each "not recorded" where its source is absent.

Fixtures are synthetic (fixtures/contract-080/data); setUpClass builds throwaway git repos in a tempdir from
them, with a fixed author and dates. Session dir = <repo>/.git/foundry/<session>, as for the leftovers contract.
Run 1 window starts 2026-10-27T09:00Z, run 2 starts 2026-10-28T09:00Z.
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
DATA = os.path.join(HERE, "fixtures", "contract-080", "data")
NR = "not recorded"

# (iso date, subject). Run 1 should count the 2 matching ones inside its window; run 2 the last one.
COMMITS = [
    ("2026-10-26T09:00:00Z", "docs(arch): extend before-window"),
    ("2026-10-27T09:30:00Z", "docs(arch): extend payments"),
    ("2026-10-27T10:00:00Z", "docs(arch): adopt learned items"),
    ("2026-10-27T11:00:00Z", "docs(arch): extension notes"),
    ("2026-10-27T11:30:00Z", "docs(arch): adopt learned item"),
    ("2026-10-27T12:00:00Z", "feat: extend something"),
    ("2026-10-28T10:00:00Z", "docs(arch): extend search"),
]


def git(cwd, date, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="Test Author", GIT_AUTHOR_EMAIL="author@example.invalid",
               GIT_COMMITTER_NAME="Test Author", GIT_COMMITTER_EMAIL="author@example.invalid",
               GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (args, r.stderr))
    return r.stdout


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def copy(name, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(os.path.join(DATA, name), dest)


class Retro080(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="retro080-")
        cls.full = cls.make_repo("full", "events-fetch.jsonl", True)
        cls.bare = cls.make_repo("bare", "events-nofetch.jsonl", False)
        cls.cache = {}

    @classmethod
    def tearDownClass(cls):
        def onerr(fn, p, _):
            os.chmod(p, 0o700)
            fn(p)
        shutil.rmtree(cls.tmp, onerror=onerr)

    @classmethod
    def make_repo(cls, name, events, full):
        """full: config, architecture doc, ADRs and the extend commits. Otherwise a bare repo with one commit."""
        repo = os.path.join(cls.tmp, name)
        os.makedirs(repo)
        git(repo, "2026-10-01T00:00:00Z", "init", "-q")
        git(repo, "2026-10-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "chore: start")
        sess = os.path.join(repo, ".git", "foundry", "2026-10-27-run")
        copy("decisions.md", os.path.join(sess, "decisions.md"))
        copy(events, os.path.join(sess, "events.jsonl"))
        if full:
            put(os.path.join(repo, ".claude", "foundry.json"),
                json.dumps({"architecture": "docs/architecture.md", "adr": "docs/adr"}))
            copy("architecture.md", os.path.join(repo, "docs", "architecture.md"))
            for f in sorted(os.listdir(os.path.join(DATA, "adr"))):
                copy(os.path.join("adr", f), os.path.join(repo, "docs", "adr", f))
            for date, subject in COMMITS:
                git(repo, date, "commit", "-q", "--allow-empty", "-m", subject)
        return sess

    def runs(self, sess):
        if sess not in self.cache:
            self.assertTrue(os.path.isfile(SCRIPT), "producer missing: retro.py not found at %s" % SCRIPT)
            r = subprocess.run([sys.executable, SCRIPT, sess], capture_output=True, text=True,
                               encoding="utf-8", timeout=60)
            self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
            self.cache[sess] = json.loads(r.stdout)["runs"]
        return self.cache[sess]

    def run1(self, sess):
        runs = self.runs(sess)
        self.assertEqual(len(runs), 2, "fixture should yield two runs")
        return runs[0]

    def test_fetches_total_and_per_agent(self):
        run = self.run1(self.full)
        self.assertIn("fetches", run)
        self.assertEqual(run["fetches"], {"total": 3, "perAgent": {"alpha-architect": 2, "alpha-writer": 1}})

    def test_fetches_without_fetch_lines_is_not_recorded_never_zero(self):
        run = self.run1(self.bare)
        self.assertIn("fetches", run)
        self.assertEqual(run["fetches"], NR)

    def test_extend_passes_counts_only_matching_subjects_inside_the_window(self):
        run = self.run1(self.full)
        self.assertIn("extendPasses", run)
        self.assertEqual(run["extendPasses"], 2)

    def test_extend_passes_second_run_window(self):
        run = self.runs(self.full)[1]
        self.assertIn("extendPasses", run)
        self.assertEqual(run["extendPasses"], 1)

    def test_default_decisions_counts_adrs_with_the_line(self):
        run = self.run1(self.full)
        self.assertIn("defaultDecisions", run)
        self.assertEqual(run["defaultDecisions"], 2)

    def test_default_decisions_without_adr_dir_is_not_recorded(self):
        run = self.run1(self.bare)
        self.assertIn("defaultDecisions", run)
        self.assertEqual(run["defaultDecisions"], NR)

    def test_open_owner_actions_counts_open_under_owner_actions_only(self):
        # 2 open under "Owner actions", 3 done (not counted), 1 open under "Notes" (not counted)
        run = self.run1(self.full)
        self.assertIn("openOwnerActions", run)
        self.assertEqual(run["openOwnerActions"], 2)

    def test_open_owner_actions_without_architecture_doc_is_not_recorded(self):
        run = self.run1(self.bare)
        self.assertIn("openOwnerActions", run)
        self.assertEqual(run["openOwnerActions"], NR)


if __name__ == "__main__":
    unittest.main()
