"""Contract test for the `leftoverDetails` key of foundry's retro script (ADR-0006 section 1).

Written from the ADR before the producer exists; until retro.py emits the key every test fails on
"producer missing". Real git in temp repos, never mocks. Events come from fixtures/leftovers (synthetic,
shared with test_contract_leftovers.py, read only). Every case also checks that a run leaves the repo
unchanged: `git for-each-ref`, `git worktree list --porcelain` and `git count-objects -v`.
Run: python -m unittest discover -s plugins/foundry/tests
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
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
FIX = os.path.join(HERE, "fixtures", "leftovers")
SESSION = "2026-10-27-run"
A = "a0123456789abcdef"
B = "a1fedcba98765432"
KEYS = {"id", "branch", "folder", "head", "dirty", "inMain", "skip"}
PASSES = "passes every check retro can see"


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


def entry(i, branch=True, folder=True, head=None, dirty=False, inMain=None, skip=""):
    return {"id": i, "branch": br(i) if branch else None, "folder": fo(i) if folder else None,
            "head": head, "dirty": dirty, "inMain": inMain, "skip": skip}


class LeftoverDetails(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leftover-details-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, onerror=_rm_onerror)
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q")
        self.commit("f.txt", "x\n", "one")
        self.session = os.path.join(self.repo, ".git", "foundry", SESSION)

    # ---------- helpers ----------

    def commit(self, name, text, msg, where=None):
        where = where or self.repo
        with open(os.path.join(where, name), "w") as fh:
            fh.write(text)
        git(where, "add", name)
        git(where, "commit", "-q", "-m", msg)

    def wt_path(self, i):
        return os.path.join(self.repo, *fo(i).split("/"))

    def put_events(self, case, dest=None):
        dest = dest or self.session
        os.makedirs(dest, exist_ok=True)
        shutil.copy(os.path.join(FIX, case, "events.jsonl"), os.path.join(dest, "events.jsonl"))
        return dest

    def add_worktree(self, i, branch=True, start=None):
        args = ["worktree", "add", "-q"]
        args += ["-b", br(i)] if branch else ["--detach"]
        args.append(self.wt_path(i))
        if start:
            args.append(start)
        git(self.repo, *args)

    def sha(self, where, rev="HEAD"):
        return git(where, "rev-parse", rev).strip()

    def state(self):
        return (git(self.repo, "for-each-ref"), git(self.repo, "worktree", "list", "--porcelain"),
                git(self.repo, "count-objects", "-v"))

    def run_retro(self, path):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        r = subprocess.run([sys.executable, SCRIPT, path], capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        return json.loads(r.stdout)

    def details(self, path=None, full=False):
        """Run retro, check the repo is unchanged, return leftoverDetails (or the whole output with full)."""
        before = self.state()
        out = self.run_retro(path or self.session)
        self.assertEqual(self.state(), before, "retro changed the repo")
        if "leftoverDetails" not in out:
            self.fail("producer missing: retro.py has no leftoverDetails key")
        return out if full else out["leftoverDetails"]

    # ---------- cases ----------

    def test_detached_worktree(self):
        self.put_events("spawn-one")
        self.add_worktree(A, branch=False)
        sha = self.sha(self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, branch=False, head="detached " + sha, skip="not on a worktree-* branch (detached)")])

    def test_detached_worktree_with_branch_at_same_commit(self):
        self.put_events("spawn-one")
        self.add_worktree(A, branch=False)
        git(self.repo, "branch", br(A))
        sha = self.sha(self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, head="detached " + sha, inMain="ancestor", skip="not on a worktree-* branch (detached)")])

    def test_dirty_worktree_untracked_file_counts(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        with open(os.path.join(self.wt_path(A), "new.txt"), "w") as fh:
            fh.write("u\n")
        self.assertEqual(self.details(), [entry(A, head=br(A), dirty=True, inMain="ancestor", skip="uncommitted changes")])

    def test_locked_worktree_with_reason(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        git(self.repo, "worktree", "lock", "--reason", "agent still working", self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="ancestor", skip="locked (agent still working)")])

    def test_locked_worktree_bare_lock(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        git(self.repo, "worktree", "lock", self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="ancestor", skip="locked (locked)")])

    def test_branch_in_main(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="ancestor", skip=PASSES)])

    def test_branch_not_in_main(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        self.commit("g.txt", "g\n", "ahead", self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain=None, skip="%s is not in the main checkout's HEAD yet" % br(A))])

    def test_registered_worktree_whose_folder_is_gone(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        shutil.rmtree(self.wt_path(A), onerror=_rm_onerror)
        self.assertEqual(self.details(), [entry(A, folder=False, head=br(A), dirty=True, inMain="ancestor", skip="uncommitted changes")])

    def test_branch_with_no_worktree(self):
        self.put_events("spawn-one")
        git(self.repo, "branch", br(A))
        self.assertEqual(self.details(), [entry(A, folder=False, head=None, dirty=None, inMain="ancestor", skip="no longer a registered worktree")])

    def test_plain_folder_git_does_not_list(self):
        self.put_events("spawn-one")
        os.makedirs(self.wt_path(A))
        self.assertEqual(self.details(), [entry(A, branch=False, head=None, dirty=None, inMain=None, skip="no longer a registered worktree")])

    def test_main_checkout_detached(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        git(self.repo, "checkout", "-q", "--detach")
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="ancestor", skip="the main checkout is on no branch (detached or unreadable)")])

    def _diverged(self, further_edit):
        """A's commit adds g.txt; main gets h.txt, then a cherry-pick of A's commit (and optionally a later edit of g.txt)."""
        base = self.sha(self.repo)
        self.put_events("spawn-one")
        self.add_worktree(A, start=base)
        self.commit("g.txt", "a\n", "A work", self.wt_path(A))
        self.commit("h.txt", "h\n", "main moves")
        git(self.repo, "cherry-pick", br(A))
        if further_edit:
            self.commit("g.txt", "a2\n", "main edits g again")

    def test_main_on_crew_branch_tree_only_branch(self):
        self._diverged(False)
        git(self.repo, "checkout", "-q", "-b", "worktree-main-crew")
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="tree", skip="%s is not in the main checkout's HEAD yet" % br(A))])

    def test_main_on_crew_branch_cherry_only_branch(self):
        self._diverged(True)
        git(self.repo, "checkout", "-q", "-b", "worktree-main-crew")
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="cherry", skip="%s is not in the main checkout's HEAD yet" % br(A))])

    def test_tree_only_branch_with_main_on_ordinary_branch_passes(self):
        self._diverged(False)
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="tree", skip=PASSES)])

    def test_cherry_only_branch_with_main_on_ordinary_branch_passes(self):
        self._diverged(True)
        self.assertEqual(self.details(), [entry(A, head=br(A), inMain="cherry", skip=PASSES)])

    # ---------- shape ----------

    def test_every_entry_has_exactly_seven_keys_and_nulls_are_kept(self):
        self.put_events("spawn-two")
        git(self.repo, "branch", br(A))          # no worktree: head, dirty null
        os.makedirs(self.wt_path(B))             # plain folder: branch, head, dirty, inMain null
        d = self.details()
        self.assertEqual(len(d), 2)
        for e in d:
            self.assertEqual(set(e.keys()), KEYS, e)
        self.assertIsNone(d[0]["head"])
        self.assertIsNone(d[1]["inMain"])

    def test_sorted_by_id_and_matches_leftovers(self):
        self.put_events("spawn-two")
        self.add_worktree(B)
        git(self.repo, "branch", br(A))
        out = self.details(full=True)
        d = out["leftoverDetails"]
        self.assertEqual([e["id"] for e in d], [A, B])
        self.assertEqual(len(d), out["leftovers"]["count"])
        self.assertEqual(sorted(e["branch"] for e in d if e["branch"]), out["leftovers"]["branches"])
        self.assertEqual(sorted(e["folder"] for e in d if e["folder"]), out["leftovers"]["folders"])

    def test_empty_list_when_nothing_left(self):
        self.put_events("spawn-two")
        out = self.details(full=True)
        self.assertEqual(out["leftovers"]["count"], 0)
        self.assertEqual(out["leftoverDetails"], [])

    def test_stale_registration_without_branch_or_folder_has_no_entry(self):
        self.put_events("spawn-one")
        self.add_worktree(A)
        shutil.rmtree(self.wt_path(A), onerror=_rm_onerror)
        # drop the branch while the registration stays (git refuses to delete a checked-out branch)
        os.remove(os.path.join(self.repo, ".git", "refs", "heads", br(A)))
        out = self.details(full=True)
        self.assertEqual(out["leftovers"]["count"], 0)
        self.assertEqual(out["leftoverDetails"], [])

    def test_not_recorded_whenever_leftovers_is(self):
        for sub in ("elsewhere/foundry/" + SESSION, "repo/foundry/" + SESSION, "repo/.git/other/" + SESSION):
            with self.subTest(sub):
                d = self.put_events("spawn-one", os.path.join(self.tmp, *sub.split("/")))
                out = self.details(d, full=True)
                self.assertEqual(out["leftovers"], "not recorded")
                self.assertEqual(out["leftoverDetails"], "not recorded")


if __name__ == "__main__":
    unittest.main()
