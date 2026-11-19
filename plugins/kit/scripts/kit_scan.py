#!/usr/bin/env python3
"""kit_scan: list a repo's stack-areas and industry signals, as JSON, for /kit:init.

Python 3 standard library only. Usage: kit_scan.py --repo <path>

Output:
  {"stacks": [{"stack", "framework", "area", "manifest", "cite": [...]}],
   "industry": {"name", "signals": [{"term", "file"}], "files_read": [...]}}

A stack-area is one manifest (pom.xml, build.gradle[.kts], package.json, pyproject.toml,
requirements.txt) and the directory it sits in. "cite" holds repo-relative files, with "/" separators,
that a persona for the area can point at. The industry name is "unknown" when no industry has enough
signals: /kit:init then asks the person. The scan finds evidence; the model still reads the files.
"""
import argparse
import json
import os
import re
import sys

SKIP_DIRS = {".git", ".claude", "node_modules", "venv", ".venv", "__pycache__", "build", "target", "dist",
             ".gradle", ".idea", ".next", "out"}
MANIFESTS = ("pom.xml", "build.gradle", "build.gradle.kts", "package.json", "pyproject.toml", "requirements.txt")
SOURCE_EXT = {".java", ".kt", ".ts", ".tsx", ".js", ".jsx", ".py"}
DOC_EXT = {".md", ".rst", ".txt"}
MAX_BYTES = 200_000
MAX_CITE = 12
MIN_SCORE = 3  # distinct industry terms needed before the scan names an industry

# distinctive terms per industry; matched as whole words, case-insensitive
INDUSTRIES = {
    "healthcare": ["patient", "patients", "appointment", "appointments", "clinician", "clinic", "diagnosis",
                   "hipaa", "phi", "prescription", "ehr", "fhir", "hl7", "medication"],
    "retail": ["order", "orders", "cart", "sku", "checkout", "shipment", "catalogue", "catalog", "inventory",
               "shopper", "storefront", "pci", "refund", "return"],
    "fintech": ["ledger", "journal", "debit", "credit", "kyc", "aml", "payments", "settlement", "balance",
                "transaction", "transactions", "reconciliation", "sox", "psd2"],
}


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


def classify(manifest, text):
    low = text.lower()
    if manifest in ("pom.xml", "build.gradle", "build.gradle.kts"):
        fw = "spring-boot" if "spring-boot" in low or "springframework.boot" in low else "jvm"
        return "jvm", fw
    if manifest == "package.json":
        deps = low
        if "react" in deps and "vite" in deps:
            fw = "react-vite"
        elif "next" in deps:
            fw = "nextjs"
        elif "react" in deps:
            fw = "react"
        else:
            fw = "node"
        return "typescript", fw
    fw = "python"
    for name in ("fastapi", "django", "flask"):
        if re.search(r"\b" + name + r"\b", low):
            fw = name
            break
    return "python", fw


LAYER_WORDS = ("controller", "repository", "service", "client", "component", "model", "types", "entity",
               "schema", "router", "main", "test")


def is_cite(rel_in_area):
    low = rel_in_area.lower()
    ext = os.path.splitext(low)[1]
    if ext not in SOURCE_EXT:
        return False
    if "/test/" in "/" + low or low.startswith("tests/"):
        return True
    return any(w in low for w in LAYER_WORDS) or "/components/" in "/" + low or "/api/" in "/" + low


def find_stacks(paths, repo):
    found = []
    seen = {}  # area -> (rank, manifest path); the first manifest in MANIFESTS order wins
    for rel in paths:
        name = rel.rsplit("/", 1)[-1]
        if name not in MANIFESTS:
            continue
        area = rel.rsplit("/", 1)[0] if "/" in rel else "."
        rank = MANIFESTS.index(name)
        if area not in seen or rank < seen[area][0]:
            seen[area] = (rank, rel)
    for area in sorted(seen):
        manifest_rel = seen[area][1]
        name = manifest_rel.rsplit("/", 1)[-1]
        stack, fw = classify(name, read_text(os.path.join(repo, manifest_rel)))
        found.append({"stack": stack, "framework": fw, "area": area, "manifest": name, "_rel": manifest_rel})
    areas = [s["area"] for s in found]
    for s in found:
        prefix = "" if s["area"] == "." else s["area"] + "/"
        cite = [s["_rel"]]
        for rel in paths:
            if not rel.startswith(prefix) or rel == s["_rel"]:
                continue
            inner = rel[len(prefix):]
            owner = max((a for a in areas if a != "." and rel.startswith(a + "/")), key=len, default=".")
            if owner != s["area"]:
                continue
            if is_cite(inner) and len(cite) < MAX_CITE:
                cite.append(rel)
        s["cite"] = cite  # repo-relative
        del s["_rel"]
    return found


def find_industry(paths, repo):
    files_read, hits = [], {}
    for rel in paths:
        ext = os.path.splitext(rel)[1].lower()
        base = rel.rsplit("/", 1)[-1].lower()
        in_docs = ext in DOC_EXT and (base.startswith("readme") or rel.lower().startswith("docs/") or "/docs/" in rel.lower())
        is_model = ext in SOURCE_EXT and any(w in rel.lower() for w in ("model", "entity", "types", "schema", "domain",
                                                                          "appointment", "order", "ledger", "journal"))
        if not (in_docs or is_model):
            continue
        text = read_text(os.path.join(repo, rel))
        files_read.append(rel)
        # file names count too: a model named Appointment.java is a signal
        blob = rel + "\n" + text
        words = set(re.findall(r"[a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", blob).lower()))
        for industry, terms in INDUSTRIES.items():
            for term in terms:
                if term in words:
                    hits.setdefault(industry, []).append({"term": term, "file": rel})
    scores = {i: len({h["term"] for h in hs}) for i, hs in hits.items()}
    best = max(scores, key=lambda i: (scores[i], i), default=None)
    if best is None or scores[best] < MIN_SCORE:
        return {"name": "unknown", "signals": [], "files_read": files_read}
    return {"name": best, "signals": hits[best], "files_read": files_read}


def scan(repo):
    paths = list(walk(repo))
    return {"stacks": find_stacks(paths, repo), "industry": find_industry(paths, repo)}


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
