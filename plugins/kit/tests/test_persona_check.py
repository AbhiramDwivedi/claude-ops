"""kit 0.5.0: scripts/kit_persona_check.py checks persona drafts deterministically.

The golden personas under tests/fixtures/stacks/<fixture>/expected-personas are what a model following
kit:init and kit:persona drafts for each fixture. The checker must pass them, and must fail on deliberately
bad personas with the right ERROR.

Run: python -m unittest discover -s plugins/kit/tests
"""
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "scripts")
FIXTURES = os.path.join(HERE, "fixtures", "stacks")
sys.path.insert(0, SCRIPTS)

import kit_persona_check as pc  # noqa: E402

GOLDENS = {
    "clinic-api": ["spring-boot-appointments-backend.md", "product-owner.md"],
    "shop-web": ["react-vite-storefront.md", "product-owner.md"],
    "ledger-service": ["fastapi-ledger-service.md", "product-owner.md"],
}


def repo(name):
    return os.path.join(FIXTURES, name)


def golden(name, file):
    return os.path.join(FIXTURES, name, "expected-personas", file)


def stack_persona(name, description, standards):
    body = "\n".join("%d. %s" % (i + 1, s) for i, s in enumerate(standards))
    return ("---\nname: %s\ndescription: %s\nmodel: sonnet\n---\n\n## Area\n\nx\n\n## Stack\n\nx\n\n"
            "## Standards\n\n%s\n\n## Proving it works\n\nx\n" % (name, description, body))


