"""Extra edge cases for retro's 0.8.0 per-run keys (fetches, extendPasses, defaultDecisions, openOwnerActions).
Complements test_contract_retro_080.py. Everything is built in a tempdir; names are invented.
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
NR = "not recorded"
DECISIONS = ("# Decisions\n## Run 2026-10-27T09:00:00Z | first\n- 09:05 | a | b | cynic: none | followed\n"
             "## Run 2026-10-28T09:00:00Z | second\n- 09:05 | a | b | cynic: none | followed\n")
SPAWN = ('{"v":1,"ts":"2026-10-27T09:01:00.000Z","event":"spawn","crew":"c","agent":"c","agentId":"e0",'
         '"type":"x","model":"opus","effort":"high","by":"main"}\n')


def fetch(ts, agent="c-writer"):
    ev = {"v": 1, "ts": ts, "event": "fetch", "crew": "c", "tool": "WebFetch", "url": "https://docs.invalid/x"}
    if agent is not None:
        ev["agent"] = agent
    return json.dumps(ev) + "\n"


def git(cwd, date, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="T", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="T", GIT_COMMITTER_EMAIL="t@example.invalid",
               GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(r.stderr)


def put(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data.encode("utf-8"))


class Retro080Edges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="retro080x-")
        self.n = 0

    def tearDown(self):
        def onerr(fn, p, _):
            os.chmod(p, 0o700)
            fn(p)
        shutil.rmtree(self.tmp, onerror=onerr)

    def repo(self, events, files=None, commits=()):
        self.n += 1
        repo = os.path.join(self.tmp, "r%d" % self.n)
        os.makedirs(repo)
        git(repo, "2026-10-01T00:00:00Z", "init", "-q")
        git(repo, "2026-10-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "chore: start")
        for rel, data in (files or {}).items():
            put(os.path.join(repo, rel), data)
        for date, subject in commits:
            git(repo, date, "commit", "-q", "--allow-empty", "-m", subject)
        sess = os.path.join(repo, ".git", "foundry", "s")
        put(os.path.join(sess, "decisions.md"), DECISIONS)
        put(os.path.join(sess, "events.jsonl"), events)
        return sess

    def runs(self, sess):
        r = subprocess.run([sys.executable, SCRIPT, sess], capture_output=True, text=True,
                           encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["runs"]

    def test_fetches_only_in_run_two(self):
        sess = self.repo(SPAWN + fetch("2026-10-28T10:00:00.000Z") + fetch("2026-10-28T10:01:00.000Z", None))
        a, b = self.runs(sess)
        self.assertEqual(a["fetches"], {"total": 0, "perAgent": {}})
        self.assertEqual(b["fetches"], {"total": 2, "perAgent": {"c-writer": 1, "unset": 1}})

    def test_outside_repo_layout_is_not_recorded(self):
        sess = os.path.join(self.tmp, "plain", "s")
        put(os.path.join(sess, "decisions.md"), DECISIONS)
        put(os.path.join(sess, "events.jsonl"), SPAWN + fetch("2026-10-27T10:00:00.000Z"))
        runs = self.runs(sess)
        for run in runs:
            self.assertEqual(run["extendPasses"], NR)
            self.assertEqual(run["defaultDecisions"], NR)
            self.assertEqual(run["openOwnerActions"], NR)
        self.assertEqual(runs[0]["fetches"]["total"], 1)

    def test_git_readable_without_matching_subject_is_zero(self):
        sess = self.repo(SPAWN, commits=[("2026-10-27T10:00:00Z", "feat: extend nothing")])
        self.assertEqual([r["extendPasses"] for r in self.runs(sess)], [0, 0])

    def test_adr_key_pointing_at_missing_dir_is_not_recorded(self):
        sess = self.repo(SPAWN, {".claude/foundry.json": json.dumps({"adr": "docs/nope"})})
        self.assertEqual(self.runs(sess)[0]["defaultDecisions"], NR)

    def test_crlf_adr_counts_and_non_md_ignored(self):
        sess = self.repo(SPAWN, {".claude/foundry.json": json.dumps({"adr": "adr"}),
                                 "adr/0001-a.md": "# A\r\nDecided by: default\r\n",
                                 "adr/0002-b.md": "# B\r\nDecided by: owner\r\n",
                                 "adr/notes.txt": "Decided by: default\n"})
        self.assertEqual(self.runs(sess)[0]["defaultDecisions"], 1)

    def test_checked_and_other_heading_boxes_not_counted(self):
        doc = ("# Arch\n## Notes\n- [ ] not mine\n## Owner actions\n- [x] done\n- [ ] open one\n"
               "- [ ] open two\n### Sub\n- [ ] under sub heading\n# Owner actions\r\n- [ ] top level\r\n")
        sess = self.repo(SPAWN, {".claude/foundry.json": json.dumps({"architecture": "arch.md"}),
                                 "arch.md": doc})
        self.assertEqual(self.runs(sess)[0]["openOwnerActions"], 3)


if __name__ == "__main__":
    unittest.main()
