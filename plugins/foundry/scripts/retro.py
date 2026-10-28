#!/usr/bin/env python3
"""foundry retro: count what a foundry session dir recorded. See foundry ADR-0003, section 3.

Usage: python retro.py <foundry dir>

Reads decisions.md, events*.jsonl, messages*.jsonl, reports/*/*-judge*.md and plan.json; writes
nothing; prints one JSON object on stdout and exits 0. A missing dir exits 2 with
"retro: NO_FOUNDRY_DIR: <path>" on stderr. Python 3.9+, standard library only.

Also reports "leftovers": for a dir shaped <git common dir>/foundry/<session>, the spawned agents whose
worktree-agent-<id> branch or .claude/worktrees/agent-<id> folder is still there, read from git (rev-parse
and for-each-ref only) and the disk.

The script counts and the skill judges. Where the log does not say, the output says "not recorded"
and never a zero. Message, prompt and report text is never printed (P8): a judge report is read
only as far as its first non-empty line.
"""
import datetime
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys

NR = "not recorded"
LINE_CAP = 1 << 20  # a line longer than 1 MiB is skipped, never held whole

CLOCK = r"\d{1,2}:\d{2}"
DATE = r"\d{4}-\d{2}-\d{2}"
DATETIME = DATE + r"[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})"
STRUCTURED = re.compile(r"^- (" + DATETIME + "|" + DATE + "|" + CLOCK + r"|HH:MM) \| (.*)$")
RECOMMEND = re.compile(r"^\s*cynic-\d+ RECOMMEND (answer|defer|pass)\b")
# A RECOMMEND in a decision line's cynic field: "RECOMMEND: answer (soft)", "cynic-3 RECOMMEND:
# answer", "cynic-4: RECOMMEND: defer (x2)". An "(xN)" right after the outcome is N of them.
CYNIC_FIELD = re.compile(
    r"^(?:cynic-\d+:?\s+)?RECOMMEND:?\s+(answer|defer|pass)\b(?:\s*\(x([1-9]\d{0,2})\))?"
)
HEADING = re.compile(r"^## Run[ \t]+(.*)$")
RFC3339 = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$"
)
JUDGE_NAME = re.compile(r"^(.+)-judge(-\d+)?$")
JUDGE_FILE = re.compile(r"^.+-judge(-\d+)?\.md$")


INT_CAP = 10 ** 18  # a count above this is not a plausible agent count; treated as invalid


def loads(text):
    """json.loads that never raises: deep nesting (RecursionError), huge ints or anything else
    unforeseen reads as 'not JSON' (None). Callers treat None as unusable input."""
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001 - one bad input must never crash the report
        return None


def good_int(v):
    """True for a real int (not a bool) of sane size."""
    return isinstance(v, int) and not isinstance(v, bool) and -INT_CAP <= v <= INT_CAP


def parse_rfc3339(text):
    """Return an aware datetime, or None when text is not an RFC 3339 date-time."""
    if not isinstance(text, str):
        return None
    m = RFC3339.match(text.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, frac, zone = m.groups()
    try:
        micro = int((frac or "0")[:6].ljust(6, "0"))
        if zone in ("Z", "z"):
            tz = datetime.timezone.utc
        else:
            sign = 1 if zone[0] == "+" else -1
            tz = datetime.timezone(sign * datetime.timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6])))
        return datetime.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), micro, tzinfo=tz)
    except (ValueError, OverflowError):
        return None


def read_lines(path):
    """Yield each line as text (BOM, CR and LF stripped, bad bytes replaced), or None for a line
    over LINE_CAP. Streams: never holds more than one capped line. An unreadable file yields nothing."""
    try:
        fh = open(path, "rb")
    except OSError:
        return
    with fh:
        first = True
        while True:
            try:
                raw = fh.readline(LINE_CAP + 1)
            except OSError:
                return
            if not raw:
                return
            if len(raw) > LINE_CAP and not raw.endswith(b"\n"):
                while True:  # drain the rest of the oversize line
                    rest = fh.readline(LINE_CAP)
                    if not rest or rest.endswith(b"\n"):
                        break
                first = False
                yield None
                continue
            text = raw.decode("utf-8", errors="replace")
            if first:
                text = text.lstrip("﻿")
                first = False
            yield text.replace("\r", "").rstrip("\n")


