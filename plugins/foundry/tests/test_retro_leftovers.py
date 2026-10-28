"""Edge-case tests for the `leftovers` key of retro.py, beyond test_contract_leftovers.py.

Written from the lead's spec before the producer exists: until retro.py emits `leftovers`, every test that
needs it fails with "producer missing". Temp git repos only. Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_contract_leftovers import SCRIPT, br, fo, git, _rm_onerror
from test_contract_retro import TOP_KEYS

NR = "not recorded"
EMPTY = {"branches": [], "folders": [], "count": 0}
TS = "2026-10-27T09:01:00.000Z"


def spawn(agent_id, **over):
    e = {"v": 1, "ts": TS, "event": "spawn", "crew": "c", "agent": "c", "agentId": agent_id,
         "type": "foundry:lead", "model": "opus", "effort": "high", "by": "main"}
    e.update(over)
    return json.dumps(e)


class LeftoversEdges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leftovers-edges-")
        self.addCleanup(shutil.rmtree, self.tmp, onerror=_rm_onerror)
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q")
        with open(os.path.join(self.repo, "f.txt"), "w") as fh:
            fh.write("x\n")
        git(self.repo, "add", "f.txt")
        git(self.repo, "commit", "-q", "-m", "one")
        self.session = os.path.join(self.repo, ".git", "foundry", "S1")

    def put(self, lines, name="events.jsonl", dest=None):
        dest = dest or self.session
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")
        return dest

    def run_retro(self, path=None, env=None):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        r = subprocess.run([sys.executable, SCRIPT, path or self.session], capture_output=True, text=True,
                           encoding="utf-8", timeout=60, env=env)
        self.assertEqual(r.returncode, 0, "exit %s, stderr: %s" % (r.returncode, r.stderr.strip()))
        return json.loads(r.stdout)

    def leftovers(self, path=None, env=None):
        out = self.run_retro(path, env)
        self.assertIn("leftovers", out, "producer missing: retro.py emits no leftovers key")
        return out["leftovers"]

    def branch(self, i):
        git(self.repo, "branch", br(i))

    def mkfolder(self, i):
        os.makedirs(os.path.join(self.repo, *fo(i).split("/")))

    # ---- layout ----

    def test_bare_repo_is_not_recorded(self):
        bare = os.path.join(self.tmp, "x.git")
        git(self.tmp, "init", "-q", "--bare", bare)
        d = self.put([spawn("a1")], dest=os.path.join(bare, "foundry", "S1"))
        self.assertEqual(self.leftovers(d), NR)

    def test_no_events_file_is_not_recorded(self):
        os.makedirs(self.session)
        with open(os.path.join(self.session, "decisions.md"), "w") as fh:
            fh.write("# d\n")
        self.put([spawn("a1")], name="messages.jsonl")  # not an events*.jsonl file
        self.assertEqual(self.leftovers(), NR)

    def test_events_without_spawns_is_zero_not_unrecorded(self):
        self.put([json.dumps({"v": 1, "ts": TS, "event": "stall", "agentId": "a1"})])
        self.branch("a1")
        self.assertEqual(self.leftovers(), EMPTY)

    # ---- agent ids ----

    def test_ids_come_from_every_events_file_without_decisions(self):
        self.put([spawn("a1")])
        self.put([spawn("b2")], name="events.1.jsonl")
        self.put([spawn("c3")], name="events-2026.jsonl")
        for i in ("a1", "b2", "c3", "d4"):
            self.branch(i)
        self.assertEqual(self.leftovers(), {"branches": [br(i) for i in ("a1", "b2", "c3")], "folders": [], "count": 3})

    def test_invalid_lines_are_ignored(self):
        lines = ["not json {", spawn("a1", v=2), spawn("b2", ts="yesterday"), spawn("c3"), "", "[1]"]
        self.put(lines)
        for i in ("a1", "b2", "c3"):
            self.branch(i)
        self.assertEqual(self.leftovers(), {"branches": [br("c3")], "folders": [], "count": 1})

    def test_only_spawn_events_contribute_ids(self):
        self.put([json.dumps({"v": 1, "ts": TS, "event": "stall", "agentId": "s9"}), spawn("a1")])
        self.branch("s9")
        self.branch("a1")
        self.assertEqual(self.leftovers(), {"branches": [br("a1")], "folders": [], "count": 1})

    def test_malformed_ids_are_ignored_and_do_not_crash(self):
        bad = ["../x", "A1B2", "", 123, None, "a b", "a/b", "a-b"]
        self.put([spawn(b) for b in bad] + [spawn("ok1")])
        self.branch("ok1")
        os.makedirs(os.path.join(self.repo, ".claude", "worktrees", "x"))
        self.assertEqual(self.leftovers(), {"branches": [br("ok1")], "folders": [], "count": 1})

    def test_event_without_agent_id_key(self):
        e = json.loads(spawn("a1"))
        del e["agentId"]
        self.put([json.dumps(e), spawn("b2")])
        self.branch("b2")
        self.assertEqual(self.leftovers(), {"branches": [br("b2")], "folders": [], "count": 1})

    # ---- branches ----

    def test_only_exact_local_branches_count(self):
        self.put([spawn("a1")])
        git(self.repo, "update-ref", "refs/remotes/origin/" + br("a1"), "HEAD")
        self.branch("a1-old")
        self.branch("zz9")  # not spawned
        self.assertEqual(self.leftovers(), EMPTY)

    # ---- folders ----

    def test_regular_file_at_folder_path_does_not_count(self):
        self.put([spawn("a1")])
        os.makedirs(os.path.join(self.repo, ".claude", "worktrees"))
        with open(os.path.join(self.repo, *fo("a1").split("/")), "w") as fh:
            fh.write("x")
        self.assertEqual(self.leftovers(), EMPTY)

    def test_folder_string_is_relative_with_forward_slashes(self):
        self.put([spawn("a1"), spawn("a1")])
        self.mkfolder("a1")
        got = self.leftovers()
        self.assertEqual(got["folders"], [".claude/worktrees/agent-a1"])
        self.assertEqual(got["count"], 1)

    # ---- environment ----

    def test_git_unavailable_is_not_recorded_and_rest_intact(self):
        self.put([spawn("a1")])
        self.branch("a1")
        empty = os.path.join(self.tmp, "emptybin")
        os.mkdir(empty)
        env = dict(os.environ, PATH=empty)
        out = self.run_retro(env=env)
        self.assertIn("leftovers", out, "producer missing: retro.py emits no leftovers key")
        self.assertEqual(out["leftovers"], NR)
        self.assertEqual(set(out.keys()), TOP_KEYS)

    def test_run_changes_nothing_in_the_repo(self):
        self.put([spawn("a1"), spawn("b2")])
        self.branch("a1")
        self.mkfolder("b2")
        idx = os.path.join(self.repo, ".git", "index")

        def state():
            data = open(idx, "rb").read() if os.path.exists(idx) else None
            return (git(self.repo, "for-each-ref"), git(self.repo, "worktree", "list", "--porcelain"), data)

        before = state()
        self.assertEqual(self.leftovers()["count"], 2)
        self.assertEqual(state(), before)

    def test_retro_source_never_mentions_slots(self):
        if not os.path.isfile(SCRIPT):
            self.fail("producer missing: retro.py not found at %s" % SCRIPT)
        with open(SCRIPT, encoding="utf-8") as fh:
            self.assertNotIn("slots", fh.read().lower())

    def test_odd_slots_json_changes_nothing(self):
        self.put([spawn("a1")])
        self.branch("a1")
        base = os.path.join(self.repo, ".git", "claude-worktrees")
        os.makedirs(base)
        for kind in ("dir", "garbage"):
            with self.subTest(kind):
                p = os.path.join(base, "slots.json")
                if os.path.isdir(p):
                    os.rmdir(p)
                if kind == "dir":
                    os.mkdir(p)
                else:
                    with open(p, "wb") as fh:
                        fh.write(b"\xff\xfe\x00{{{ not json")
                self.assertEqual(self.leftovers(), {"branches": [br("a1")], "folders": [], "count": 1})

    # ---- the rest of retro ----

    def test_spawn_outside_any_run_and_split_unchanged(self):
        self.put([spawn("a1")])  # no decisions.md, no run headings
        self.branch("a1")
        out = self.run_retro()
        self.assertIn("leftovers", out, "producer missing: retro.py emits no leftovers key")
        self.assertEqual(out["leftovers"], {"branches": [br("a1")], "folders": [], "count": 1})
        self.assertEqual(out["split"], NR)
        outside = self.put([spawn("a1")], dest=os.path.join(self.tmp, "plain", "S1"))
        other = self.run_retro(outside)
        self.assertEqual(out["runs"], other["runs"])
        self.assertEqual(out["split"], other["split"])


if __name__ == "__main__":
    unittest.main()
