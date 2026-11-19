#!/usr/bin/env python3
"""kit_persona_check: check persona drafts against a repo, deterministically, for /kit:init and /kit:persona.

Python 3 standard library only.
Usage: kit_persona_check.py --repo <repo root> <persona.md> [<persona.md> ...]

Prints "OK: <n> personas checked" and exits 0, or one "ERROR: <file>: <reason>" line per problem and exits 1.

For each editing persona (every persona except `product-owner`, and except a read-only judge with no
Standards section):
- every numbered Standard cites at least one path that exists in the repo (a Standard marked "ecosystem
  idiom" may cite none), and none cites a path that does not exist;
- no Standard's text, normalised and without its code spans, appears in a Standard of another persona;
- every Standard names something specific to the persona's stack, from the idiom table below.
For a `product-owner`:
- a read-only `tools` line, and the six parts as headings: users and buyers, regulations and compliance,
  domain invariants, vocabulary, failures users care about, acceptance checks;
- each regulation item cites a path that exists, or says it is an inference.

The checker finds what a script can find. It does not judge whether a Standard is right.
"""
import argparse
import glob
import os
import re
import sys

# Idioms per stack: a Standard must name at least one. Matched case-insensitively, as whole tokens.
IDIOMS = {
    "jvm": ["@Autowired", "@Entity", "@RestController", "@Transactional", "@Repository", "@Service", "controller",
            "controllers", "repository", "JpaRepository", "ResponseEntity", "Optional", "DTO", "DTOs", "BOM",
            "dependency-management", "Gradle", "Maven", "SNAPSHOT", "JPA", "Spring", "Spring Boot", "bean",
            "EntityManager", "Flyway", "Liquibase", "build.gradle.kts", "build.gradle", "pom.xml",
            "implementation", "jakarta", "Mono", "Flux", "R2DBC", "Kotlin", "Java"],
    "typescript": ["`any`", "`as`", "strict", "tsconfig.json", "interface", "interfaces", "useEffect", "useState",
                   "hook", "hooks", "props", "component", "components", "fetch", "Vite", "React", "Vitest", "caret",
                   "lockfile", "package.json", "TypeScript", "zod", "pnpm", "npm", "yarn", "JSX", "TSX",
                   "ts-ignore", "enum"],
    "python": ["Pydantic", "BaseModel", "async def", "async", "await", "FastAPI", "HTTPException", "Decimal",
               "float", "pytest", "TestClient", "uv", "pyproject.toml", "poetry", "lockfile", "SQLAlchemy",
               "Depends", "dataclass", "type hints", "dict", "uvicorn", "Django", "Flask", "asyncio"],
}
IDIOMS["javascript"] = [t for t in IDIOMS["typescript"] if t not in ("`any`", "`as`", "TypeScript", "tsconfig.json")]

# words in a persona's name, description or Stack section that say which stack it is for
STACK_WORDS = {
    "jvm": ["spring", "jvm", "java", "kotlin", "gradle", "maven", "jpa"],
    "typescript": ["typescript", "react", "vite", "nextjs", "next.js", "tsx", "frontend"],
    "python": ["python", "fastapi", "django", "flask", "pydantic", "pytest"],
    "javascript": ["javascript", "node", "express"],
}

PATH_EXT = (".java", ".kt", ".kts", ".gradle", ".xml", ".ts", ".tsx", ".js", ".jsx", ".py", ".md", ".json", ".toml",
            ".yml", ".yaml", ".sql", ".sh", ".ps1", ".cfg", ".ini", ".txt", ".properties", ".css", ".html")
PATH_TOKEN = re.compile(r"^[\w@./*-]+$")
PO_PARTS = [
    ("users and buyers", r"users and buyers"),
    ("regulations and compliance", r"regulations and compliance"),
    ("domain invariants", r"domain invariants"),
    ("vocabulary", r"vocabulary"),
    ("failures users care about", r"failures users"),
    ("acceptance checks", r"acceptance checks"),
]
WRITE_TOOLS = ("write", "edit", "notebookedit", "multiedit", "*")


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def frontmatter(text):
    lines = text.split("\n")
    fm = {}
    if lines and lines[0] == "---" and "---" in lines[1:]:
        for line in lines[1:lines.index("---", 1)]:
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
    return fm


def normalise(text):
    return " ".join(re.sub(r"[^a-z0-9@. ]+", " ", text.lower()).split())


def strip_code(text):
    return re.sub(r"`[^`]*`", " ", text)


def cited_paths(text):
    out = []
    for span in re.findall(r"`([^`]+)`", text):
        if PATH_TOKEN.match(span) and ("/" in span or span.lower().endswith(PATH_EXT)):
            out.append(span)
    return out


def path_exists(repo, token):
    full = os.path.normpath(os.path.join(repo, token))
    root = os.path.normpath(repo)
    if not (full == root or full.startswith(root + os.sep)):
        return False
    if "*" in token:
        return bool(glob.glob(full))
    return os.path.exists(full)


def section(lines, head, stop):
    """Lines after the first line matching head, up to the next line matching stop; None if no head."""
    for i, line in enumerate(lines):
        if re.match(head, line, re.I):
            j = i + 1
            while j < len(lines) and not re.match(stop, lines[j]):
                j += 1
            return lines[i + 1:j]
    return None


STOP_HEADING = r"^(?:#+\s|\*\*[^*]+\*\*\s*$)"


