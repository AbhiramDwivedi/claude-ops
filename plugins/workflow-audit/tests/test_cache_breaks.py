import os
import unittest

import helpers
from helpers import stamp, warm, write_thread
import wa_model
import wa_registry
from wa_prices import Prices

PRICES = Prices.load(helpers.PRICES)
BREAK = dict(cr=0, cc=100000)   # the whole context is rewritten


def build(d_projects, d_cache):
    return wa_model.build_context(d_projects, 36500, d_cache, Prices.load(helpers.PRICES), now=helpers.T0.timestamp() + 86400 * 30 * 12)


class Scenarios(unittest.TestCase):
    """One synthetic main session per scenario; the break is the 4th request."""

    @classmethod
    def setUpClass(cls):
        cls.tmp, projects, cache = helpers.temp_projects()
        cls.main_ids = {}
        scenarios = {
            "compaction": dict(t=4, compact=True),
            "model_change": dict(t=4, model="claude-test-sub"),
            "idle_over_ttl": dict(t=100),                      # main TTL is 1h
            "version_change": dict(t=4, ver="2.0"),
            "idle_over_beats_version": dict(t=100, ver="2.0"),
            "idle_under_ttl": dict(t=15),
            "unexplained": dict(t=4),
        }
        for name, extra in scenarios.items():
            sid = "s-" + name
            steps = warm(3) + [dict(BREAK, **extra)]
            write_thread(os.path.join(projects, "-p", sid + ".jsonl"), sid, steps)
            cls.main_ids[name] = sid
        cls.ctx = build(projects, cache)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def causes(self, name):
        s = next(s for s in self.ctx.sessions if s["id"] == self.main_ids[name])
        return [r["cause"] for r in s["requests"] if r["brk"]]

    def test_main_ttl_is_inferred_from_writes(self):
        self.assertEqual(self.ctx.billing["main_cache_ttl"], "1h")

    def test_each_cause(self):
        for name in ("compaction", "model_change", "idle_over_ttl", "version_change", "idle_under_ttl", "unexplained"):
            with self.subTest(name):
                self.assertEqual(self.causes(name), [name])

    def test_idle_over_ttl_takes_precedence_over_version_change(self):
        self.assertEqual(self.causes("idle_over_beats_version"), ["idle_over_ttl"])

    def test_ordinary_requests_are_not_breaks(self):
        s = next(s for s in self.ctx.sessions if s["id"] == self.main_ids["unexplained"])
        self.assertEqual(sum(r["brk"] for r in s["requests"]), 1)

    def test_waste_is_rewrite_at_write_price_minus_read_price(self):
        s = next(s for s in self.ctx.sessions if s["id"] == self.main_ids["unexplained"])
        r = next(r for r in s["requests"] if r["brk"])
        # claude-test: 1h write 20, read 1 -> 19 USD/M; 99,000 rewritten above the normal 1,000 write
        self.assertAlmostEqual(r["waste"], 99000 * 19 / 1e6, places=6)

    def test_metrics_by_cause_rows(self):
        m = wa_registry.run_all(self.ctx, ["wa_m_meta", "wa_m_cost", "wa_m_agents"])
        rows = {(r["thread"], r["cause"]): r for r in m["cost"]["cache"]["by_cause"]}
        self.assertEqual(rows[("main", "compaction")]["count"], 1)
        self.assertEqual(rows[("main", "idle_over_ttl")]["count"], 2)
        self.assertGreater(m["cost"]["cache"]["waste_pct"]["main"], 0)
        self.assertEqual(m["cost"]["cache"]["waste_pct"]["subagent"], 0)


