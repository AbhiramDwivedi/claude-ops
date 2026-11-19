"""kit 0.5.0: scripts/kit_scan.py detects stack-areas and industry signals on fixture repos.

The fixtures under tests/fixtures/stacks are small repos of distinct stacks: a JVM backend, a TypeScript
frontend and a Python service, each with an industry signal in its README and data model.

Run: python -m unittest discover -s plugins/kit/tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")
FIXTURES = os.path.join(HERE, "fixtures", "stacks")
sys.path.insert(0, SCRIPTS)

import kit_scan  # noqa: E402


def scan(name):
    return kit_scan.scan(os.path.join(FIXTURES, name))


class JvmBackend(unittest.TestCase):
    def setUp(self):
        self.r = scan("clinic-api")

    def test_one_jvm_stack_area(self):
        self.assertEqual([(s["stack"], s["framework"], s["area"]) for s in self.r["stacks"]],
                         [("jvm", "spring-boot", ".")])

    def test_cites_manifest_and_layer_files(self):
        cite = self.r["stacks"][0]["cite"]
        self.assertEqual(self.r["stacks"][0]["manifest"], "build.gradle.kts")
        base = "src/main/java/com/clinic/appointments/"
        for name in ("AppointmentController.java", "AppointmentRepository.java", "Appointment.java"):
            self.assertIn(base + name, cite)

    def test_industry_is_healthcare_from_readme_and_model(self):
        ind = self.r["industry"]
        self.assertEqual(ind["name"], "healthcare")
        files = {s["file"] for s in ind["signals"]}
        self.assertIn("README.md", files)
        self.assertTrue(any(f.endswith("Appointment.java") for f in files))
        self.assertIn("README.md", ind["files_read"])


class TypeScriptFrontend(unittest.TestCase):
    def setUp(self):
        self.r = scan("shop-web")

    def test_one_typescript_stack_area(self):
        self.assertEqual([(s["stack"], s["framework"], s["area"]) for s in self.r["stacks"]],
                         [("typescript", "react-vite", ".")])

    def test_cites_api_client_component_and_types(self):
        cite = self.r["stacks"][0]["cite"]
        for f in ("package.json", "src/api/client.ts", "src/components/OrderList.tsx", "src/types/order.ts"):
            self.assertIn(f, cite)

    def test_industry_is_retail(self):
        self.assertEqual(self.r["industry"]["name"], "retail")


class PythonService(unittest.TestCase):
    def setUp(self):
        self.r = scan("ledger-service")

    def test_one_python_stack_area(self):
        self.assertEqual([(s["stack"], s["framework"], s["area"]) for s in self.r["stacks"]],
                         [("python", "fastapi", ".")])

    def test_cites_models_app_and_tests(self):
        cite = self.r["stacks"][0]["cite"]
        for f in ("pyproject.toml", "app/models.py", "app/main.py", "tests/ledger_tests.py"):
            self.assertIn(f, cite)

    def test_industry_is_fintech(self):
        self.assertEqual(self.r["industry"]["name"], "fintech")


class Distinct(unittest.TestCase):
    def test_the_three_fixtures_have_three_distinct_stacks_and_industries(self):
        rs = [scan(n) for n in ("clinic-api", "shop-web", "ledger-service")]
        self.assertEqual(len({r["stacks"][0]["stack"] for r in rs}), 3)
        self.assertEqual(len({r["industry"]["name"] for r in rs}), 3)


class MonorepoAndUnknown(unittest.TestCase):
    def test_monorepo_gives_one_area_per_manifest_directory(self):
        r = kit_scan.scan(FIXTURES)  # the three fixtures side by side form a monorepo
        areas = sorted((s["area"], s["stack"]) for s in r["stacks"])
        self.assertEqual(areas, [("clinic-api", "jvm"), ("ledger-service", "python"), ("shop-web", "typescript")])

    def test_repo_without_signals_says_unknown_so_the_person_is_asked(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "README.md"), "w", encoding="utf-8") as f:
                f.write("# tool\n\nA small thing.\n")
            r = kit_scan.scan(d)
        self.assertEqual(r["industry"]["name"], "unknown")
        self.assertEqual(r["stacks"], [])

    def test_skips_vendored_and_worktree_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            for sub in ("node_modules/x", ".claude/worktrees/w", "venv/lib"):
                os.makedirs(os.path.join(d, sub))
                with open(os.path.join(d, sub, "package.json"), "w", encoding="utf-8") as f:
                    f.write("{}")
            self.assertEqual(kit_scan.scan(d)["stacks"], [])


class Cli(unittest.TestCase):
    def test_prints_json(self):
        out = subprocess.run([sys.executable, os.path.join(SCRIPTS, "kit_scan.py"), "--repo",
                              os.path.join(FIXTURES, "shop-web")], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout)["industry"]["name"], "retail")


if __name__ == "__main__":
    unittest.main()