def list_files(directory, pattern):
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    return [os.path.join(directory, n) for n in sorted(names)
            if fnmatch.fnmatchcase(n, pattern) and os.path.isfile(os.path.join(directory, n))]


def drop_duplicate_files(paths):
    """Drop a file whose bytes equal an earlier file in the list.

    A half-failed roll in register.ts's appendLine copies events.jsonl to events.<n>.jsonl and then
    fails to rewrite events.jsonl, leaving two identical files; reading both counts every line twice.
    Only whole-file duplicates go; a rolled file that is a prefix of the live one still counts.
    Size is compared first and the hash is streamed, so a big log is never loaded whole.
    """
    kept, by_size, digests = [], {}, {}

    def digest(path):
        if path not in digests:
            digests[path] = file_digest(path)
        return digests[path]

    for path in paths:
        try:
            same_size = by_size.setdefault(os.path.getsize(path), [])
            if same_size and any(digest(k) == digest(path) for k in same_size):
                continue
        except OSError:
            kept.append(path)  # unreadable: let the normal reader deal with it
            continue
        same_size.append(path)
        kept.append(path)
    return kept


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def new_run(started, goal, start_dt):
    return {
        "started": started, "goal": goal, "_dt": start_dt,
        "decisions": {"total": 0, "clock": 0, "dateOnly": 0, "notRecorded": 0,
                      "followed": 0, "overruled": 0, "other": 0},
        "freeform": 0,
        "recommendations": {"total": 0, "answer": 0, "defer": 0, "pass": 0},
        "messages": 0,
        "_spawns": {"total": 0, "byModelEffort": {}},
        "_stalls": {"agent": 0, "idleLead": 0},
        "_esc": {"QUESTION": 0, "BLOCKED": 0, "PROPOSAL": 0},
        "_judges": {"pass": 0, "fail": 0},
        "_budget_crews": set(),
    }


def classify_time(token):
    if token == "HH:MM":
        return "notRecorded"
    if re.fullmatch(DATE, token):
        return "dateOnly"
    return "clock"


def read_decisions(path):
    """Return (heading runs, pre-heading run, whether the pre-heading run holds any '- ' line)."""
    pre = new_run(NR, NR, None)
    pre_used = False
    runs = []
    cur = pre
    for line in read_lines(path):
        if line is None:
            continue
        h = HEADING.match(line)
        if h:
            start, sep, goal = h.group(1).partition(" | ")
            start = start.strip()
            goal = goal.strip() if sep else ""
            dt = parse_rfc3339(start)
            cur = new_run(start if dt else NR, goal or NR, dt)
            runs.append(cur)
            continue
        if not line.startswith("- "):
            continue
        if cur is pre:
            pre_used = True
        m = STRUCTURED.match(line)
        if not m:
            cur["freeform"] += 1
            continue
        rest = m.group(2)
        rec = RECOMMEND.match(rest)
        if rec:
            cur["recommendations"]["total"] += 1
            cur["recommendations"][rec.group(1)] += 1
            continue
        d = cur["decisions"]
        d["total"] += 1
        d[classify_time(m.group(1))] += 1
        fields = rest.split("|")
        cyn = CYNIC_FIELD.match(fields[-2].strip()) if len(fields) >= 4 else None
        if cyn:
            n = int(cyn.group(2) or 1)
            cur["recommendations"]["total"] += n
            cur["recommendations"][cyn.group(1)] += n
        outcome = fields[-1].strip()
        if outcome in ("followed", "followed (deferred)"):
            d["followed"] += 1
        elif outcome.startswith("overruled"):
            d["overruled"] += 1
        else:
            d["other"] += 1
    return runs, pre, pre_used


def assign(runs, ts):
    """The run whose parsed start is the latest at or before ts; None when ts precedes them all."""
    best = None
    for r in runs:
        if r["_dt"] is not None and r["_dt"] <= ts and (best is None or r["_dt"] >= best["_dt"]):
            best = r
    return best