class TempFiles(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)

    def write(self, name, text):
        p = os.path.join(self._d.name, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p


class Goldens(unittest.TestCase):
    def test_every_golden_set_passes(self):
        for fixture, files in GOLDENS.items():
            paths = [golden(fixture, f) for f in files]
            for p in paths:
                self.assertTrue(os.path.isfile(p), p)
            self.assertEqual(pc.check(repo(fixture), paths), [], fixture)

    def test_goldens_are_stack_specific_across_fixtures(self):
        seen = {}
        for fixture, files in GOLDENS.items():
            p = golden(fixture, files[0])
            for n, text in pc.parse_standards(p):
                key = pc.normalise(text)
                self.assertNotIn(key, seen, "%s duplicates %s" % (p, seen.get(key)))
                seen[key] = p
        self.assertGreaterEqual(len(seen), 18)

    def test_every_golden_standard_cites_an_existing_file(self):
        for fixture, files in GOLDENS.items():
            for n, text in pc.parse_standards(golden(fixture, files[0])):
                cited = pc.cited_paths(text)
                ok = any(pc.path_exists(repo(fixture), c) for c in cited)
                self.assertTrue(ok or "ecosystem idiom" in text, "%s standard %d" % (fixture, n))

    def test_the_three_stack_personas_have_three_distinct_stacks(self):
        stacks = {pc.persona_stack(golden(f, files[0])) for f, files in GOLDENS.items()}
        self.assertEqual(stacks, {"jvm", "typescript", "python"})

    def test_product_owners_are_industry_specific_not_copies(self):
        texts = []
        for fixture in GOLDENS:
            with open(golden(fixture, "product-owner.md"), encoding="utf-8") as f:
                texts.append(f.read())
        self.assertEqual(len(set(texts)), 3)
        for needle, text in zip(("healthcare", "retail", "fintech"), texts):
            self.assertIn(needle, text)


class BadPersonas(TempFiles):
    def test_generic_standard_copied_into_two_stacks_is_flagged(self):
        std = "Keep `README.md` current and tell the reviewer what changed."
        a = self.write("spring-a.md", stack_persona("spring-boot-backend", "Spring Boot JVM backend", [std]))
        b = self.write("react-b.md", stack_persona("react-vite-frontend", "React TypeScript frontend", [std]))
        errors = pc.check(repo("clinic-api"), [a, b])
        self.assertTrue(any("react-b.md" in e and "duplicates a Standard of" in e and "spring-a.md" in e
                            for e in errors), errors)

    def test_same_sentence_with_a_different_path_is_still_a_duplicate(self):
        a = self.write("spring-a.md", stack_persona("spring-boot-backend", "Spring Boot JVM backend",
                                                    ["Controllers return `ResponseEntity`, see `README.md`."]))
        b = self.write("spring-b.md", stack_persona("spring-boot-other", "Spring Boot JVM backend",
                                                    ["Controllers return `ResponseEntity`, see `build.gradle.kts`."]))
        errors = pc.check(repo("clinic-api"), [a, b])
        self.assertTrue(any("duplicates a Standard of" in e for e in errors), errors)

    def test_standard_citing_a_missing_file_is_flagged(self):
        p = self.write("spring.md", stack_persona(
            "spring-boot-backend", "Spring Boot JVM backend",
            ["A controller returns `ResponseEntity`, as `src/main/java/com/clinic/Missing.java` does."]))
        errors = pc.check(repo("clinic-api"), [p])
        self.assertEqual(len(errors), 1, errors)
        self.assertRegex(errors[0], r"^ERROR: .*spring\.md: Standard 1 cites a path that does not exist: "
                                    r"src/main/java/com/clinic/Missing\.java")

    def test_standard_with_no_cited_path_is_flagged(self):
        p = self.write("spring.md", stack_persona("spring-boot-backend", "Spring Boot JVM backend",
                                                  ["A controller returns `ResponseEntity`."]))
        errors = pc.check(repo("clinic-api"), [p])
        self.assertTrue(any("Standard 1 cites no path" in e for e in errors), errors)

    def test_standard_with_no_stack_idiom_is_flagged(self):
        p = self.write("spring.md", stack_persona(
            "spring-boot-backend", "Spring Boot JVM backend",
            ["Write clean, well tested code and handle errors as `README.md` shows."]))
        errors = pc.check(repo("clinic-api"), [p])
        self.assertTrue(any("Standard 1 names nothing specific to the jvm stack" in e for e in errors), errors)

    def test_new_stacks_flag_a_standard_with_no_idiom_and_pass_one_with_an_idiom(self):
        cases = [("go", "golang-api", "Go golang service", "Return errors wrapped with `errors.Is` checks"),
                 ("rust", "rust-cli", "Rust cargo tool", "Run `cargo clippy` and deny warnings"),
                 ("dotnet", "dotnet-api", "ASP.NET dotnet API", "Register services through DI with `ILogger`"),
                 ("ruby", "rails-app", "Ruby on Rails app", "Scope queries with `ActiveRecord` scopes"),
                 ("php", "laravel-app", "PHP Laravel app", "Validate input with a Laravel form request")]
        for stack, name, desc, good in cases:
            bad = self.write(name + "-bad.md", stack_persona(name, desc,
                             ["Write clean, well tested code, as `README.md` shows."]))
            ok = self.write(name + "-ok.md", stack_persona(name, desc, [good + ", as `README.md` shows."]))
            errors = pc.check(repo("clinic-api"), [bad])
            self.assertTrue(any("names nothing specific to the %s stack" % stack in e for e in errors),
                            (stack, errors))
            self.assertEqual(pc.check(repo("clinic-api"), [ok]), [], stack)

    def test_react_and_next_terms_count_as_typescript_idioms(self):
        for std in ("Mark a file `use client` only when it needs browser APIs, as `README.md` shows.",
                    "Read data in a page under the App Router, as `README.md` shows."):
            p = self.write("next.md", stack_persona("nextjs-frontend", "Next.js TypeScript frontend", [std]))
            self.assertEqual(pc.check(repo("clinic-api"), [p]), [], std)

    def test_product_owner_without_regulations_is_flagged(self):
        with open(golden("clinic-api", "product-owner.md"), encoding="utf-8") as f:
            text = f.read()
        cut = re.sub(r"## Regulations and compliance\n.*?(?=\n## )", "", text, flags=re.S)
        self.assertNotEqual(cut, text)
        errors = pc.check(repo("clinic-api"), [self.write("product-owner.md", cut)])
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("product-owner is missing the regulations and compliance part", errors[0])

    def test_each_missing_product_owner_part_is_named(self):
        with open(golden("clinic-api", "product-owner.md"), encoding="utf-8") as f:
            text = f.read()
        parts = {"Users and buyers": "users and buyers", "Domain invariants": "domain invariants",
                 "Vocabulary": "vocabulary", "Failures users care about": "failures users care about",
                 "Acceptance checks": "acceptance checks"}
        for heading, label in parts.items():
            cut = re.sub(r"## %s\n.*?(?=\n## |\Z)" % heading, "", text, flags=re.S)
            errors = pc.check(repo("clinic-api"), [self.write("product-owner.md", cut)])
            self.assertTrue(any("missing the %s part" % label in e for e in errors), (heading, errors))

    def test_regulation_without_evidence_or_inference_is_flagged(self):
        with open(golden("clinic-api", "product-owner.md"), encoding="utf-8") as f:
            text = f.read()
        bad = text.replace("- HIPAA: the `README.md` says", "- HIPAA: everyone knows")
        errors = pc.check(repo("clinic-api"), [self.write("product-owner.md", bad)])
        self.assertTrue(any("regulation has no repo evidence and is not marked as an inference" in e
                            for e in errors), errors)

    def test_product_owner_with_a_write_tool_is_flagged(self):
        with open(golden("clinic-api", "product-owner.md"), encoding="utf-8") as f:
            text = f.read()
        bad = text.replace("tools: Read, Grep, Glob, Bash", "tools: Read, Write, Bash")
        errors = pc.check(repo("clinic-api"), [self.write("product-owner.md", bad)])
        self.assertTrue(any("read-only" in e for e in errors), errors)


class UnknownAndMixedStacks(TempFiles):
    def persona(self, name, description, stack, standards):
        body = "\n".join("%d. %s" % (i + 1, s) for i, s in enumerate(standards))
        return ("---\nname: %s\ndescription: %s\nmodel: sonnet\n---\n\n## Area\n\nx\n\n## Stack\n\n%s\n\n"
                "## Standards\n\n%s\n\n## Proving it works\n\nx\n" % (name, description, stack, body))

    def go(self, name="go-api", std="Handlers use net/http and queries come from sqlc, see `README.md`."):
        return self.write(name + ".md", self.persona(name, "Go API service", "Go with net/http and sqlc.", [std]))

    def test_go_persona_passes_without_a_stack_error(self):
        self.assertEqual(pc.check(repo("clinic-api"), [self.go()]), [])

    def test_postgres_migrations_persona_passes(self):
        p = self.write("pg.md", self.persona("postgres-migrations", "Writes PostgreSQL migrations",
                                             "PostgreSQL SQL migrations.",
                                             ["Every migration is reversible, as `README.md` describes."]))
        self.assertEqual(pc.check(repo("clinic-api"), [p]), [])

    def test_unknown_stack_still_checks_missing_paths(self):
        p = self.go(std="Handlers use net/http, as `cmd/missing.go` does.")
        errors = pc.check(repo("clinic-api"), [p])
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("cites a path that does not exist: cmd/missing.go", errors[0])

    def test_unknown_stack_still_checks_duplicates(self):
        std = "Wrap errors with context, see `README.md`."
        a = self.go("go-a", std)
        b = self.go("go-b", std)
        errors = pc.check(repo("clinic-api"), [a, b])
        self.assertTrue(any("go-b.md" in e and "duplicates a Standard of" in e for e in errors), errors)

    def test_stack_section_beats_a_frontend_mention_in_the_description(self):
        std = "Money is a `Decimal` field on a Pydantic `BaseModel`, as `app/models.py` does; never a float."
        p = self.write("ledger.md", self.persona(
            "fastapi-ledger-service", "Edits the FastAPI ledger backend that the React frontend calls.",
            "Python FastAPI with Pydantic.", [std]))
        self.assertEqual(pc.check(repo("ledger-service"), [p]), [])


class Cli(TempFiles):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(SCRIPTS, "kit_persona_check.py"), *args],
                              capture_output=True, text=True)

    def test_ok_exits_zero(self):
        r = self.run_cli("--repo", repo("shop-web"), golden("shop-web", "react-vite-storefront.md"),
                         golden("shop-web", "product-owner.md"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.startswith("OK:"), r.stdout)

    def test_errors_exit_one_with_one_line_each(self):
        p = self.write("spring.md", stack_persona("spring-boot-backend", "Spring Boot JVM backend",
                                                  ["Be nice.", "Also `README.md` matters."]))
        r = self.run_cli("--repo", repo("clinic-api"), p)
        self.assertEqual(r.returncode, 1)
        lines = r.stdout.strip().split("\n")
        self.assertTrue(len(lines) >= 2 and all(l.startswith("ERROR: ") for l in lines), lines)


if __name__ == "__main__":
    unittest.main()
