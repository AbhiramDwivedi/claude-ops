"""Mine this project's Claude Code transcripts into a compact JSON summary for /kit:revise.

The model never reads raw transcripts; it reads what this prints. Parsing is wa_parse.py, copied byte for byte
from plugins/workflow-audit (tests/test_mine.py checks the copies match while both live in one repo).

Output (one JSON object on stdout):
  window        days, project dirs read, main sessions, subagent runs
  commands      shell command sequences the agent ran in 2+ sessions (candidates for a skill or command)
  prompts       near-identical prompts the person typed 3+ times, and slash commands they ran
  briefs        clusters of similar subagent briefs, 2+ runs each (candidates for an agent type)
  findings      lines that recur across 2+ reviewer reports (candidates for a checklist item or lint rule)
  kit           each agent, skill and command in the project's .claude/ and in kit itself, with its use count
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wa_common import redact  # noqa: E402
from wa_parse import parse_file  # noqa: E402

KIT_AGENTS = ("builder", "reviewer", "test-writer", "scout")
KIT_SKILLS = ("init", "revise")
SEGMENT_SPLIT = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")
WORD = re.compile(r"[a-z][a-z0-9_-]{2,}")
STOP = set("the and for with this that from into then when what your you are not but all any can its use "
           "using also only each them they there here will should must don't does have has been".split())
SAMPLE = 200
# reading, filtering and shell syntax: these say nothing about a project's workflow
NOISE = set("cd echo cat ls head tail grep rg sed awk find wc sleep sort uniq tr cut xargs printf true false "
            "for do done while if then else fi test export set pwd which type".split())


def slugify(path):
    """Claude Code's project folder name: every character outside [A-Za-z0-9] becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def project_dirs(projects_dir, cwd):
    """The project's own folder plus the folders of its worktrees under .claude/worktrees."""
    # run from inside one of its worktrees: read the main checkout's transcripts too
    root = re.split(r"[\\/]\.claude[\\/]worktrees[\\/]", os.path.abspath(cwd))[0]
    slug = slugify(root.rstrip("\\/"))
    out = []
    for d in sorted(os.listdir(projects_dir)) if os.path.isdir(projects_dir) else []:
        if d == slug or d.startswith(slug + "--claude-worktrees-"):
            out.append(os.path.join(projects_dir, d))
    return out


def norm_segment(seg):
    """'npm run test -- --watch' -> 'npm run test'; 'git commit -m "x"' -> 'git commit'.
    Keeps up to three leading words, stopping at a flag, path, quote, number or assignment."""
    words = []
    for tok in seg.strip().split():
        if words and (tok[0] in "-'\"$<>(" or "/" in tok or "\\" in tok or "=" in tok or "." in tok
                      or tok.isdigit() or ":" in tok):
            break
        words.append(tok)
        if len(words) == 3:
            break
    return " ".join(words)


def command_heads(cmd):
    heads = []
    for seg in SEGMENT_SPLIT.split(cmd or ""):
        h = norm_segment(seg)
        if h and h.split()[0] not in NOISE:
            heads.append(h)
    return heads


def words(text):
    return {w for w in WORD.findall(text.lower()) if w not in STOP}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def cluster(items, key, threshold):
    """Greedy single-pass clustering on word-set Jaccard. items: dicts; key(item) -> word set."""
    groups = []
    for it in items:
        ws = key(it)
        for g in groups:
            if jaccard(ws, g["words"]) >= threshold:
                g["items"].append(it)
                g["words"] |= ws if len(g["items"]) < 3 else set()
                break
        else:
            groups.append({"words": set(ws), "items": [it]})
    return groups


