"""kit_mine.py against synthetic transcripts. Run: python -m unittest discover -s plugins/kit/tests"""
import filecmp
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")
sys.path.insert(0, SCRIPTS)
import kit_mine  # noqa: E402

CWD = os.path.join(os.path.abspath(os.sep), "work", "app")
N = [0]


def rec(kind, **kw):
    N[0] += 1
    base = {"type": kind, "timestamp": "2026-10-01T09:%02d:00.000Z" % (N[0] % 60), "cwd": CWD, "sessionId": "s"}
    base.update(kw)
    return base


def human(text):
    return rec("user", message={"role": "user", "content": text})


def tool(name, **inp):
    N[0] += 1
    return rec("assistant", message={"id": "r%d" % N[0], "role": "assistant", "model": "m",
                                     "content": [{"type": "tool_use", "id": "t%d" % N[0], "name": name, "input": inp}]})


def say(text):
    N[0] += 1
    return rec("assistant", message={"id": "r%d" % N[0], "role": "assistant", "model": "m",
                                     "content": [{"type": "text", "text": text}]})


def write(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def subagent(proj, session, agent_id, agent_type, desc, brief, report, model="sonnet"):
    base = os.path.join(proj, session, "subagents", "agent-" + agent_id)
    write(base + ".jsonl", [human(brief), say("working"), say(report)])
    with open(base + ".meta.json", "w", encoding="utf8") as f:
        json.dump({"agentType": agent_type, "description": desc, "model": model}, f)


RELEASE = [tool("Bash", command="npm run lint -- --fix"), tool("Bash", command="npm test"),
           tool("Bash", command="git add -A && git commit -m \"x\"")]
REVIEW_A = "Findings:\n- Missing error handling when the config file is absent\n- Unused import in server.ts left behind"
REVIEW_B = "Findings:\n1. Missing error handling when the cache file is absent\n2. Variable naming is inconsistent here"
BRIEF = ("Add the endpoint for {} to the API router, following the existing handler pattern in routes, "
         "with validation and a unit test; run npm test before reporting.")


class Mine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        projects = os.path.join(cls.tmp, "projects")
        proj = os.path.join(projects, kit_mine.slugify(CWD))
        wt = os.path.join(projects, kit_mine.slugify(os.path.join(CWD, ".claude", "worktrees", "feat")))
        other = os.path.join(projects, kit_mine.slugify(CWD + "2"))
        write(os.path.join(proj, "s1.jsonl"),
              [human("please ship the release notes for this week"),
               tool("Skill", skill="kit:revise")] + RELEASE +
              [tool("Agent", description="add users endpoint", subagent_type="kit:builder", prompt="x"),
               human("<command-name>/deploy</command-name><command-args></command-args>")])
        write(os.path.join(wt, "s2.jsonl"), [human("please ship the release notes for this week")] + RELEASE)
        write(os.path.join(proj, "s3.jsonl"), [human("please ship the release notes for this week!")])
        write(os.path.join(other, "s9.jsonl"), RELEASE + RELEASE)  # a different project: ignored
        old = os.path.join(proj, "s0.jsonl")
        write(old, RELEASE)
        t = time.time() - 90 * 86400
        os.utime(old, (t, t))

        subagent(proj, "s1", "a1", "kit:builder", "users endpoint", BRIEF.format("users"), "done")
        subagent(proj, "s1", "a2", "general-purpose", "orders endpoint", BRIEF.format("orders"), "done")
        subagent(proj, "s1", "a3", "kit:reviewer", "review diff", "Review the diff on this branch.", REVIEW_A, "opus")
        subagent(wt, "s2", "a4", "kit:reviewer", "review diff", "Review the diff on this branch.", REVIEW_B, "opus")

        claude = os.path.join(cls.tmp, "repo", ".claude")
        os.makedirs(os.path.join(claude, "agents"))
        os.makedirs(os.path.join(claude, "commands"))
        open(os.path.join(claude, "agents", "migrator.md"), "w").close()
        open(os.path.join(claude, "commands", "deploy.md"), "w").close()
        cls.out = kit_mine.mine(CWD, projects, 30, claude_dir=claude)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_window_reads_project_and_its_worktrees_only(self):
        w = self.out["window"]
        self.assertEqual(len(w["project_dirs"]), 2)
        self.assertEqual(w["sessions"], 3)  # s0 is outside the window, s9 is another project
        self.assertEqual(w["subagent_runs"], 4)
        self.assertEqual(w["reviews"], 2)

    def test_repeated_command_sequence(self):
        seqs = [c["sequence"] for c in self.out["commands"]]
        self.assertIn(["npm run lint", "npm test", "git add", "git commit"], seqs)
        top = self.out["commands"][0]
        self.assertEqual(top["sessions"], 2)
        # shorter sequences inside the longer one, seen in no more sessions, are dropped
        self.assertNotIn(["npm test", "git add"], seqs)

    def test_repeated_prompt_and_slash_command(self):
        rep = self.out["prompts"]["repeated"]
        self.assertEqual(len(rep), 1)
        self.assertEqual(rep[0]["count"], 3)
        self.assertEqual(self.out["prompts"]["slash_commands"], {"/deploy": 1})

    def test_similar_briefs_cluster(self):
        b = self.out["briefs"]
        self.assertEqual(len(b), 2)  # the endpoint briefs, and the two review briefs
        ep = next(x for x in b if "kit:builder" in x["types"])
        self.assertEqual(ep["runs"], 2)
        self.assertEqual(ep["types"], {"kit:builder": 1, "general-purpose": 1})

    def test_recurring_review_finding(self):
        f = self.out["findings"]
        self.assertEqual(len(f), 1)
        self.assertEqual(f[0]["reviews"], 2)
        self.assertIn("error handling", f[0]["sample"])

    def test_kit_usage(self):
        uses = {(k["kind"], k["name"]): k["uses"] for k in self.out["kit"]}
        self.assertEqual(uses[("agent", "builder")], 1)
        self.assertEqual(uses[("agent", "migrator")], 0)
        self.assertEqual(uses[("command", "deploy")], 1)
        self.assertEqual(uses[("skill", "revise")], 1)

    def test_output_is_small(self):
        self.assertLess(len(json.dumps(self.out)), 8000)


class Helpers(unittest.TestCase):
    def test_slugify_matches_claude_code(self):
        self.assertEqual(kit_mine.slugify(r"C:\sw\claude-mods"), "C--sw-claude-mods")
        self.assertEqual(kit_mine.slugify("/home/abd/my.app"), "-home-abd-my-app")

    def test_command_heads(self):
        self.assertEqual(kit_mine.command_heads('cd x && npm run build --prod | tee log.txt'),
                         ["npm run build", "tee"])
        self.assertEqual(kit_mine.command_heads("pytest tests/unit -q"), ["pytest"])
        self.assertEqual(kit_mine.command_heads("for f in *; do echo $f; done"), [])

    def test_finding_lines(self):
        self.assertEqual(kit_mine.finding_lines("Intro\n- short\n- a real finding about naming\n2) another real finding here"),
                         ["a real finding about naming", "another real finding here"])

    def test_vendored_parser_matches_workflow_audit(self):
        src = os.path.join(HERE, "..", "..", "workflow-audit", "scripts")
        if not os.path.isdir(src):
            self.skipTest("workflow-audit not alongside")
        for name in ("wa_parse.py", "wa_common.py"):
            self.assertTrue(filecmp.cmp(os.path.join(src, name), os.path.join(SCRIPTS, name), shallow=False),
                            name + " drifted from plugins/workflow-audit; copy it again")


if __name__ == "__main__":
    unittest.main()
