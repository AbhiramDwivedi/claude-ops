"""Contract test for the `leftovers` key of foundry's retro script.

Spec: retro.py's JSON gains a top-level "leftovers". For a session dir D = <git common dir>/foundry/<session>,
every distinct agentId of a `spawn` event in D/events.jsonl may leave a branch `worktree-agent-<id>` and a
folder `.claude/worktrees/agent-<id>` (relative to the main checkout). leftovers is
{"branches": [sorted], "folders": [sorted, forward slashes, relative], "count": distinct agent ids with a
branch or a folder or both}. Other sessions' agents never count, slots.json is never read, the repo is never
changed. A dir not in that shape gives the string "not recorded".

Written before the producer exists; until retro.py emits the key every test fails on "producer missing".
Fixtures under fixtures/leftovers are synthetic (P8). Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from test_contract_retro import TOP_KEYS

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
FIX = os.path.join(HERE, "fixtures", "leftovers")
SESSION = "2026-10-27-run"
A = "a0123456789abcdef"  # spawned in spawn-one and spawn-two
B = "a1fedcba98765432"  # spawned in spawn-two only
C = "a2468ace13579bdf"  # never spawned in D: another session's agent
D2 = "a13579bdf2468ace"  # never spawned in D: another session's agent


def br(i):
    return "worktree-agent-" + i


def fo(i):
    return ".claude/worktrees/agent-" + i


def _rm_onerror(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", *args],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), r.stderr.strip()))
    return r.stdout


class Leftovers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leftovers-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, onerror=_rm_onerror)
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q")
        with open(os.path.join(self.repo, "f.txt"), "w") as fh:
            fh.write("x\n")
        git(self.repo, "add", "f.txt")
        git(self.repo, "commit", "-q", "-m", "one")
        self.session = os.path.join(self.repo, ".git", "foundry", SESSION)

    # ---------- helpers ----------

    def put_events(self, case, dest=None):
        dest = dest or self.session
        os.makedirs(dest, exist_ok=True)
        shutil.copy(os.path.join(FIX, case, "events.jsonl"), os.path.join(dest, "events.jsonl"))
        return dest

    def add_branch(self, i):
        git(self.repo, "branch", br(i))

    def add_dir(self, i):
        os.makedirs(os.path.join(self.repo, *fo(i).split("/")))

    def add_worktree(self, i, branch=False):
        args = ["worktree", "add", "-q"]
        args += ["-b", br(i)] if branch else ["--detach"]
        git(self.repo, *args, os.path.join(self.repo, *fo(i).split("/")))

    def run_retro(self, path):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        r = subprocess.run([sys.executable, SCRIPT, path], capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        return json.loads(r.stdout)

    def leftovers(self, path=None):
        out = self.run_retro(path or self.session)
        self.assertIn("leftovers", out, "producer missing: retro.py emits no leftovers key")
        return out["leftovers"]

    def repo_state(self):
        return (git(self.repo, "for-each-ref"), git(self.repo, "worktree", "list", "--porcelain"))

    # ---------- cases ----------

    def test_branch_only(self):
        self.put_events("spawn-one")
        self.add_branch(A)
        self.assertEqual(self.leftovers(), {"branches": [br(A)], "folders": [], "count": 1})

    def test_folder_only_real_worktree(self):
        self.put_events("spawn-one")
        self.add_worktree(A, branch=False)
        self.assertEqual(self.leftovers(), {"branches": [], "folders": [fo(A)], "count": 1})

    def test_folder_only_plain_directory(self):
        self.put_events("spawn-one")
        self.add_dir(A)
        self.assertEqual(self.leftovers(), {"branches": [], "folders": [fo(A)], "count": 1})

    def test_branch_and_folder_same_agent_counts_once(self):
        self.put_events("spawn-one")
        self.add_worktree(A, branch=True)
        self.assertEqual(self.leftovers(), {"branches": [br(A)], "folders": [fo(A)], "count": 1})

    def test_two_agents_sorted_and_counted_per_agent(self):
        self.put_events("spawn-two")
        self.add_worktree(B, branch=True)
        self.add_branch(A)
        self.assertEqual(self.leftovers(), {"branches": sorted([br(A), br(B)]), "folders": [fo(B)], "count": 2})

    def test_none_left(self):
        self.put_events("spawn-two")
        self.assertEqual(self.leftovers(), {"branches": [], "folders": [], "count": 0})

    def test_other_sessions_agents_do_not_count(self):
        self.put_events("spawn-one")
        for i in (C, D2):
            self.add_worktree(i, branch=True)
        self.add_dir("a99999999999999999")
        self.assertEqual(self.leftovers(), {"branches": [], "folders": [], "count": 0})

    def test_other_sessions_agents_do_not_inflate_own(self):
        self.put_events("spawn-one")
        self.add_branch(A)
        self.add_worktree(C, branch=True)
        self.assertEqual(self.leftovers(), {"branches": [br(A)], "folders": [], "count": 1})

    def test_slots_json_is_never_read(self):
        self.put_events("spawn-one")
        self.add_branch(A)
        slots = os.path.join(self.repo, ".git", "claude-worktrees", "slots.json")
        os.makedirs(os.path.dirname(slots))
        shutil.copy(os.path.join(FIX, "slots.json"), slots)
        self.add_worktree(C, branch=True)  # listed active in slots.json, not spawned in D
        self.assertEqual(self.leftovers(), {"branches": [br(A)], "folders": [], "count": 1})

    def test_slots_json_with_nothing_on_disk(self):
        self.put_events("spawn-one")
        slots = os.path.join(self.repo, ".git", "claude-worktrees", "slots.json")
        os.makedirs(os.path.dirname(slots))
        shutil.copy(os.path.join(FIX, "slots.json"), slots)
        self.assertEqual(self.leftovers(), {"branches": [], "folders": [], "count": 0})

    def test_repo_unchanged_by_run(self):
        self.put_events("spawn-two")
        self.add_worktree(A, branch=True)
        self.add_branch(B)
        self.add_dir(C)
        before = self.repo_state()
        self.leftovers()
        self.assertEqual(self.repo_state(), before)

    def test_not_under_a_common_dir_is_not_recorded(self):
        for sub in ("elsewhere/foundry/" + SESSION, "repo/foundry/" + SESSION, "repo/.git/other/" + SESSION):
            with self.subTest(sub):
                d = self.put_events("spawn-one", os.path.join(self.tmp, *sub.split("/")))
                self.assertEqual(self.leftovers(d), "not recorded")

    def test_top_level_keys_include_leftovers(self):
        self.put_events("spawn-one")
        out = self.run_retro(self.session)
        self.assertIn("leftovers", out, "producer missing: retro.py emits no leftovers key")
        self.assertEqual(set(out.keys()), TOP_KEYS)


if __name__ == "__main__":
    unittest.main()