def sub_texts(path):
    """(first user text = the brief, last assistant text = the report) of a subagent transcript."""
    brief, report = "", ""
    with open(path, encoding="utf8", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            c = (d.get("message") or {}).get("content")
            if d.get("type") == "user" and not brief:
                if isinstance(c, str):
                    brief = c
                elif isinstance(c, list):
                    brief = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            elif d.get("type") == "assistant" and isinstance(c, list):
                t = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text").strip()
                if t:
                    report = t
    return brief.strip(), report


def finding_lines(report):
    """Bullet or numbered lines of a review report, which is where findings live."""
    out = []
    for line in report.splitlines():
        m = re.match(r"\s*(?:[-*]|\d+[.)])\s+(.{15,})", line)
        if m:
            out.append(m.group(1).strip())
    return out


def short(text, n=SAMPLE):
    text = redact(" ".join(text.split()))
    return text if len(text) <= n else text[:n - 1] + "…"


def agent_name(t):
    return (t or "").split(":")[-1]


def inventory(claude_dir):
    items = []
    for f in sorted(glob.glob(os.path.join(claude_dir, "agents", "*.md"))):
        items.append({"kind": "agent", "name": os.path.basename(f)[:-3], "path": f})
    for f in sorted(glob.glob(os.path.join(claude_dir, "skills", "*", "SKILL.md"))):
        items.append({"kind": "skill", "name": os.path.basename(os.path.dirname(f)), "path": f})
    for f in sorted(glob.glob(os.path.join(claude_dir, "commands", "*.md"))):
        items.append({"kind": "command", "name": os.path.basename(f)[:-3], "path": f})
    items += [{"kind": "agent", "name": n, "path": "kit plugin"} for n in KIT_AGENTS]
    items += [{"kind": "skill", "name": n, "path": "kit plugin"} for n in KIT_SKILLS]
    return items


def mine(cwd, projects_dir, days, now=None, claude_dir=None):
    now = now or time.time()
    cutoff = now - days * 86400
    dirs = project_dirs(projects_dir, cwd)
    mains, subs = [], []
    for d in dirs:
        for f in glob.glob(os.path.join(d, "*.jsonl")):
            if os.path.getmtime(f) >= cutoff:
                mains.append(f)
        for f in glob.glob(os.path.join(d, "*", "subagents", "*.jsonl")):
            if os.path.getmtime(f) >= cutoff:
                subs.append(f)

    seq_sessions = defaultdict(set)
    seq_count = Counter()
    prompts = []
    slash = Counter()
    used_agents, used_skills = Counter(), Counter()
    for f in sorted(mains):
        sid = os.path.basename(f)[:-6]
        p = parse_file(f, "main", sid)
        heads = []
        for t in p["tools"]:
            if t.get("cmd"):
                heads += command_heads(t["cmd"])
            if t.get("skill"):
                used_skills[agent_name(t["skill"])] += 1
        for c in p["agent_calls"]:
            used_agents[agent_name(c.get("type") or "general-purpose")] += 1
        for n in (2, 3, 4):
            for i in range(len(heads) - n + 1):
                gram = tuple(heads[i:i + n])
                if len(set(gram)) > 1:
                    seq_count[gram] += 1
                    seq_sessions[gram].add(sid)
        for h in p["humans"]:
            if h["kind"] == "command" and h.get("cmd"):
                slash[h["cmd"]] += 1
                used_skills[agent_name(h["cmd"].lstrip("/"))] += 1
            elif h["kind"] in ("typed", "queued") and len(h["text"]) >= 20:
                prompts.append({"session": sid, "text": h["text"]})

    commands = []
    for gram, sess in seq_sessions.items():
        if len(sess) >= 2:
            commands.append({"sequence": list(gram), "runs": seq_count[gram], "sessions": len(sess)})
    commands.sort(key=lambda c: (-c["sessions"], -len(c["sequence"]), -c["runs"]))
    # drop a sequence that is part of a longer one seen in as many sessions
    kept = []
    for c in commands:
        s = " > ".join(c["sequence"])
        if not any(s in " > ".join(k["sequence"]) and k["sessions"] >= c["sessions"] for k in kept):
            kept.append(c)
    commands = kept[:15]

    pgroups = cluster(prompts, lambda it: words(it["text"][:300]), 0.6)
    repeated_prompts = [{"count": len(g["items"]), "sessions": len({i["session"] for i in g["items"]}),
                         "sample": short(g["items"][0]["text"])}
                        for g in pgroups if len(g["items"]) >= 3]
    repeated_prompts.sort(key=lambda x: -x["count"])

    runs, reviews = [], []
    for f in sorted(subs):
        meta = {}
        try:
            with open(f[:-len(".jsonl")] + ".meta.json", encoding="utf8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            pass
        brief, report = sub_texts(f)
        atype = meta.get("agentType") or "unknown"
        session = os.path.basename(os.path.dirname(os.path.dirname(f)))
        runs.append({"type": atype, "model": meta.get("model"), "desc": meta.get("description") or "",
                     "brief": brief, "session": session})
        if agent_name(atype) == "reviewer" or "review" in (meta.get("description") or "").lower():
            reviews.append({"session": session, "lines": finding_lines(report)})

    bgroups = cluster(runs, lambda r: words(r["desc"] + " " + r["brief"][:600]), 0.35)
    briefs = []
    for g in bgroups:
        if len(g["items"]) < 2:
            continue
        its = g["items"]
        briefs.append({"runs": len(its), "sessions": len({i["session"] for i in its}),
                       "types": dict(Counter(i["type"] for i in its)),
                       "models": dict(Counter(str(i["model"]) for i in its)),
                       "descriptions": sorted({i["desc"] for i in its if i["desc"]})[:4],
                       "brief_sample": short(its[0]["brief"], 400)})
    briefs.sort(key=lambda b: -b["runs"])

    lines = [{"review": i, "text": ln} for i, r in enumerate(reviews) for ln in r["lines"]]
    fgroups = cluster(lines, lambda it: words(it["text"]), 0.5)
    findings = [{"reviews": len({i["review"] for i in g["items"]}), "sample": short(g["items"][0]["text"], 160)}
                for g in fgroups if len({i["review"] for i in g["items"]}) >= 2]
    findings.sort(key=lambda x: -x["reviews"])

    kit = []
    for it in inventory(claude_dir or os.path.join(cwd, ".claude")):
        # skills and commands share one count: typed as /name or called through the Skill tool
        uses = (used_agents if it["kind"] == "agent" else used_skills).get(it["name"], 0)
        kit.append(dict(it, uses=uses))

    return {
        "window": {"days": days, "project_dirs": [os.path.basename(d) for d in dirs],
                   "sessions": len(mains), "subagent_runs": len(subs), "reviews": len(reviews)},
        "commands": commands,
        "prompts": {"repeated": repeated_prompts[:10], "slash_commands": dict(slash.most_common(15))},
        "briefs": briefs[:10],
        "findings": findings[:15],
        "kit": kit,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cwd", default=os.getcwd(), help="project root (default: current directory)")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--projects-dir", default=os.path.join(os.path.expanduser("~"), ".claude", "projects"))
    a = ap.parse_args(argv)
    json.dump(mine(a.cwd, a.projects_dir, a.days), sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