def valid_event(line):
    """Return (event dict, ts) for a usable v:1 line, else None. Caller counts the skip."""
    ev = loads(line)
    if not isinstance(ev, dict) or ev.get("v") != 1 or isinstance(ev.get("v"), bool):
        return None
    ts = parse_rfc3339(ev.get("ts"))
    if ts is None:
        return None
    return ev, ts


def process_events(files, runs):
    """Fill the runs' event counters. Return (skipped, outside). With no runs, every valid event is
    outside: a dir without headings cannot be split."""
    skipped = 0
    outside = 0
    for path in files:
        for line in read_lines(path):
            if line is None:
                skipped += 1
                continue
            if not line.strip():
                continue
            got = valid_event(line)
            if got is None:
                skipped += 1
                continue
            ev, ts = got
            run = assign(runs, ts)
            if run is None:
                outside += 1
                continue
            kind = ev.get("event")
            if kind == "spawn":
                def pick(k):  # a non-string model/effort counts as unset, like a missing one
                    v = ev.get(k)
                    return v if isinstance(v, str) and v else "unset"
                key = pick("model") + "/" + pick("effort")
                s = run["_spawns"]
                s["total"] += 1
                s["byModelEffort"][key] = s["byModelEffort"].get(key, 0) + 1
            elif kind == "stall":
                if ev.get("kind") == "agent":
                    run["_stalls"]["agent"] += 1
                elif ev.get("kind") == "idle-lead":
                    run["_stalls"]["idleLead"] += 1
            elif kind == "tag":
                tag = ev.get("tag")
                if isinstance(tag, str) and tag in run["_esc"]:
                    run["_esc"][tag] += 1
            elif kind == "budget-spent":
                crew = ev.get("crew")
                if isinstance(crew, str) and crew:
                    run["_budget_crews"].add(crew)
            elif kind == "report":
                agent = ev.get("agent")
                m = JUDGE_NAME.match(agent) if isinstance(agent, str) else None
                if m and m.group(1) == ev.get("crew"):
                    if ev.get("marker") == "VERDICT: PASS":
                        run["_judges"]["pass"] += 1
                    elif ev.get("marker") == "VERDICT: FAIL":
                        run["_judges"]["fail"] += 1
    return skipped, outside


def process_messages(files, runs, pre):
    """Count messages per run. Returns True when any landed in the pre-heading run."""
    used = False
    for path in files:
        for line in read_lines(path):
            if not line or not line.strip():
                continue
            msg = loads(line)
            if not isinstance(msg, dict):
                continue
            run = None
            if runs:
                ts = parse_rfc3339(msg.get("ts"))
                run = assign(runs, ts) if ts is not None else None
            if run is None:
                run = pre
                used = True
            run["messages"] += 1
    return used


def judge_files(directory):
    out = {"files": 0, "pass": 0, "fail": 0, "other": 0}
    root = os.path.join(directory, "reports")
    try:
        crews = sorted(os.listdir(root))
    except OSError:
        return out
    for crew in crews:
        sub = os.path.join(root, crew)
        if not os.path.isdir(sub):
            continue
        try:
            names = sorted(os.listdir(sub))
        except OSError:
            continue
        for n in names:
            p = os.path.join(sub, n)
            if not JUDGE_FILE.match(n) or not os.path.isfile(p):
                continue
            first = ""
            for line in read_lines(p):
                if line is None:
                    break
                if line.strip():
                    first = line.strip()
                    break
            out["files"] += 1
            if first.startswith("VERDICT: PASS"):
                out["pass"] += 1
            elif first.startswith("VERDICT: FAIL"):
                out["fail"] += 1
            else:
                out["other"] += 1
    return out


def read_plan(directory):
    try:
        with open(os.path.join(directory, "plan.json"), "rb") as fh:
            text = fh.read().decode("utf-8", errors="replace").lstrip("﻿")
    except OSError:
        return NR
    plan = loads(text)
    if not isinstance(plan, dict):
        return NR
    crews = plan.get("crews")
    crews = [c for c in crews if isinstance(c, dict)] if isinstance(crews, list) else []
    waves = set()
    est = 0
    status = {}
    for c in crews:
        w = c.get("wave")
        if isinstance(w, (int, float, str)) and not isinstance(w, bool):
            waves.add(w)
        e = c.get("estAgents")
        if good_int(e):  # NaN, Infinity, floats, bools and absurd ints are skipped
            est += e
        st = c.get("status")
        key = st if isinstance(st, str) and st else "unset"
        status[key] = status.get(key, 0) + 1
    return {"crews": len(crews), "waves": len(waves), "estAgents": est,
            "agentCap": plan.get("agentCap") if good_int(plan.get("agentCap")) else None, "status": status}


