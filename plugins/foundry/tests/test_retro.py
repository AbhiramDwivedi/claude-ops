"""Edge-case tests for scripts/retro.py that test_contract_retro.py does not pin.

All data is synthetic and written to a temp dir, never to fixtures/ (P8).
Run: python -m unittest discover -s plugins/foundry/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "retro.py"))
NR = "not recorded"


def ev(ts, event, **kw):
    d = {"v": 1, "ts": ts, "event": event, "crew": "c", "agent": "c"}
    d.update(kw)
    return json.dumps(d)


class RetroEdges(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="retro-edge-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def write(self, name, data):
        mode = "wb" if isinstance(data, bytes) else "w"
        kw = {} if isinstance(data, bytes) else {"encoding": "utf-8", "newline": ""}
        with open(os.path.join(self.dir, name), mode, **kw) as f:
            f.write(data)

    def run_retro(self):
        r = subprocess.run([sys.executable, SCRIPT, self.dir], capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
        return json.loads(r.stdout.decode("utf-8"))

    def test_corrupt_and_v2_lines_are_skipped_and_counted(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        lines = [ev("2026-01-01T01:00:00.000Z", "tag", tag="QUESTION"), "{not json", "[1,2]", "",
                 json.dumps({"v": 2, "ts": "2026-01-01T01:00:00Z", "event": "tag", "tag": "BLOCKED"}),
                 ev("not a time", "tag", tag="BLOCKED")]
        self.write("events.jsonl", "\n".join(lines) + "\n")
        out = self.run_retro()
        self.assertEqual(out["eventsSkipped"], 4)
        self.assertEqual(out["runs"][0]["escalations"], {"QUESTION": 1, "BLOCKED": 0, "PROPOSAL": 0})

    def test_non_utf8_bytes_do_not_crash(self):
        self.write("decisions.md", b"## Run 2026-01-01T00:00:00Z | g\xff\xfe\n- 09:00 | a\xff | b | c | followed\n")
        self.write("events.jsonl", b"\xff\xfe\x00garbage\n")
        out = self.run_retro()
        self.assertEqual(out["runs"][0]["decisions"]["followed"], 1)
        self.assertEqual(out["eventsSkipped"], 1)

    def test_mixed_grammars_classify_line_by_line(self):
        self.write("decisions.md", "\n".join([
            "- 2026-02-02 | d1 | r | c | followed",
            "- 2026-02-02T10:00:00+02:00 | d2 | r | c | overruled: x",
            "- HH:MM | d3 | r | c | —",
            "- 9:05 | cynic-1 RECOMMEND pass: nope | followed",
            "- 2026-02-02 free text without a bar",
            "- cynic-1 RECOMMEND answer: no time field",
            "    - 09:00 | indented | r | c | followed",
        ]) + "\n")
        run = self.run_retro()["runs"][0]
        self.assertEqual(run["decisions"], {"total": 3, "clock": 1, "dateOnly": 1, "notRecorded": 1,
                                            "followed": 1, "overruled": 1, "other": 1})
        self.assertEqual(run["freeform"], 2)
        self.assertEqual(run["recommendations"], {"total": 1, "answer": 0, "defer": 0, "pass": 1})

    def test_offset_heading_is_echoed_and_compared_as_an_instant(self):
        # 10:00+02:00 is 08:00Z. The 08:30Z event is after it; the 07:30Z one is before it.
        self.write("decisions.md", "## Run 2026-03-03T10:00:00+02:00 | offset run\n")
        self.write("events.jsonl", ev("2026-03-03T08:30:00.000Z", "stall", kind="agent", minutes=5) + "\n"
                   + ev("2026-03-03T07:30:00.000Z", "stall", kind="agent", minutes=5) + "\n")
        out = self.run_retro()
        self.assertEqual(out["runs"][0]["started"], "2026-03-03T10:00:00+02:00")
        self.assertEqual(out["runs"][0]["stalls"], {"agent": 1, "idleLead": 0})
        self.assertEqual(out["eventsOutsideRuns"], 1)

    def test_unparsable_heading_start_is_not_recorded_and_gets_no_events(self):
        self.write("decisions.md", "## Run yesterday-ish | odd goal\n- 09:00 | a | b | c | followed\n")
        self.write("events.jsonl", ev("2026-03-03T08:30:00.000Z", "spawn", model="opus", effort=None) + "\n")
        out = self.run_retro()
        self.assertEqual(out["split"], "headings")
        run = out["runs"][0]
        self.assertEqual((run["started"], run["goal"]), (NR, "odd goal"))
        self.assertEqual(run["decisions"]["total"], 1)
        self.assertEqual(run["spawns"], NR)
        self.assertEqual(out["eventsOutsideRuns"], 1)

    def test_heading_first_means_no_pre_heading_run(self):
        self.write("decisions.md", "# Title\n\n## Run 2026-01-01T00:00:00Z | g\n- 09:00 | a | b | c | followed\n")
        self.assertEqual(len(self.run_retro()["runs"]), 1)

    def test_events_without_headings_are_outside_and_not_recorded(self):
        self.write("decisions.md", "- 09:00 | a | b | c | followed\n")
        self.write("events.jsonl", ev("2026-03-03T08:30:00.000Z", "tag", tag="BLOCKED") + "\n")
        out = self.run_retro()
        self.assertEqual(out["split"], NR)
        self.assertEqual(out["runs"][0]["escalations"], NR)
        self.assertEqual(out["eventsOutsideRuns"], 1)

    def test_empty_events_file_gives_zeros_for_headed_runs(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        self.write("events.jsonl", "")
        self.assertEqual(self.run_retro()["runs"][0]["stalls"], {"agent": 0, "idleLead": 0})

    def test_no_decisions_file_and_odd_plan(self):
        self.write("plan.json", json.dumps({"crews": "nope"}))
        out = self.run_retro()
        self.assertEqual(out["split"], NR)
        self.assertEqual(out["plan"]["crews"], 0)
        self.write("plan.json", "not json")
        self.assertEqual(self.run_retro()["plan"], NR)

    def test_huge_line_is_skipped_not_loaded(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        self.write("events.jsonl", b'{"v":1,"pad":"' + b"x" * (3 << 20) + b'"}\n'
                   + ev("2026-01-01T01:00:00.000Z", "tag", tag="PROPOSAL").encode() + b"\n")
        out = self.run_retro()
        self.assertEqual(out["eventsSkipped"], 1)
        self.assertEqual(out["runs"][0]["escalations"]["PROPOSAL"], 1)

    def test_runs_from_another_cwd(self):
        other = tempfile.mkdtemp(prefix="retro-cwd-")
        self.addCleanup(shutil.rmtree, other, ignore_errors=True)
        self.write("decisions.md", "- 09:00 | a | b | c | followed\n")
        r = subprocess.run([sys.executable, SCRIPT, self.dir], capture_output=True, cwd=other, timeout=60)
        self.assertEqual(r.returncode, 0)

    # --- red-team regressions: no input may crash the script or break strict JSON ---

    def run_raw(self):
        r = subprocess.run([sys.executable, SCRIPT, self.dir], capture_output=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace")[-300:])

        def no_const(c):
            raise ValueError("non-JSON constant " + c)
        return json.loads(r.stdout.decode("utf-8"), parse_constant=no_const)

    def test_deeply_nested_lines_do_not_crash(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        self.write("events.jsonl", ev("2026-01-01T01:00:00Z", "stall", kind="agent") + "\n" + "[" * 200000 + "\n")
        self.write("messages.jsonl", "[" * 200000 + "\n")
        self.write("plan.json", "[" * 200000)
        out = self.run_raw()
        self.assertEqual(out["eventsSkipped"], 1)
        self.assertEqual(out["runs"][0]["stalls"]["agent"], 1)
        self.assertEqual(out["runs"][0]["messages"], 0)
        self.assertEqual(out["plan"], NR)

    def test_wrong_typed_event_fields_are_ignored(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        t = "2026-01-01T01:00:00Z"
        self.write("events.jsonl", "\n".join([
            ev(t, "tag", tag=["QUESTION"]), ev(t, "tag", tag={"a": 1}), ev(t, "tag", tag="BLOCKED"),
            ev(t, "stall", kind=["agent"]), ev(t, "report", agent=["x-judge"], marker=["VERDICT: PASS"]),
            ev(t, "report", agent="c-judge", marker={"a": 1}),
            ev(t, "spawn", model=["opus"], effort=5), ev(t, ["spawn"]),
        ]) + "\n")
        out = self.run_raw()
        run = out["runs"][0]
        self.assertEqual(out["eventsSkipped"], 0)
        self.assertEqual(run["escalations"], {"QUESTION": 0, "BLOCKED": 1, "PROPOSAL": 0})
        self.assertEqual(run["stalls"], {"agent": 0, "idleLead": 0})
        self.assertEqual(run["judges"], {"pass": 0, "fail": 0})
        self.assertEqual(run["spawns"], {"total": 1, "byModelEffort": {"unset/unset": 1}})

    def test_plan_output_is_strict_json(self):
        self.write("plan.json", '{"agentCap": NaN, "crews":[{"wave":1,"estAgents":Infinity,"status":"done"},'
                                '{"wave":1,"estAgents":3},{"estAgents":true},{"estAgents":1.5}]}')
        plan = self.run_raw()["plan"]
        self.assertEqual(plan["estAgents"], 3)
        self.assertIsNone(plan["agentCap"])
        self.assertEqual(plan["crews"], 4)

    def test_plan_huge_ints_do_not_crash(self):
        n = "9" * 4300
        self.write("plan.json", '{"agentCap": %s, "crews":[{"estAgents":%s},{"estAgents":%s},{"estAgents":2}]}' % (n, n, n))
        plan = self.run_raw()["plan"]
        self.assertEqual(plan["estAgents"], 2)
        self.assertIsNone(plan["agentCap"])

    def test_plan_valid_agent_cap_is_copied(self):
        self.write("plan.json", '{"agentCap": 12, "crews":[]}')
        self.assertEqual(self.run_raw()["plan"]["agentCap"], 12)

    def test_structured_decision_line_needs_a_space_after_the_pipe(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n"
                   "- 10:05| a | r | c | followed\n- 10:06 |nospace | followed\n- 10:07 |\n"
                   "- 10:08 | ok | r | c | followed\n")
        run = self.run_raw()["runs"][0]
        self.assertEqual(run["freeform"], 3)
        self.assertEqual(run["decisions"]["total"], 1)

    # --- half-failed roll: events.<n>.jsonl byte-identical to events.jsonl must count once ---

    def test_identical_rolled_events_file_counts_once(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        line = ev("2026-01-01T01:00:00Z", "spawn", model="opus", effort="high") + "\n"
        self.write("events.1.jsonl", line)
        self.write("events.jsonl", line)
        self.assertEqual(self.run_raw()["runs"][0]["spawns"]["total"], 1)

    def test_identical_rolled_messages_file_counts_once(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        line = json.dumps({"ts": "2026-01-01T01:00:00Z", "from": "a", "to": "b"}) + "\n"
        self.write("messages.1.jsonl", line)
        self.write("messages.jsonl", line)
        self.assertEqual(self.run_raw()["runs"][0]["messages"], 1)

    def test_different_rolled_files_both_count(self):
        self.write("decisions.md", "## Run 2026-01-01T00:00:00Z | g\n")
        a = ev("2026-01-01T01:00:00Z", "spawn", model="opus", effort="high") + "\n"
        b = ev("2026-01-01T01:00:00Z", "spawn", model="opus", effort="low") + "\n"
        self.write("events.1.jsonl", a)
        self.write("events.jsonl", b)  # same size, different bytes
        m = json.dumps({"ts": "2026-01-01T01:00:00Z"}) + "\n"
        self.write("messages.1.jsonl", m)
        self.write("messages.jsonl", m + m)  # rolled file is a prefix of the live one
        out = self.run_raw()["runs"][0]
        self.assertEqual(out["spawns"]["total"], 2)
        self.assertEqual(out["messages"], 3)


if __name__ == "__main__":
    unittest.main()