class SubagentBreaks(unittest.TestCase):
    """Subagent threads write 5m, so the TTL is 5 minutes; check resume_breaks and what-if."""

    @classmethod
    def setUpClass(cls):
        cls.tmp, projects, cache = helpers.temp_projects()
        sid = "sess-sub"
        coordinator = {"t": 11, "type": "user", "message": {"role": "user", "content": "The coordinator sent a message: go on"}}
        long_tool = {"t": 30, "type": "user", "toolUseResult": "x",
                     "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "late"}]}}
        steps = (warm(2)
                 + [dict(BREAK, t=12, before=[coordinator])]                  # gap 10 min, message before
                 + [dict(t=13, cr=100000, cc=1000)]
                 + [dict(BREAK, t=31, before=[long_tool])]                    # gap 18 min, tool result 17 min after
                 + [dict(t=32, cr=100000, cc=1000)]
                 + [dict(BREAK, t=33, ver="9.9")]                             # gap 1 min, version change only
                 + [dict(t=34, cr=100000, cc=1000)]
                 + [dict(BREAK, t=50, ver="9.9", model="claude-test")])       # gap 16 min and a version change: idle wins
        write_thread(os.path.join(projects, "-p", sid, "subagents", "agent-x1.jsonl"), sid, steps, sub=True, one_hour=False)
        cls.ctx = build(projects, cache)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_subagent_ttl_is_5m(self):
        self.assertEqual(self.ctx.billing["subagent_cache_ttl"], "5m")

    def test_causes(self):
        sub = self.ctx.subs[0]
        self.assertEqual([r["cause"] for r in sub["requests"] if r["brk"]],
                         ["idle_over_ttl", "idle_over_ttl", "version_change", "idle_over_ttl"])

    def test_resume_breaks(self):
        m = wa_registry.run_all(self.ctx, ["wa_m_meta", "wa_m_cost", "wa_m_agents"])
        rb = m["cost"]["cache"]["resume_breaks"]
        self.assertEqual((rb["message"]["count"], rb["long_tool_call"]["count"], rb["other"]["count"]), (1, 1, 2))

    def test_what_if_1h_counts_idle_breaks_under_an_hour(self):
        m = wa_registry.run_all(self.ctx, ["wa_m_meta", "wa_m_cost", "wa_m_agents"])
        w = m["cost"]["cache"]["what_if"]["subagent_ttl_1h"]
        self.assertGreater(w["extra_pct"], 0)
        self.assertGreater(w["saved_pct"], 0)
        self.assertAlmostEqual(w["net_pct"], w["saved_pct"] - w["extra_pct"], places=2)


class Prices_(unittest.TestCase):
    def test_longest_prefix_wins(self):
        self.assertEqual(PRICES.rates("claude-test-sub-2")["input"], 2)
        self.assertEqual(PRICES.rates("claude-test-9")["input"], 10)

    def test_unknown_model_uses_fallback_multiples_and_is_recorded(self):
        p = Prices.load(helpers.PRICES)
        r = p.rates("claude-other-1")
        self.assertAlmostEqual(r["output"], r["input"] * 5.0)
        self.assertAlmostEqual(r["cache_read"], r["input"] * 0.1)
        self.assertIn("claude-other-1", p.unknown)

    def test_long_context_tier_applies_only_over_threshold(self):
        base = {"input": 0.1, "output": 0.5, "cache_read": 0.01,
                "cache_write_5m": 0.125, "cache_write_1h": 0.2}
        high = {"input": 0.5, "output": 2.5, "cache_read": 0.05,
                "cache_write_5m": 0.625, "cache_write_1h": 1.0}
        p = Prices({"models": {"claude-haiku-5-5": {
            **base, "over_100k": high,
        }}})
        self.assertEqual(p.rates("claude-haiku-5-5", 100000)["input"], 0.1)
        self.assertEqual(p.rates("claude-haiku-5-5", 100001), high)


if __name__ == "__main__":
    unittest.main()

    def test_by_kind_fresh_what_if_size_by_week(self):
        m = wa_registry.run_all(self.ctx, ["wa_m_meta", "wa_m_cost", "wa_m_agents"])
        bk = m["cost"]["total"]["by_kind"]
        self.assertEqual(bk["interactive"], 0)  # orphan subagent counts as unattended
        self.assertAlmostEqual(bk["unattended_pct"], 100.0, places=1)
        self.assertGreater(m["cost"]["cache"]["waste_pct_by_kind"]["unattended"], 0)
        top = m["cost"]["cache"]["top_sessions"][0]
        self.assertEqual(top["kind"], "unattended")
        self.assertAlmostEqual(top["share_of_waste"], 1.0, places=3)
        f = m["cost"]["cache"]["what_if"]["fresh_instead_of_resume"]
        self.assertEqual(f["breaks"], 1)
        self.assertEqual(f["start_ctx_tokens"], 5000 + 101000)  # first request: 100000 read + 1000 written
        self.assertAlmostEqual(f["net_saving_pct"], max(0.0, f["waste_pct"] - f["fresh_cost_pct"]), places=2)
        self.assertIn("redo", f["assumption"])
        bw = m["agents"]["size"]["by_week"]
        self.assertEqual(sum(r["subagents"] for r in bw.values()), 1)
        self.assertEqual(sum(r["over_200k"] for r in bw.values()), 0)
