#!/usr/bin/env python3
"""kit_scan: list a repo's stack-areas and the evidence for its industry, as JSON, for /kit:init.

Python 3 standard library only. Usage: kit_scan.py --repo <path>

Output:
  {"stacks": [{"stack", "framework", "area", "manifest", "cite": [...]}],
   "evidence": {"readmes": [{"path", "title", "first_paragraph"}],
                "entities": [{"name", "kind", "file"}],
                "nouns": [{"noun", "count", "files": [...]}]}}

The script names no industry. It returns evidence only; /kit:init reads it, reads the files, and names
the industry and domain itself, or asks the person.

A stack-area is one manifest (pom.xml, build.gradle[.kts], package.json, pyproject.toml,
requirements.txt) and the directory it sits in. "cite" holds repo-relative files, with "/" separators,
that a persona for the area can point at.

Entities are names read from declarations: JPA-annotated classes, exported TypeScript interfaces, types
and classes in model-like files, Pydantic, SQLAlchemy and dataclass models, SQL tables and Prisma models.
Nouns are the most frequent words in identifiers (comments, strings and imports removed), minus language
keywords and a list of generic software words.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

SKIP_DIRS = {".git", ".claude", "node_modules", "venv", ".venv", "__pycache__", "build", "target", "dist",
             ".gradle", ".idea", ".next", "out"}
MANIFESTS = ("pom.xml", "build.gradle", "build.gradle.kts", "package.json", "pyproject.toml", "requirements.txt")
SOURCE_EXT = {".java", ".kt", ".ts", ".tsx", ".js", ".jsx", ".py"}
MAX_BYTES = 200_000
MAX_CITE = 12
MAX_NOUNS = 20
MAX_ENTITIES = 40
MIN_NOUN_LEN = 3
MAX_READMES = 5
PARAGRAPH_CHARS = 400

LANGUAGE_KEYWORDS = set("""
abstract and as assert async await boolean break byte case catch char class const continue def default del
do double elif else enum except export extends false final finally float for from function global goto if
implements import in instanceof int interface is lambda let long new nonlocal none not null of or package pass
private protected public raise record return self short static super switch synchronized this throw throws
transient true try type typeof var void volatile while with yield override object string number any unknown never
array bool dict list tuple set map optional promise readonly declare namespace module require undefined val fun
when open data init sealed inline lateinit
""".split())

# generic software words that say nothing about an industry
GENERIC_WORDS = set("""
id ids get put post delete update create find by all one new add remove run start stop main app apps args arg
name names value values result results response request req res error errors test tests spec status state
key item items index path file files json http https api str util utils helper helpers impl base config
client service services controller repository repositories component components props model models schema
schemas entity mapping variable autowired jakarta org com net springframework spring boot web rest bind
persistence annotation ok found not at to of the and for with use used using effect handler handlers
hook hooks click echo time now before after first last next count total size length max min text string
type types render page pages view views dto dtos map filter reduce each log logger print println console
query queries command commands option options flag flags env debug info warn
""".split())

STOP = LANGUAGE_KEYWORDS | GENERIC_WORDS

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
COMMENTS_AND_STRINGS = re.compile(
    r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|/\*[\s\S]*?\*/|//[^\n]*|#[^\n]*|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`')
IMPORT_LINE = re.compile(r"^\s*(?:import|package|from|using)\b[^\n]*", re.M)

JAVA_ENTITY = re.compile(
    r"@(?:Entity|Table|Document|MappedSuperclass)\b[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:\w+\s+)*?(?:class|record)\s+(\w+)")
TS_EXPORT = re.compile(r"^export\s+(?:declare\s+)?(?:abstract\s+)?(interface|type|class|enum)\s+(\w+)", re.M)
PY_MODEL = re.compile(
    r"^class\s+(\w+)\(([^)]*(?:BaseModel|Base|SQLModel|Model|TypedDict|Schema|DeclarativeBase)[^)]*)\)", re.M)
PY_DATACLASS = re.compile(r"^@(?:dataclasses\.)?dataclass[^\n]*\nclass\s+(\w+)", re.M)
SQL_TABLE = re.compile(r"create\s+table\s+(?:if\s+not\s+exists\s+)?[\"`]?(\w+)", re.I)
PRISMA_MODEL = re.compile(r"^model\s+(\w+)\s*\{", re.M)
MODEL_DIRS = {"types", "model", "models", "schema", "schemas", "domain", "entities", "entity", "dto"}
MODEL_FILES = {"types.ts", "models.ts", "schema.ts", "types.d.ts"}


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(MAX_BYTES)
    except OSError:
        return ""


def walk(repo):
    """Yield repo-relative paths with '/' separators, skipping vendored and build dirs."""
    for root, dirs, files in os.walk(repo):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            rel = os.path.relpath(os.path.join(root, name), repo)
            yield rel.replace(os.sep, "/")


def classify(manifest, text, has_tsconfig):
    low = text.lower()
    if manifest in ("pom.xml", "build.gradle", "build.gradle.kts"):
        fw = "spring-boot" if "spring-boot" in low or "springframework.boot" in low else "jvm"
        return "jvm", fw
    if manifest == "package.json":
        try:
            data = json.loads(text)
        except ValueError:
            data = {}
        keys = set()
        for field in ("dependencies", "devDependencies", "peerDependencies"):
            section = data.get(field) if isinstance(data, dict) else None
            if isinstance(section, dict):
                keys |= set(section)
        stack = "typescript" if has_tsconfig or "typescript" in keys else "javascript"
        if "react" in keys and "vite" in keys:
            fw = "react-vite"
        elif "next" in keys:
            fw = "nextjs"
        elif "react" in keys:
            fw = "react"
        else:
            fw = "node"
        return stack, fw
    fw = "python"
    for name in ("fastapi", "django", "flask"):
        if re.search(r"\b" + name + r"\b", low):
            fw = name
            break
    return "python", fw


LAYER_WORDS = ("controller", "repository", "service", "client", "component", "model", "types", "entity",
               "schema", "router", "main", "cli", "test")


def is_cite(rel_in_area):
    low = rel_in_area.lower()
    if os.path.splitext(low)[1] not in SOURCE_EXT:
        return False
    padded = "/" + low
    if "/test/" in padded or low.startswith("tests/"):
        return True
    return any(w in low for w in LAYER_WORDS) or "/components/" in padded or "/api/" in padded


def find_stacks(paths, repo):
    pathset = set(paths)
    seen = {}  # area -> (rank, manifest path); the first manifest in MANIFESTS order wins
    for rel in paths:
        name = rel.rsplit("/", 1)[-1]
        if name not in MANIFESTS:
            continue
        area = rel.rsplit("/", 1)[0] if "/" in rel else "."
        rank = MANIFESTS.index(name)
        if area not in seen or rank < seen[area][0]:
            seen[area] = (rank, rel)
    found = []
    for area in sorted(seen):
        manifest_rel = seen[area][1]
        name = manifest_rel.rsplit("/", 1)[-1]
        tsconfig = ("tsconfig.json" if area == "." else area + "/tsconfig.json") in pathset
        stack, fw = classify(name, read_text(os.path.join(repo, manifest_rel)), tsconfig)
        found.append({"stack": stack, "framework": fw, "area": area, "manifest": name, "_rel": manifest_rel})
    areas = [s["area"] for s in found]
    for s in found:
        prefix = "" if s["area"] == "." else s["area"] + "/"
        cite = [s["_rel"]]
        for rel in paths:
            if not rel.startswith(prefix) or rel == s["_rel"]:
                continue
            owner = max((a for a in areas if a != "." and rel.startswith(a + "/")), key=len, default=".")
            if owner == s["area"] and is_cite(rel[len(prefix):]) and len(cite) < MAX_CITE:
                cite.append(rel)
        s["cite"] = cite  # repo-relative
        del s["_rel"]
    return found


def readme_evidence(paths, repo):
    readmes = [p for p in paths if p.rsplit("/", 1)[-1].lower().startswith("readme")]
    readmes.sort(key=lambda p: (p.count("/"), p))
    out = []
    for rel in readmes[:MAX_READMES]:
        title, para, lines = "", [], read_text(os.path.join(repo, rel)).split("\n")
        i = 0
        while i < len(lines) and not title:
            if lines[i].startswith("# "):
                title = lines[i][2:].strip()
            i += 1
        # the first block of plain text after the title
        for line in lines[i:] if title else lines:
            s = line.strip()
            if not s:
                if para:
                    break
                continue
            if s.startswith("#") or s.startswith("```"):
                if para:
                    break
                continue
            para.append(s)
        out.append({"path": rel, "title": title, "first_paragraph": " ".join(para)[:PARAGRAPH_CHARS]})
    return out


def entities_in(rel, text):
    ext = os.path.splitext(rel)[1].lower()
    base = rel.rsplit("/", 1)[-1].lower()
    parts = set(rel.lower().split("/")[:-1])
    found = []
    if ext in (".java", ".kt"):
        found += [(m.group(1), "class") for m in JAVA_ENTITY.finditer(text)]
    elif ext in (".ts", ".tsx", ".js", ".jsx"):
        if parts & MODEL_DIRS or base in MODEL_FILES:
            found += [(m.group(2), m.group(1)) for m in TS_EXPORT.finditer(text)]
    elif ext == ".py":
        found += [(m.group(1), "model") for m in PY_MODEL.finditer(text)]
        found += [(m.group(1), "dataclass") for m in PY_DATACLASS.finditer(text)]
    elif ext == ".sql":
        found += [(m.group(1), "table") for m in SQL_TABLE.finditer(text)]
    elif ext == ".prisma":
        found += [(m.group(1), "model") for m in PRISMA_MODEL.finditer(text)]
    return [{"name": n, "kind": k, "file": rel} for n, k in found]


def words(identifier):
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", identifier)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return [w.lower() for w in re.split(r"[_\s]+", spaced) if w]


def code_evidence(paths, repo):
    entities, counts, per_file = [], Counter(), defaultdict(Counter)
    for rel in paths:
        ext = os.path.splitext(rel)[1].lower()
        if ext not in SOURCE_EXT and ext not in (".sql", ".prisma"):
            continue
        text = read_text(os.path.join(repo, rel))
        entities += entities_in(rel, text)
        if ext not in SOURCE_EXT:
            continue
        code = COMMENTS_AND_STRINGS.sub(" ", IMPORT_LINE.sub(" ", text))
        for ident in IDENT.findall(code):
            for w in words(ident):
                if len(w) >= MIN_NOUN_LEN and w not in STOP and w.isalpha():
                    counts[w] += 1
                    per_file[w][rel] += 1
    nouns = []
    for noun, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_NOUNS]:
        files = [f for f, _ in sorted(per_file[noun].items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
        nouns.append({"noun": noun, "count": count, "files": files})
    entities.sort(key=lambda e: (e["file"], e["name"]))
    return entities[:MAX_ENTITIES], nouns


def scan(repo):
    paths = list(walk(repo))
    entities, nouns = code_evidence(paths, repo)
    return {"stacks": find_stacks(paths, repo),
            "evidence": {"readmes": readme_evidence(paths, repo), "entities": entities, "nouns": nouns}}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", default=".", help="repo root to scan")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.repo):
        print("kit_scan: not a directory: %s" % args.repo, file=sys.stderr)
        return 2
    json.dump(scan(args.repo), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
