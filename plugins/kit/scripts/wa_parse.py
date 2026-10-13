"""Stream one transcript file into a compact, JSON-serialisable dict, with an on-disk cache.

Parsed shape (see CONTRACT.md "Transcript facts" for the rules):
  kind, path, session, agent_id, cwd, entrypoint, first_ts, last_ts, bad_lines,
  versions {ver: requests}, modes [[ts, mode]...], compactions [ts...],
  requests [{id, ts, model, ver, inp, cr, cc, cc5, cc1, out, comp, pre, pre_ts, split}],
  humans [{ts, kind: typed|queued|command, text, cmd, tail}],   (main files only)
  tools [{ts, name, cmd, path, skill, desc}],                    (main files: all; subagents: edit tools only)
  agent_calls [{ts, id, model, type}], agent_ids {agentId: tool_use_id},
  interrupts [ts...], rejections [ts...], denials [{ts, kind, tool, cmd, reason}], tool_errors, sub_meta {toolUseId, agentType, model}
"""
import hashlib
import json
import os
import re

from wa_common import parse_ts

PARSER_VERSION = 3
TEXT_MAX = 2000
CMD_MAX = 300
DESC_MAX = 120
REASON = re.compile(r"Reason:\s*\[([^\]]{1,60})\]")
TAIL_MAX = 600

SKIP_PREFIXES = (
    "<task-notification", "<local-command", "<command-name>", "<command-message", "<system-reminder>",
    "[Usage limit", "[Earlier usage", "[Cross-session", "[Request interrupted",
    "This session is being continued", "Caveat:", "<bash-", "[Image:",
)
RELAY_PREFIXES = ("Another Claude session sent a message", "The coordinator sent a message")
CMD_NAME = re.compile(r"<command-name>\s*(/[^<\s]+)\s*</command-name>")
CMD_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
AGENT_TOOLS = ("Agent", "Task")
SHELL_TOOLS = ("Bash", "PowerShell")


