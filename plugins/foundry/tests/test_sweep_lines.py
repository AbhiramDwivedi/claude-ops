"""retro.py counts the foreman's `sweep keep|drop` log lines as ordinary decisions (foundry 0.9.2).

All data is synthetic and written to a temp dir (P8).
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


class SweepLines(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="retro-sweep-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_sweep_lines_count_as_followed_decisions(self):
        text = ("## Run 2026-10-29T10:00:00Z | g\n"
                "- 10:01 | sweep drop: README omits id | doc drift | cynic-5 | followed\n"
                "- 10:02 | sweep keep: remove_tree hides an OSError | a leak goes unseen | cynic-5 | followed\n")
        with open(os.path.join(self.dir, "decisions.md"), "w", encoding="utf-8", newline="") as f:
            f.write(text)
        r = subprocess.run([sys.executable, SCRIPT, self.dir], capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
        run = json.loads(r.stdout.decode("utf-8"))["runs"][0]
        self.assertEqual(run["decisions"]["total"], 2)
        self.assertEqual(run["decisions"]["followed"], 2)
        self.assertEqual(run["recommendations"]["total"], 0)
        self.assertEqual(run["freeform"], 0)


if __name__ == "__main__":
    unittest.main()
