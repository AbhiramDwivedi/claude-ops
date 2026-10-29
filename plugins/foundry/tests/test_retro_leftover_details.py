"""Edge-case tests for the `leftoverDetails` key of retro.py (ADR-0006 section 1), beyond test_contract_leftover_details.py.

Written from the ADR before the producer exists: until retro.py emits `leftoverDetails`, every test fails with
"producer missing". Real git in temp repos. Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # so the file runs by path from the repo root too

from test_contract_leftovers import SCRIPT, br, fo, git, _rm_onerror

NR = "not recorded"
TS = "2026-10-27T09:01:00.000Z"
ID = "a0123456789abcdef"


def spawn(agent_id):
    return json.dumps({"v": 1, "ts": TS, "event": "spawn", "crew": "c", "agent": "c", "agentId": agent_id,
                       "type": "foundry:lead", "model": "opus", "effort": "high", "by": "main"})


def quarantined_merge_tree(repo, ref):
    """Run the fixture's `merge-tree --write-tree` under its own quarantine so it writes nothing into the repo."""
    q = tempfile.mkdtemp(prefix="probe-quarantine-")
    try:
        env = dict(os.environ, GIT_OBJECT_DIRECTORY=q,
                   GIT_ALTERNATE_OBJECT_DIRECTORIES=os.path.abspath(os.path.join(repo, ".git", "objects")))
        return subprocess.run(["git", "-C", repo, "merge-tree", "--write-tree", "--no-messages", "HEAD", ref],
                              capture_output=True, text=True, env=env)
    finally:
        shutil.rmtree(q, onerror=_rm_onerror)


