"""Project labels for worktrees and scratch dirs, plugins_installed, CLAUDE.md mtime."""
import json
import os
import tempfile
import unittest

import helpers  # noqa: F401
import wa_m_context
import wa_m_meta
import wa_model
from wa_common import project_name, resolve_cwd
from test_step1b import ctx_of, session


class Labels(unittest.TestCase):
    def test_worktree_segments(self):
        for cwd in (r"C:\sw\app\.run-worktrees\2026-10-01-x", "/h/app/.claude/worktrees/feat", "/h/app/.worktrees/a/b"):
            self.assertEqual(project_name(cwd), "app", cwd)
        self.assertEqual(project_name("/h/app/.git/hooks"), "hooks")

    def test_scratch_slug_resolved_against_known_names(self):
        cwds = ["/h/Documents/sw/code-shop-app", "C:/sw/resume",
                "C:/Users/x/AppData/Local/Temp/claude/C--sw-resume/abc/scratchpad/e2e",
                "/private/tmp/claude-501/-Users-x-Documents-sw-code-shop-app/abc/scratchpad",
                "/tmp/claude/-Users-x-Documents-sw-unknown-thing/id"]
        ss = [session("s%07d" % i, cwd=c) for i, c in enumerate(cwds)]
        wa_model.assign_project_names(ss)
        self.assertEqual([s["project"] for s in ss], ["code-shop-app", "resume", "resume", "code-shop-app", "thing"])

    def test_same_name_different_owners_still_disambiguated(self):
        ss = [session("a0000000", cwd="/x/one/app"), session("b0000000", cwd="/x/two/app"),
              session("c0000000", cwd="/x/two/app/.worktrees/w")]
        wa_model.assign_project_names(ss)
        self.assertEqual([s["project"] for s in ss], ["app (one)", "app (two)", "app (two)"])
        self.assertEqual(resolve_cwd("/a/b")[0], "b")


class Meta(unittest.TestCase):
    def test_plugins_installed_and_mtime(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".claude", "plugins"))
            with open(os.path.join(home, ".claude", "plugins", "installed_plugins.json"), "w") as f:
                json.dump({"version": 2, "plugins": {"p@m": [{"version": "1.0", "installedAt": "2026-03-01T21:00:37.079Z"}]}}, f)
            self.assertEqual(wa_m_meta.plugins_installed(home),
                             [{"name": "p@m", "version": "1.0", "installed_at": "2026-03-01T21:00:37.079Z"}])
            self.assertIsNone(wa_m_meta.plugins_installed(os.path.join(home, "nope")))
            with open(os.path.join(home, ".claude", "CLAUDE.md"), "w") as f:
                f.write("a\n")
            os.utime(os.path.join(home, ".claude", "CLAUDE.md"), (1790000000, 1790000000))
            m = wa_m_context.claude_md(ctx_of(session("a1111111", cwd=home), home=home))["context.claude_md"]
            self.assertEqual(m["global"]["mtime"], "2026-09-21T14:13:20Z")
            self.assertEqual(m["paths"][0]["mtime"], "2026-09-21T14:13:20Z")


class ScratchAndWorktreeLabels(unittest.TestCase):
    def test_scratchpad_worktree_and_nested_hidden_folder(self):
        from wa_common import resolve_cwd, slug_name
        known = ["shop-app", "shop"]
        cases = {
            "/private/tmp/claude-502/-Users-a-code-shop-app/0a0b0c0d/scratchpad/qual5/x/run1/.run-worktrees/w1": "shop-app",
            "/Users/a/code/shop-app/.hardening/sync-main/.run-worktrees/w2": "shop-app",
            "C:\sw\proj\.claude\worktrees\feat-x": "proj",
            "/Users/a/code/plain": "plain",
            "/home/u/.hermes/cache/scratch/tmpX/kb/scratchpad/q1/run1/.run-worktrees/w1": "kb",
        }
        for cwd, want in cases.items():
            name, _owner, slug = resolve_cwd(cwd)
            self.assertEqual(slug_name(slug, known) if slug else name, want, cwd)


class ClaudeMdImports(unittest.TestCase):
    def test_imports_agents_md_and_scratchpad_cut(self):
        import tempfile
        from wa_common import resolve_cwd
        from wa_m_context import count_lines, project_files
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "AGENTS.md"), "w") as f:
                f.write("a\nb\nc\n")
            self.assertEqual(sum(v["lines"] for v in project_files(d).values()), 3)   # AGENTS.md alone
            with open(os.path.join(d, "CLAUDE.md"), "w") as f:
                f.write("intro\n@AGENTS.md\nwrite to me@example.com\n")
            self.assertEqual(count_lines(os.path.join(d, "CLAUDE.md")), 6)          # 3 + imported 3
            self.assertEqual(len(project_files(d)), 1)                              # AGENTS.md now via import only
        name, _o, _s = resolve_cwd("/Users/a/code/shop-app/kb-hard/scratchpad/q1/run1/.run-worktrees/w")
        self.assertEqual(name, "kb-hard")


class CleanedUpWorktrees(unittest.TestCase):
    def test_gone_worktree_reads_its_project_root(self):
        import tempfile
        from wa_m_context import readable_root
        with tempfile.TemporaryDirectory() as d:
            gone = os.path.join(d, "kb", "scratchpad", "q1", "run1", ".run-worktrees", "w1")
            os.makedirs(os.path.join(d, "kb"))
            self.assertEqual(os.path.normcase(readable_root(gone)), os.path.normcase(os.path.join(d, "kb")))
            really_gone = os.path.join(d, "renamed-project")
            self.assertEqual(readable_root(really_gone), really_gone)


class ProjectRootWins(unittest.TestCase):
    def test_root_folder_reported_over_scratch_copy(self):
        from wa_m_context import is_root
        self.assertTrue(is_root(r"C:\sw\resume", "resume"))
        self.assertFalse(is_root(r"C:\Users\a\AppData\Local\Temp\claude\C--sw-resume\s1\scratchpad\sbx2", "resume"))
