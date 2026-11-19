"""kit 0.5.0: scripts/kit_scan.py lists stack-areas and industry evidence on fixture repos.

The scan names no industry. It returns evidence (README title and first paragraph, entity names, the
most frequent domain nouns, each with its file), and the model reads it in /kit:init.

The fixtures under tests/fixtures/stacks are small repos: a JVM backend, a TypeScript frontend, a Python
service, and a dev tool with no industry at all.

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

KEYWORDS = {"return", "class", "public", "private", "import", "from", "const", "async", "await", "def", "string",
            "void", "export", "interface", "true", "false", "null", "none", "self", "this", "new", "static"}
INDUSTRY_WORDS = {"patient", "patients", "appointment", "clinician", "order", "orders", "cart", "checkout", "ledger",
                  "journal", "debit", "credit", "payments", "sku", "shipment", "balance", "transaction", "kyc"}


def scan(name):
    return kit_scan.scan(os.path.join(FIXTURES, name))


def nouns(r):
    return {n["noun"] for n in r["evidence"]["nouns"]}


def entities(r):
    return {(e["name"], e["file"]) for e in r["evidence"]["entities"]}


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

    def test_evidence_holds_readme_entity_and_nouns(self):
        ev = self.r["evidence"]
        self.assertEqual(ev["readmes"][0]["path"], "README.md")
        self.assertEqual(ev["readmes"][0]["title"], "clinic-api")
        self.assertIn("Appointment booking", ev["readmes"][0]["first_paragraph"])
        self.assertIn(("Appointment", "src/main/java/com/clinic/appointments/Appointment.java"), entities(self.r))
        self.assertTrue({"appointment", "patient", "clinician"} <= nouns(self.r))

    def test_controller_and_repository_are_not_entities(self):
        self.assertEqual({n for n, _ in entities(self.r)}, {"Appointment"})


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

    def test_evidence_holds_entities_and_nouns(self):
        self.assertIn(("Order", "src/types/order.ts"), entities(self.r))
        self.assertIn(("OrderLine", "src/types/order.ts"), entities(self.r))
        self.assertTrue({"order", "sku"} <= nouns(self.r))
        self.assertIn("storefront", self.r["evidence"]["readmes"][0]["first_paragraph"].lower())


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

    def test_evidence_holds_entity_and_nouns(self):
        self.assertIn(("JournalEntry", "app/models.py"), entities(self.r))
        self.assertTrue({"journal", "debit", "credit"} <= nouns(self.r))


class NoIndustryGuess(unittest.TestCase):
    def test_output_has_no_industry_field_anywhere(self):
        for name in ("clinic-api", "shop-web", "ledger-service", "buildtool-cli"):
            r = scan(name)
            self.assertNotIn("industry", r)
            self.assertNotIn("industry", r["evidence"])

    def test_every_evidence_item_names_its_file(self):
        for name in ("clinic-api", "shop-web", "ledger-service"):
            ev = scan(name)["evidence"]
            self.assertTrue(all(e["file"] for e in ev["entities"]))
            self.assertTrue(ev["nouns"])
            for n in ev["nouns"]:
                self.assertTrue(n["files"])
                self.assertGreaterEqual(n["count"], 1)

    def test_language_keywords_never_appear_as_domain_nouns(self):
        for name in ("clinic-api", "shop-web", "ledger-service", "buildtool-cli"):
            self.assertEqual(nouns(scan(name)) & KEYWORDS, set(), name)

    def test_dev_tool_yields_no_healthcare_retail_or_fintech_nouns(self):
        r = scan("buildtool-cli")
        self.assertEqual(nouns(r) & INDUSTRY_WORDS, set())
        self.assertEqual(r["evidence"]["entities"], [])
        self.assertIn("build", r["evidence"]["readmes"][0]["first_paragraph"].lower())

    def test_the_fixtures_differ_in_their_evidence(self):
        tops = [tuple(n["noun"] for n in scan(x)["evidence"]["nouns"][:3])
                for x in ("clinic-api", "shop-web", "ledger-service", "buildtool-cli")]
        self.assertEqual(len(set(tops)), 4)


class StackDetail(unittest.TestCase):
    def mk(self, d, files):
        for rel, text in files.items():
            p = os.path.join(d, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)

    def test_plain_js_package_json_is_javascript_not_typescript(self):
        with tempfile.TemporaryDirectory() as d:
            self.mk(d, {"package.json": '{"name": "x", "dependencies": {"express": "^4.0.0"}}'})
            s = kit_scan.scan(d)["stacks"][0]
        self.assertEqual((s["stack"], s["framework"]), ("javascript", "node"))

    def test_tsconfig_or_typescript_dependency_makes_it_typescript(self):
        with tempfile.TemporaryDirectory() as d:
            self.mk(d, {"package.json": '{"name": "x"}', "tsconfig.json": "{}"})
            self.assertEqual(kit_scan.scan(d)["stacks"][0]["stack"], "typescript")
        with tempfile.TemporaryDirectory() as d:
            self.mk(d, {"package.json": '{"devDependencies": {"typescript": "^5"}}'})
            self.assertEqual(kit_scan.scan(d)["stacks"][0]["stack"], "typescript")

    def test_framework_comes_from_dependency_keys_not_manifest_text(self):
        with tempfile.TemporaryDirectory() as d:
            self.mk(d, {"package.json": '{"description": "not react, vite or next", "dependencies": {"express": "1"}}'})
            self.assertEqual(kit_scan.scan(d)["stacks"][0]["framework"], "node")
        with tempfile.TemporaryDirectory() as d:
            self.mk(d, {"package.json": '{"dependencies": {"next": "14", "react": "18"}}'})
            self.assertEqual(kit_scan.scan(d)["stacks"][0]["framework"], "nextjs")


class MonorepoAndEmpty(unittest.TestCase):
    def test_monorepo_gives_one_area_per_manifest_directory(self):
        r = kit_scan.scan(FIXTURES)  # the fixtures side by side form a monorepo
        areas = sorted((s["area"], s["stack"]) for s in r["stacks"])
        self.assertEqual(areas, [("buildtool-cli", "python"), ("clinic-api", "jvm"), ("ledger-service", "python"),
                                 ("shop-web", "typescript")])

    def test_repo_with_a_bare_readme_has_evidence_and_no_stacks_or_nouns(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "README.md"), "w", encoding="utf-8") as f:
                f.write("# tool\n\nA small thing.\n")
            r = kit_scan.scan(d)
        self.assertEqual(r["stacks"], [])
        self.assertEqual(r["evidence"]["readmes"][0]["first_paragraph"], "A small thing.")
        self.assertEqual(r["evidence"]["nouns"], [])

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
        self.assertEqual(json.loads(out.stdout)["stacks"][0]["stack"], "typescript")


if __name__ == "__main__":
    unittest.main()
