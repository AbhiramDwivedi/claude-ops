"""Discovery, exclusion, linking of subagents to parents, pricing and cache-break annotation.

build_context() returns a Ctx. Metric modules read it; they never touch files.
"""
import os
import statistics
import time

import wa_parse
from wa_common import day, path_parts, project_name, resolve_cwd, slug_name

# Cache-break rule (validated on real data, see CONTRACT.md).
BREAK_PREV_READ_MIN = 20000   # previous request had a warm cache of at least this many tokens
BREAK_REWRITE_MIN = 20000     # rewritten tokens above the thread's normal per-request write
IDLE_UNDER_TTL_MIN = 5        # a gap longer than this, but under the TTL, is "idle_under_ttl"
SELF_COMMAND = "workflow-audit"


class Ctx:
    def __init__(self):
        self.sessions = []      # main sessions (dicts from wa_parse, plus derived fields)
        self.subs = []          # subagent threads, linked to their parent
        self.excluded = []      # [{session, reason}]
        self.prices = None
        self.now = None
        self.days = None
        self.projects_dir = None
        self.cache_stats = {"hits": 0, "parsed": 0}
        self.billing = {}
        self.insights = {}
        self.n_files = 0
        self.home = None
        self.out_dir = None     # set by audit.run; metrics that write files (samples) use it

    def threads(self):
        return list(self.sessions) + list(self.subs)

    def requests(self):
        for t in self.threads():
            for r in t["requests"]:
                yield t, r


def discover(projects_dir, days, now):
    """[(path, kind, project_dir, session, agent_id)] for files modified within the window."""
    cutoff = now - days * 86400
    out = []
    try:
        projects = sorted(os.listdir(projects_dir))
    except OSError:
        return out
    for proj in projects:
        pdir = os.path.join(projects_dir, proj)
        if not os.path.isdir(pdir):
            continue
        for name in sorted(os.listdir(pdir)):
            full = os.path.join(pdir, name)
            if name.endswith(".jsonl") and os.path.isfile(full):
                out.append((full, "main", proj, name[:-6], None))
            elif os.path.isdir(full):
                sdir = os.path.join(full, "subagents")
                if not os.path.isdir(sdir):
                    continue
                for sn in sorted(os.listdir(sdir)):
                    if sn.startswith("agent-") and sn.endswith(".jsonl"):
                        out.append((os.path.join(sdir, sn), "sub", proj, name, sn[:-6]))
    keep = []
    for item in out:
        try:
            if os.stat(item[0]).st_mtime >= cutoff:
                keep.append(item)
        except OSError:
            pass
    return keep


def _first_human_is_self(s):
    h = s["humans"][0] if s["humans"] else None
    return bool(h and h["kind"] == "command" and SELF_COMMAND in (h.get("cmd") or ""))


def _is_excluded(s, exclude_ids):
    sid = s["session"]
    for e in exclude_ids:
        if sid == e or (len(e) >= 8 and sid.startswith(e)):
            return "--exclude-session"
    return "own /workflow-audit session" if _first_human_is_self(s) else None


def _decorate_session(s, project_dir):
    s["id"] = s["session"]
    s["id8"] = s["session"][:8]
    s["project"] = project_name(s["cwd"], project_dir)
    s["date"] = day(s["first_ts"])
    s["unattended"] = (not s["humans"]) or s["entrypoint"] == "sdk-cli"
    s["interactive"] = not s["unattended"]
    s["subs"] = []


def assign_project_names(sessions):
    """Readable project names: the owning project of cwd (worktrees and scratchpads mapped back); two different
    owners sharing a name become 'name (parent)'."""
    res = {}
    for s in sessions:
        res[s["id"]] = resolve_cwd(s["cwd"])
    known = {r[0] for r in res.values() if r[0] and r[2] is None}
    by_name = {}
    for s in sessions:
        name, owner, slug = res[s["id"]]
        if slug:
            name = slug_name(slug, known)
        elif not name:
            continue
        s["project"] = name
        if owner:
            by_name.setdefault(name.lower(), set()).add(os.path.normcase("/".join(owner)))
    for s in sessions:
        name, owner, slug = res[s["id"]]
        if owner and len(owner) > 1 and len(by_name.get(name.lower(), ())) > 1:
            s["project"] = "%s (%s)" % (name, owner[-2])


def _link_subs(sessions_by_id, subs):
    for sub in subs:
        parent = sessions_by_id.get(sub["session"])
        sub["parent"] = parent
        models = {}
        for r in sub["requests"]:
            models[r["model"]] = models.get(r["model"], 0) + 1
        sub["child_model"] = max(models, key=models.get) if models else None
        call = None
        if parent:
            tid = sub["sub_meta"].get("toolUseId") or parent["agent_ids"].get(sub["agent_id"].replace("agent-", ""))
            call = next((c for c in parent["agent_calls"] if c["id"] == tid), None)
            parent["subs"].append(sub)
        sub["call"] = call
        sub["id"], sub["id8"] = sub["session"], sub["session"][:8]
        sub["explicit_model"] = call.get("model") if call else sub["sub_meta"].get("model")
        sub["project"] = parent["project"] if parent else project_name(sub["cwd"], sub.get("project_dir", ""))
        sub["date"] = day(sub["first_ts"])