def standards_from(text):
    body = section(text.split("\n"), r"^(?:#+\s*|\*\*)Standards\b", STOP_HEADING)
    if body is None:
        return None
    items = []
    for line in body:
        m = re.match(r"^\s*(\d+)[.)]\s+(.*)", line)
        if m:
            items.append([int(m.group(1)), m.group(2).strip()])
        elif line.strip() and items:
            items[-1][1] += " " + line.strip()
    return [(n, t) for n, t in items]


def parse_standards(path):
    return standards_from(read(path)) or []


def stack_of(text):
    fm = frontmatter(text)
    head = (fm.get("name", "") + " " + fm.get("description", "")).lower()
    stack_body = section(text.split("\n"), r"^(?:#+\s*|\*\*)Stack\b", STOP_HEADING) or []
    for source in (head, " ".join(stack_body).lower()):
        scores = {s: sum(1 for w in ws if re.search(r"(?<![a-z0-9])" + re.escape(w), source))
                  for s, ws in STACK_WORDS.items()}
        best = max(scores.values())
        if best:
            return [s for s in STACK_WORDS if scores[s] == best][0]
    return None


def persona_stack(path):
    return stack_of(read(path))


def has_idiom(stack, text):
    for term in IDIOMS[stack]:
        if re.search(r"(?<![A-Za-z0-9_@])" + re.escape(term) + r"(?![A-Za-z0-9_])", text, re.I):
            return True
    return False


def check_product_owner(repo, label, text):
    errors = []
    fm = frontmatter(text)
    tools = [t.strip().lower() for t in fm.get("tools", "").split(",") if t.strip()]
    bad = [t for t in tools if t in WRITE_TOOLS]
    if not tools or bad:
        errors.append("ERROR: %s: product-owner is not read-only: its tools line must list read tools only (%s)"
                      % (label, ", ".join(bad) if bad else "no tools line"))
    lines = text.split("\n")
    sections = {}
    for name, pat in PO_PARTS:
        body = section(lines, r"^\s*(?:#+\s*|\*\*)\s*" + pat, STOP_HEADING)
        if body is None:
            errors.append("ERROR: %s: product-owner is missing the %s part" % (label, name))
        else:
            sections[name] = body
            if not any(l.strip() for l in body):
                errors.append("ERROR: %s: product-owner's %s part is empty" % (label, name))
    reg = sections.get("regulations and compliance")
    if reg is not None and any(l.strip() for l in reg):
        items = [l.strip() for l in reg if re.match(r"^\s*(?:[-*]|\d+[.)])\s+", l)]
        if not items:
            errors.append("ERROR: %s: the regulations and compliance part has no items" % label)
        for item in items:
            missing = [c for c in cited_paths(item) if not path_exists(repo, c)]
            ok = any(path_exists(repo, c) for c in cited_paths(item))
            for c in missing:
                errors.append("ERROR: %s: a regulation cites a path that does not exist: %s" % (label, c))
            if not ok and "inference" not in item.lower() and not missing:
                errors.append("ERROR: %s: a regulation has no repo evidence and is not marked as an inference: %s"
                              % (label, item[:70]))
    return errors


def check(repo, files):
    errors, seen = [], {}  # normalised Standard -> file of its first persona
    for path in files:
        label = path
        try:
            text = read(path)
        except OSError as e:
            errors.append("ERROR: %s: cannot read: %s" % (label, e.strerror or e))
            continue
        fm = frontmatter(text)
        name = fm.get("name") or os.path.splitext(os.path.basename(path))[0]
        if name == "product-owner":
            errors += check_product_owner(repo, label, text)
            continue
        standards = standards_from(text)
        if standards is None:
            tools = [t.strip().lower() for t in fm.get("tools", "").split(",") if t.strip()]
            if tools and not [t for t in tools if t in WRITE_TOOLS]:
                continue  # a read-only judge without Standards
            errors.append("ERROR: %s: no Standards section" % label)
            continue
        if not standards:
            errors.append("ERROR: %s: the Standards section has no numbered items" % label)
        stack = stack_of(text)
        if stack is None:
            errors.append("ERROR: %s: cannot tell the stack from the persona's name, description or Stack section"
                          % label)
        for n, std in standards:
            cites = cited_paths(std)
            missing = [c for c in cites if not path_exists(repo, c)]
            for c in missing:
                errors.append("ERROR: %s: Standard %d cites a path that does not exist: %s" % (label, n, c))
            if not missing and not cites and "ecosystem idiom" not in std.lower():
                errors.append("ERROR: %s: Standard %d cites no path that exists in the repo" % (label, n))
            if stack and not has_idiom(stack, std):
                errors.append("ERROR: %s: Standard %d names nothing specific to the %s stack" % (label, n, stack))
            key = normalise(strip_code(std))
            if key in seen and seen[key] != path:
                errors.append("ERROR: %s: Standard %d duplicates a Standard of %s (a generic Standard)"
                              % (label, n, seen[key]))
            seen.setdefault(key, path)
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True, help="repo root the personas describe")
    ap.add_argument("personas", nargs="+", help="persona .md files")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.repo):
        print("ERROR: %s: not a directory" % args.repo)
        return 1
    errors = check(args.repo, args.personas)
    if errors:
        print("\n".join(errors))
        return 1
    print("OK: %d personas checked" % len(args.personas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