GIT_TIMEOUT = 30
AGENT_ID = re.compile(r"^[0-9a-z]+$")


def git_out(cwd, *args):
    """Run a read-only git command; return stdout, or None on any failure."""
    env = dict(os.environ)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True,
                           encoding="utf-8", timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return r.stdout if r.returncode == 0 else None


def same_path(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def spawned_ids(files):
    ids = set()
    for path in files:
        for line in read_lines(path):
            if line is None or not line.strip():
                continue
            got = valid_event(line)
            if got is None or got[0].get("event") != "spawn":
                continue
            i = got[0].get("agentId")
            if isinstance(i, str) and AGENT_ID.match(i):
                ids.add(i)
    return ids


def leftovers(directory, event_files):
    """Branches and folders still left by this dir's spawned agents, or NR when it cannot be told."""
    if not event_files:
        return NR
    common = os.path.dirname(os.path.dirname(directory))
    if os.path.basename(os.path.dirname(directory)) != "foundry" or os.path.basename(common) != ".git":
        return NR
    top = git_out(common, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if top is None or not same_path(top.strip(), common):
        return NR
    main = os.path.dirname(common)
    refs = git_out(main, "for-each-ref", "--format=%(refname)", "refs/heads/")
    if refs is None:
        return NR
    have = set(refs.splitlines())
    branches, folders, agents = [], [], set()
    for i in sorted(spawned_ids(event_files)):
        name = "worktree-agent-" + i
        if "refs/heads/" + name in have:
            branches.append(name)
            agents.add(i)
        if os.path.isdir(os.path.join(main, ".claude", "worktrees", "agent-" + i)):
            folders.append(".claude/worktrees/agent-" + i)
            agents.add(i)
    return {"branches": sorted(branches), "folders": sorted(folders), "count": len(agents)}


def retro(directory):
    runs, pre, pre_used = read_decisions(os.path.join(directory, "decisions.md"))
    has_headings = bool(runs)
    event_files = drop_duplicate_files(list_files(directory, "events*.jsonl"))
    message_files = drop_duplicate_files(list_files(directory, "messages*.jsonl"))

    pre_msgs = process_messages(message_files, runs, pre)
    skipped, outside = process_events(event_files, runs)

    ordered = ([pre] if pre_used or pre_msgs else []) + runs if has_headings else [pre]
    out_runs = []
    for r in ordered:
        placed = bool(event_files) and r["_dt"] is not None
        out_runs.append({
            "started": r["started"], "goal": r["goal"],
            "decisions": r["decisions"], "freeform": r["freeform"],
            "recommendations": r["recommendations"], "messages": r["messages"],
            "spawns": r["_spawns"] if placed else NR,
            "stalls": r["_stalls"] if placed else NR,
            "escalations": r["_esc"] if placed else NR,
            "judges": r["_judges"] if placed else NR,
            "budgetsSpent": len(r["_budget_crews"]) if placed and r["_budget_crews"] else NR,
        })
    return {
        "retro": 1,
        "dir": directory,
        "split": "headings" if has_headings else NR,
        "runs": out_runs,
        "judgeFiles": judge_files(directory),
        "plan": read_plan(directory),
        "eventsSkipped": skipped,
        "eventsOutsideRuns": outside,
        "leftovers": leftovers(directory, event_files),
    }


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("retro: usage: retro.py <foundry dir>\n")
        return 2
    directory = os.path.abspath(argv[1])
    if not os.path.isdir(directory):
        sys.stderr.write("retro: NO_FOUNDRY_DIR: %s\n" % directory)
        return 2
    sys.stdout.write(json.dumps(retro(directory), indent=2, ensure_ascii=True, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