def infer_ttl(threads):
    """'1h' / '5m' / 'mixed' from the 5m/1h split of cache writes (None if no writes)."""
    c5 = c1 = 0
    for t in threads:
        for r in t["requests"]:
            if r["split"]:
                c5 += r["cc5"]
                c1 += r["cc1"]
    if c5 + c1 == 0:
        return None
    share = c1 / (c5 + c1)
    return "1h" if share >= 0.8 else "5m" if share <= 0.2 else "mixed"


def ttl_minutes(label):
    return 60 if label == "1h" else 5


def annotate(ctx):
    """Add cost, break flags and causes to every request, in place."""
    ctx.billing = {
        "main_cache_ttl": infer_ttl(ctx.sessions) or "unknown",
        "subagent_cache_ttl": infer_ttl(ctx.subs) or "unknown",
    }
    ctx.ttl = {"main": ttl_minutes(ctx.billing["main_cache_ttl"]),
               "sub": ttl_minutes(ctx.billing["subagent_cache_ttl"])}
    for t in ctx.threads():
        _annotate_thread(t, ctx.ttl["sub" if t["kind"] == "sub" else "main"], ctx.prices)


def _annotate_thread(t, ttl_min, prices):
    reqs = t["requests"]
    prev = None
    for i, r in enumerate(reqs):
        r["ctx"] = r["inp"] + r["cr"] + r["cc"]
        rates = prices.rates(r["model"], r["ctx"])
        prices.count_unknown(r["model"] or "unknown")
        r["cost"] = (r["inp"] * rates["input"] + r["cr"] * rates["cache_read"] + r["cc5"] * rates["cache_write_5m"]
                     + r["cc1"] * rates["cache_write_1h"] + r["out"] * rates["output"]) / 1e6
        # Price of a written token above the read price: what a rewrite costs extra.
        wp = ((r["cc5"] * rates["cache_write_5m"] + r["cc1"] * rates["cache_write_1h"]) / r["cc"]
              if r["cc"] else rates["cache_write_5m"])
        r["extra_per_tok"] = (wp - rates["cache_read"]) / 1e6
        r["first"] = i == 0
        r["gap"] = (r["ts"] - prev["ts"]) / 60.0 if prev and r["ts"] and prev["ts"] else 0.0
        r["cand"] = bool(prev and prev["cr"] >= BREAK_PREV_READ_MIN and r["cc"] > 0.5 * r["ctx"])
        r["brk"] = False
        r["rew"] = 0
        r["waste"] = 0.0
        r["cause"] = None
        prev = r
    normal = [r["cc"] for r in reqs if not r["first"] and not r["cand"]]
    med = statistics.median(normal) if normal else 0
    prev = None
    for r in reqs:
        if r["cand"] and r["cc"] - med >= BREAK_REWRITE_MIN:
            r["brk"] = True
            r["rew"] = r["cc"] - med
            r["waste"] = r["rew"] * r["extra_per_tok"]
            r["cause"] = _cause(r, prev, ttl_min)
        prev = r


def _cause(r, prev, ttl_min):
    # First match wins. An idle gap over the TTL beats a version change: the cache expired anyway.
    if r["comp"]:
        return "compaction"
    if r["model"] != prev["model"]:
        return "model_change"
    if r["gap"] > ttl_min:
        return "idle_over_ttl"
    if r["ver"] != prev["ver"]:
        return "version_change"
    if r["gap"] > IDLE_UNDER_TTL_MIN:
        return "idle_under_ttl"
    return "unexplained"


def insights_info(home, session_ids):
    base = os.path.join(home, ".claude", "usage-data")
    info = {"present": False}
    for name in ("facets", "session-meta"):
        d = os.path.join(base, name)
        try:
            files = [f for f in os.listdir(d) if f.endswith(".json")]
        except OSError:
            files = []
        info[name] = len(files)
        ids = {f[:-5] for f in files}
        info[name + "_joined"] = sum(1 for s in session_ids if s in ids)
        if files:
            info["present"] = True
            newest = max(os.stat(os.path.join(d, f)).st_mtime for f in files)
            info[name + "_newest"] = day(newest)
    return info


def build_context(projects_dir, days, cache_dir, prices, exclude_ids=(), now=None, home=None):
    now = now or time.time()
    ctx = Ctx()
    ctx.home = home or os.path.expanduser("~")
    ctx.now, ctx.days, ctx.projects_dir, ctx.prices = now, days, projects_dir, prices
    files = discover(projects_dir, days, now)
    ctx.n_files = len(files)
    mains, subs = [], []
    for path, kind, proj, session, agent in files:
        data, hit = wa_parse.load_cached(cache_dir, path, kind, session, agent)
        ctx.cache_stats["hits" if hit else "parsed"] += 1
        data["project_dir"] = proj
        (mains if kind == "main" else subs).append(data)
    excluded_ids = set()
    for s in mains:
        why = _is_excluded(s, exclude_ids)
        if why:
            excluded_ids.add(s["session"])
            ctx.excluded.append({"session": s["session"], "reason": why})
        else:
            _decorate_session(s, s["project_dir"])
            ctx.sessions.append(s)
    ctx.subs = [s for s in subs if s["session"] not in excluded_ids]
    assign_project_names(ctx.sessions)
    _link_subs({s["id"]: s for s in ctx.sessions}, ctx.subs)
    annotate(ctx)
    ctx.insights = insights_info(home or os.path.expanduser("~"), [s["id"] for s in ctx.sessions])
    return ctx