class RetroLeftoverDetails(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="retro-details-edges-")
        self.addCleanup(shutil.rmtree, self.tmp, onerror=_rm_onerror)
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q")
        self.commit("f.txt", "x\n", "one")
        self.session = os.path.join(self.repo, ".git", "foundry", "S1")
        os.makedirs(self.session)
        with open(os.path.join(self.session, "events.jsonl"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(spawn(ID) + "\n")
        self.wt = os.path.join(self.repo, *fo(ID).split("/"))

    def commit(self, name, text, msg, where=None):
        where = where or self.repo
        with open(os.path.join(where, name), "w") as fh:
            fh.write(text)
        git(where, "add", name)
        git(where, "commit", "-q", "-m", msg)

    def run_retro(self, env=None):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        r = subprocess.run([sys.executable, SCRIPT, self.session], capture_output=True, text=True,
                           encoding="utf-8", timeout=120, env=env)
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        out = json.loads(r.stdout)
        self.assertIn("leftoverDetails", out, "producer missing: retro.py has no leftoverDetails key")
        return out

    def test_worktree_on_non_worktree_branch(self):
        git(self.repo, "branch", br(ID))
        git(self.repo, "worktree", "add", "-q", "-b", "feature-x", self.wt)
        out = self.run_retro()
        self.assertEqual(out["leftovers"], {"branches": [br(ID)], "folders": [fo(ID)], "count": 1})
        self.assertEqual(len(out["leftoverDetails"]), 1)
        e = out["leftoverDetails"][0]
        self.assertEqual(e["head"], "feature-x")
        self.assertEqual(e["skip"], "not on a worktree-* branch (feature-x)")
        self.assertEqual(e["branch"], br(ID))
        self.assertEqual(e["dirty"], False)

    def test_worktree_list_failure_is_not_recorded_but_leftovers_stays_a_dict(self):
        git(self.repo, "branch", br(ID))
        git(self.repo, "worktree", "add", "-q", "-b", "wb", self.wt)
        # make `git worktree list --porcelain` really fail: a directory where git expects the `locked` file
        os.mkdir(os.path.join(self.repo, ".git", "worktrees", "agent-" + ID, "locked"))
        probe = subprocess.run(["git", "-C", self.repo, "worktree", "list", "--porcelain"], capture_output=True, text=True)
        self.assertNotEqual(probe.returncode, 0, "fixture broken: worktree list still succeeds")
        git(self.repo, "for-each-ref")  # the rest of git still works (raises otherwise)
        out = self.run_retro()
        self.assertIsInstance(out["leftovers"], dict)
        self.assertEqual(out["leftovers"]["count"], 1)
        self.assertEqual(out["leftoverDetails"], NR)

    def test_clean_merge_with_new_tree_leaves_repo_and_temp_dir_untouched(self):
        base = git(self.repo, "rev-parse", "HEAD").strip()
        git(self.repo, "checkout", "-q", "-b", br(ID), base)
        self.commit("b.txt", "b\n", "crew change")
        git(self.repo, "checkout", "-q", "-")
        self.commit("c.txt", "c\n", "main change")  # non-conflicting: the merged tree differs from HEAD^{tree}
        self.assertNotEqual(subprocess.run(["git", "-C", self.repo, "merge-base", "--is-ancestor", br(ID), "HEAD"]).returncode, 0)
        def state():
            return (git(self.repo, "for-each-ref"), git(self.repo, "worktree", "list", "--porcelain"),
                    git(self.repo, "count-objects", "-v"))
        before = state()  # baseline taken before any fixture probe; the probe below is quarantined and must not move it
        merged = quarantined_merge_tree(self.repo, br(ID))
        self.assertEqual(merged.returncode, 0, "fixture broken: the merge is not clean")
        self.assertNotEqual(merged.stdout.splitlines()[0], git(self.repo, "rev-parse", "HEAD^{tree}").strip())
        self.assertEqual(state(), before, "fixture broken: the quarantined probe changed the repo")
        scratch = os.path.join(self.tmp, "scratch-tmp")
        os.mkdir(scratch)
        env = dict(os.environ, TMP=scratch, TEMP=scratch, TMPDIR=scratch)
        out = self.run_retro(env=env)
        self.assertEqual(len(out["leftoverDetails"]), 1)
        e = out["leftoverDetails"][0]
        self.assertEqual(e["branch"], br(ID))
        self.assertIsNone(e["inMain"])
        self.assertEqual(state(), before, "retro changed refs, worktrees or the loose-object count")
        self.assertEqual(os.listdir(scratch), [], "retro left a temp dir behind")

    def test_unregistered_branch_cherry_picked_into_main_is_cherry(self):
        base = git(self.repo, "rev-parse", "HEAD").strip()
        git(self.repo, "checkout", "-q", "-b", br(ID), base)
        self.commit("b.txt", "b\n", "crew change")
        git(self.repo, "checkout", "-q", "-")
        self.commit("c.txt", "c\n", "main change")  # so the pick is a new commit, not the branch commit itself
        git(self.repo, "cherry-pick", br(ID))
        git(self.repo, "rm", "-q", "b.txt")  # main moves on: the merged tree now differs from HEAD^{tree}
        git(self.repo, "commit", "-q", "-m", "drop b")
        self.assertNotEqual(subprocess.run(["git", "-C", self.repo, "merge-base", "--is-ancestor", br(ID), "HEAD"]).returncode, 0)
        before = git(self.repo, "count-objects", "-v")
        merged = quarantined_merge_tree(self.repo, br(ID))
        self.assertEqual(merged.returncode, 0, "fixture broken: the merge is not clean")
        self.assertNotEqual(merged.stdout.splitlines()[0], git(self.repo, "rev-parse", "HEAD^{tree}").strip())
        self.assertEqual(git(self.repo, "count-objects", "-v"), before, "fixture broken: the probe wrote objects")
        cherry = git(self.repo, "cherry", "HEAD", br(ID)).splitlines()
        self.assertTrue(cherry and all(l.startswith("- ") for l in cherry), cherry)
        self.assertFalse(os.path.exists(self.wt))
        out = self.run_retro()
        self.assertEqual(len(out["leftoverDetails"]), 1)
        e = out["leftoverDetails"][0]
        self.assertEqual(e["branch"], br(ID))
        self.assertIsNone(e["head"])
        self.assertIsNone(e["dirty"])
        self.assertEqual(e["inMain"], "cherry")
        self.assertEqual(e["skip"], "no longer a registered worktree")


if __name__ == "__main__":
    unittest.main()
