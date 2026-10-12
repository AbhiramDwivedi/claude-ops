"""cost.total and cost.cache.* : price-weighted cost, cache breaks, their causes and what-ifs."""
import statistics

from wa_common import pct
from wa_registry import metric, example

CAUSES = ("compaction", "model_change", "idle_over_ttl", "version_change", "idle_under_ttl", "unexplained")


def _kind(t):
    return "subagent" if t["kind"] == "sub" else "main"


def _owner(t):
    return t.get("parent") or t


def _is_unattended(t):
    return "unattended" if _owner(t).get("unattended", True) else "interactive"


HANDOFF_TOKENS = 5000


def _round_map(d, nd=4):
    return {k: round(v, nd) for k, v in sorted(d.items(), key=lambda kv: -kv[1])}


@metric
def cost_total(ctx):
    by_model, by_project, by_kind = {}, {}, {"main": 0.0, "subagent": 0.0}
    by_att = {"interactive": 0.0, "unattended": 0.0}
    for t, r in ctx.requests():
        c = r["cost"]
        by_att[_is_unattended(t)] += c
        by_model[r["model"] or "unknown"] = by_model.get(r["model"] or "unknown", 0) + c
        by_project[t["project"]] = by_project.get(t["project"], 0) + c
        by_kind[_kind(t)] += c
    total = sum(by_kind.values())
    return {"cost.total": {"usd": round(total, 2), "n": sum(len(t["requests"]) for t in ctx.threads()),
                           "by_kind": {"interactive": round(by_att["interactive"], 2),
                                       "unattended": round(by_att["unattended"], 2),
                                       "interactive_pct": pct(by_att["interactive"], total),
                                       "unattended_pct": pct(by_att["unattended"], total)},
                           "main": round(by_kind["main"], 2), "subagent": round(by_kind["subagent"], 2),
                           "by_model": _round_map(by_model, 2),
                           "by_project": _round_map(dict(sorted(by_project.items(), key=lambda kv: -kv[1])[:15]), 2),
                           "unit": "USD at list prices"}}


def _resume_kind(r, prev, ttl_min):
    # What came right before a subagent's break: a message to it, a tool call that ran past the TTL, or nothing special.
    if r["pre"] == "message":
        return "message"
    if r["pre"] == "tool_result" and r.get("pre_ts") and prev["ts"] and (r["pre_ts"] - prev["ts"]) / 60.0 > ttl_min:
        return "long_tool_call"
    return "other"


@metric
def cost_cache(ctx):
    total = sum(r["cost"] for _, r in ctx.requests())
    waste = {"main": 0.0, "subagent": 0.0}
    causes = {}
    resume = {k: [0, 0.0] for k in ("message", "long_tool_call", "other")}
    start = extra_1h = saved_1h = 0.0
    per_session = {}
    ttl_sub = ctx.ttl["sub"]
    cost_kind = {"interactive": 0.0, "unattended": 0.0}
    waste_kind = {"interactive": 0.0, "unattended": 0.0}
    firsts = [t["requests"][0]["ctx"] for t in ctx.threads() if t["kind"] == "sub" and t["requests"]]
    start_ctx = int(statistics.median(firsts)) + HANDOFF_TOKENS if firsts else HANDOFF_TOKENS
    fresh = {"breaks": 0, "waste": 0.0, "fresh": 0.0, "saving": 0.0}
    for t in ctx.threads():
        kind = _kind(t)
        reqs = t["requests"]
        att = _is_unattended(t)
        for i, r in enumerate(reqs):
            cost_kind[att] += r["cost"]
            if kind == "subagent":
                if r["first"]:
                    start += r["cc"] * r["extra_per_tok"]
                rates = ctx.prices.rates(r["model"], r["ctx"])
                extra_1h += r["cc5"] * (rates["cache_write_1h"] - rates["cache_write_5m"]) / 1e6
            if not r["brk"]:
                continue
            waste[kind] += r["waste"]
            waste_kind[att] += r["waste"]
            row = causes.setdefault((kind, r["cause"]), [0, 0, 0.0])
            row[0] += 1
            row[1] += r["rew"]
            row[2] += r["waste"]
            o = _owner(t)
            ps = per_session.setdefault(o["id"], [o, 0.0, 0])
            ps[1] += r["waste"]
            ps[2] += 1
            if kind == "subagent":
                k = _resume_kind(r, reqs[i - 1], ttl_sub)
                resume[k][0] += 1
                resume[k][1] += r["waste"]
                if k == "message":
                    fc = start_ctx * ctx.prices.rates(r["model"], start_ctx)["cache_write_5m"] / 1e6
                    fresh["breaks"] += 1
                    fresh["waste"] += r["waste"]
                    fresh["fresh"] += fc
                    fresh["saving"] += max(0.0, r["waste"] - fc)
                if r["cause"] == "idle_over_ttl" and r["gap"] <= 60 and ttl_sub < 60:
                    saved_1h += r["waste"]
    by_cause = [{"thread": k, "cause": c, "count": v[0], "rewritten_tokens": v[1], "waste_pct": pct(v[2], total)}
                for (k, c), v in sorted(causes.items(), key=lambda kv: (kv[0][0], CAUSES.index(kv[0][1])))]
    total_waste = waste["main"] + waste["subagent"]
    top = sorted(per_session.values(), key=lambda v: -v[1])[:10]
    return {
        "cost.cache.waste_pct": {"main": pct(waste["main"], total), "subagent": pct(waste["subagent"], total),
                                 "total": pct(waste["main"] + waste["subagent"], total), "n": len(ctx.threads())},
        "cost.cache.waste_pct_by_kind": {k: pct(waste_kind[k], cost_kind[k]) for k in ("interactive", "unattended")},
        "cost.cache.by_cause": by_cause,
        "cost.cache.subagent_start_pct": pct(start, total),
        "cost.cache.resume_breaks": {k: {"count": v[0], "waste_pct": pct(v[1], total)} for k, v in resume.items()},
        "cost.cache.what_if.subagent_ttl_1h": {
            "extra_pct": pct(extra_1h, total), "saved_pct": pct(saved_1h, total),
            "net_pct": pct(saved_1h - extra_1h, total),
            "note": "extra = rate premium of 1h over 5m writes; saved = sub breaks idle between 5 and 60 min"},
        "cost.cache.what_if.fresh_instead_of_resume": {
            "breaks": fresh["breaks"], "waste_pct": pct(fresh["waste"], total),
            "fresh_cost_pct": pct(fresh["fresh"], total), "net_saving_pct": pct(fresh["saving"], total),
            "start_ctx_tokens": start_ctx,
            "assumption": "a fresh subagent writes start_ctx tokens (median first-request context of subagents + 5000-token "
                          "handoff note) to the 5m cache; saving per break = max(0, rewrite waste - that write cost). "
                          "Ignores the work a fresh agent must redo to rebuild understanding."},
        "cost.cache.top_sessions": [dict(example(o, pct(w, total)), breaks=n, kind=_is_unattended(o),
                                         share_of_waste=round(w / total_waste, 4) if total_waste else 0.0)
                                    for o, w, n in top],
    }