def human_text(content):
    """Text of a user message, or None if it carries a tool_result or no text."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text").strip()
    return None


class _Parser:
    def __init__(self, kind, path, session, agent_id):
        self.p = dict(kind=kind, path=path, session=session, agent_id=agent_id, cwd=None, entrypoint=None,
                      first_ts=None, last_ts=None, bad_lines=0, versions={}, modes=[], compactions=[],
                      requests=[], humans=[], tools=[], agent_calls=[], agent_ids={}, interrupts=[],
                      rejections=[], denials=[], tool_errors=0, sub_meta={})
        self.tool_info = {}  # tool_use id -> (name, command), all threads, for linking denials
        self.sub = kind == "sub"
        self.req_by_id = {}
        self.seen_tools = set()
        self.queued_seen = set()
        self.queued_pending = {}  # queued text -> count not yet matched by a user record
        self.comp = False
        self.msg_since = False
        self.tool_ts_since = None
        self.tail = ""

    def feed(self, d):
        p = self.p
        ts = parse_ts(d.get("timestamp"))
        if ts:
            p["first_ts"] = p["first_ts"] or ts
            p["last_ts"] = ts
        if p["cwd"] is None and d.get("cwd"):
            p["cwd"] = d["cwd"]
        if p["entrypoint"] is None and d.get("entrypoint"):
            p["entrypoint"] = d["entrypoint"]
        mode = d.get("permissionMode")
        if isinstance(mode, str) and (not p["modes"] or p["modes"][-1][1] != mode):
            p["modes"].append([ts, mode])
        t = d.get("type")
        if t == "system" and d.get("subtype") == "compact_boundary":
            p["compactions"].append(ts)
            self.comp = True
        elif t == "attachment":
            self.attachment(d, ts)
        elif d.get("isSidechain") and not self.sub:
            return
        elif t == "user":
            self.user(d, ts)
        elif t == "assistant":
            self.assistant(d, ts)

    def attachment(self, d, ts):
        a = d.get("attachment")
        if self.sub or not isinstance(a, dict) or a.get("type") != "queued_command":
            return
        if (a.get("origin") or {}).get("kind") != "human":
            return
        prompt = a.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return
        key = (d.get("timestamp"), prompt)
        if key in self.queued_seen:
            return
        self.queued_seen.add(key)
        text = prompt.strip()
        if text.startswith(RELAY_PREFIXES + SKIP_PREFIXES):
            return
        self.queued_pending[text] = self.queued_pending.get(text, 0) + 1
        self.add_human(ts, "queued", text)

    def add_human(self, ts, kind, text, cmd=None):
        h = dict(ts=ts, kind=kind, text=text[:TEXT_MAX], tail=self.tail)
        if cmd:
            h["cmd"] = cmd
        self.p["humans"].append(h)

    def user(self, d, ts):
        p = self.p
        c = (d.get("message") or {}).get("content")
        is_result = ("toolUseResult" in d or d.get("sourceToolAssistantUUID")
                     or (isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)))
        if is_result:
            self.tool_result(d, c, ts)
            return
        if d.get("isCompactSummary"):
            return
        text = human_text(c)
        if text is None:
            return
        if text.startswith("[Request interrupted"):
            p["interrupts"].append(ts)
            return
        self.msg_since = True  # any user text between two requests counts as a message to the agent
        if self.sub or d.get("isMeta") or not text:
            return
        if isinstance(c, str) and "<command-name>" in text:
            m = CMD_NAME.search(text)
            if m:
                a = CMD_ARGS.search(text)
                self.add_human(ts, "command", (a.group(1).strip() if a else ""), cmd=m.group(1))
            return
        if text.startswith(RELAY_PREFIXES + SKIP_PREFIXES):
            return
        if self.queued_pending.get(text):  # already counted from its queued_command attachment
            self.queued_pending[text] -= 1
            return
        self.add_human(ts, "typed", text)

    def tool_result(self, d, c, ts):
        p = self.p
        self.tool_ts_since = ts
        tr = d.get("toolUseResult")
        blocks = [b for b in c if isinstance(b, dict) and b.get("type") == "tool_result"] if isinstance(c, list) else []
        if isinstance(tr, dict) and tr.get("agentId") and blocks:
            p["agent_ids"][tr["agentId"]] = blocks[0].get("tool_use_id")
        kind = d.get("toolDenialKind")
        for b in blocks:
            if b.get("is_error"):
                p["tool_errors"] += 1
                text = json.dumps(b.get("content"))
                if kind == "user-rejected" or (not kind and "doesn't want to proceed" in text):
                    p["rejections"].append(ts)
            if kind:
                name, cmd = self.tool_info.get(b.get("tool_use_id"), (None, None))
                den = dict(ts=ts, kind=kind, tool=name)
                if cmd:
                    den["cmd"] = cmd
                m = REASON.search(json.dumps(b.get("content"))) if kind.startswith("automode") else None
                if m:
                    den["reason"] = m.group(1)
                p["denials"].append(den)
                kind = None  # one denial per record
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").startswith("[Request interrupted"):
                    p["interrupts"].append(ts)

    def assistant(self, d, ts):
        p = self.p
        m = d.get("message")
        if not isinstance(m, dict):
            return
        content = m.get("content")
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id"):
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    self.tool_info[b["id"]] = (b.get("name"), str(inp.get("command", ""))[:CMD_MAX]
                                               if b.get("name") in SHELL_TOOLS else None)
        if isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
            if texts and not self.sub:
                self.tail = texts[-1][-TAIL_MAX:]
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use" and (not self.sub or b.get("name") in EDIT_TOOLS):
                    self.tool_use(b, ts)
        u = m.get("usage")
        model = m.get("model")
        eff = d.get("effort") or d.get("perTurnEffort")
        if not isinstance(u, dict) or model == "<synthetic>":
            return
        rid = m.get("id") or d.get("requestId")
        r = self.req_by_id.get(rid) if rid else None
        if r is None:
            r = dict(id=rid, ts=ts, model=model, ver=d.get("version"), comp=self.comp,
                     pre="message" if self.msg_since else ("tool_result" if self.tool_ts_since else "none"),
                     pre_ts=self.tool_ts_since)
            self.comp = False
            self.msg_since = False
            self.tool_ts_since = None
            p["requests"].append(r)
            if rid:
                self.req_by_id[rid] = r
        if eff and isinstance(eff, str):
            r["eff"] = eff
        cc = u.get("cache_creation_input_tokens") or 0
        split = u.get("cache_creation")
        if isinstance(split, dict) and ("ephemeral_5m_input_tokens" in split or "ephemeral_1h_input_tokens" in split):
            cc5 = split.get("ephemeral_5m_input_tokens") or 0
            cc1 = split.get("ephemeral_1h_input_tokens") or 0
            r["split"] = True
        else:
            cc5, cc1 = cc, 0
            r["split"] = False
        # The last record of a response carries its final usage.
        r.update(inp=u.get("input_tokens") or 0, cr=u.get("cache_read_input_tokens") or 0,
                 cc=cc, cc5=cc5, cc1=cc1, out=u.get("output_tokens") or 0)

    def tool_use(self, b, ts):
        tid = b.get("id")
        if tid in self.seen_tools:
            return
        self.seen_tools.add(tid)
        name = b.get("name")
        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
        t = dict(ts=ts, name=name)
        if name in SHELL_TOOLS:
            t["cmd"] = str(inp.get("command", ""))[:CMD_MAX]
        elif name in EDIT_TOOLS:
            t["path"] = inp.get("file_path") or inp.get("notebook_path")
        elif name == "Skill":
            t["skill"] = inp.get("skill")
        elif name in AGENT_TOOLS:
            t["desc"] = str(inp.get("description", ""))[:DESC_MAX]
            self.p["agent_calls"].append(dict(ts=ts, id=tid, model=inp.get("model"), type=inp.get("subagent_type")))
        self.p["tools"].append(t)


def parse_file(path, kind, session, agent_id=None):
    ps = _Parser(kind, path, session, agent_id)
    with open(path, encoding="utf8", errors="replace") as fh:
        for line in fh:
            if len(line) < 3:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                ps.p["bad_lines"] += 1
                continue
            if isinstance(d, dict):
                ps.feed(d)
    for r in ps.p["requests"]:
        if r["ver"]:
            ps.p["versions"][r["ver"]] = ps.p["versions"].get(r["ver"], 0) + 1
    if kind == "sub":
        ps.p["sub_meta"] = read_sub_meta(path)
    return ps.p


def read_sub_meta(path):
    meta = path[:-len(".jsonl")] + ".meta.json"
    try:
        with open(meta, encoding="utf8") as f:
            m = json.load(f)
        return {k: m.get(k) for k in ("toolUseId", "agentType", "model")}
    except (OSError, ValueError):
        return {}


def _cache_file(cache_dir, path):
    return os.path.join(cache_dir, hashlib.sha1(path.encode("utf8")).hexdigest()[:20] + ".json")


def load_cached(cache_dir, path, kind, session, agent_id=None):
    """Returns (parsed, from_cache). Keyed on path + size + mtime."""
    st = os.stat(path)
    path_id = os.path.normcase(os.path.abspath(path))
    key = [PARSER_VERSION, path_id, st.st_size, st.st_mtime_ns]
    cf = _cache_file(cache_dir, path_id)
    try:
        with open(cf, encoding="utf8") as f:
            blob = json.load(f)
        if blob.get("key") == key:
            return blob["data"], True
    except (OSError, ValueError):
        pass
    data = parse_file(path, kind, session, agent_id)
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = cf + ".tmp%d" % os.getpid()
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(dict(key=key, data=data), f, separators=(",", ":"))
        os.replace(tmp, cf)
    except OSError:
        pass
    return data, False
