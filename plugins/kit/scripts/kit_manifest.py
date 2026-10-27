"""Write kit's manifest, <repo>/.claude/kit/manifest.json, and render its read-only agents into the stop gates.

The only writer of the manifest (repo ADR-0013); the contract is plugins/kit/docs/manifest.schema.json.

  write   --repo <dir> --facts <file|->                       the facts kit init's owner approved
  declare --repo <dir> --by <plugin> --read-only <name>[,...] a plugin marks its own agent types read-only

Exit 0 prints one JSON line: {"manifest": <path>, "changed": bool, "gates": {"stop-gate.sh": s, "stop-gate.ps1": s}},
s being updated, unchanged, absent or no-markers. On error nothing is written and stderr is one line,
"kit_manifest: <CODE>: <detail>": exit 2 for bad input, 3 for the repo's state, 1 (IO_ERROR) when the OS refuses
a read or write.
"""
import argparse
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time

KIT_VERSION = "0.2.0"
MANIFEST_VERSION = 1

FACT_KEYS = ("checks", "agents", "riskyPaths", "setupScripts")
MANIFEST_KEYS = ("version", "kit") + FACT_KEYS
CHECK_KEYS = ("name", "kind", "command", "gate")
AGENT_KEYS = ("name", "readOnly", "declaredBy")
RISKY_KEYS = ("path", "why")

CHECK_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
CHECK_KINDS = ("test", "lint", "typecheck", "format", "build")
GATES = ("edit", "stop", "none")
ONE_LINE = re.compile(r"[^\r\n]+")
AGENT_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_-]{1,64})?")
DECLARER = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
SETUP_SCRIPTS = (".claude/worktree-setup.sh", ".claude/worktree-setup.ps1")
# Declarers whose agents `write` replaces; any other plugin's declarations survive a rewrite.
OWN_DECLARERS = ("kit", "project")

# Claude Code's built-in read-only agent types, always first in the gates' skip list.
BUILTIN_READ_ONLY = ("Explore", "Plan", "claude-code-guide")
BEGIN = b"# kit:read-only-agents:begin"
END = b"# kit:read-only-agents:end"
GATE_FILES = ("stop-gate.sh", "stop-gate.ps1")


class Fail(Exception):
    def __init__(self, code, detail, exit_code):
        Exception.__init__(self, detail)
        self.code, self.detail, self.exit_code = code, detail, exit_code


def bad(code, detail):
    return Fail(code, detail, 2)


class Parser(argparse.ArgumentParser):
    """argparse, but a usage error is one BAD_ARGS line and exit 2."""

    def error(self, message):
        raise bad("BAD_ARGS", message)


# ---------- validation (the schema's rules, by hand) ----------

def _object(value, where, keys, err):
    if not isinstance(value, dict):
        raise err("BAD_FIELD", "%s must be an object" % where)
    for k in value:
        if k not in keys:
            raise err("BAD_FIELD", "%s has unknown key %r" % (where, k))
    for k in keys:
        if k not in value:
            raise err("MISSING_FIELD", "%s has no %r" % (where, k))


def _string(value, where, pattern, err):
    if not isinstance(value, str):
        raise err("BAD_FIELD", "%s must be a string" % where)
    if pattern is not None and not pattern.fullmatch(value):
        raise err("BAD_FIELD", "%s is %r, which doesn't match the schema" % (where, value))


def _enum(value, where, allowed, err):
    if not isinstance(value, str) or value not in allowed:
        raise err("BAD_FIELD", "%s is %r, not one of %s" % (where, value, ", ".join(allowed)))


def _array(value, where, err):
    if not isinstance(value, list):
        raise err("BAD_FIELD", "%s must be an array" % where)
    return value


def check_agent_name(name, declared_by, where, err):
    """The name pattern, then the declarer rule: a qualified name's prefix is its declarer, a bare one's is project."""
    if not isinstance(name, str) or not AGENT_NAME.fullmatch(name):
        raise err("BAD_AGENT_NAME", "%s is %r: want plugin:name or a bare name, letters, digits, _ and - only"
                  % (where, name))
    owner = name.split(":", 1)[0] if ":" in name else "project"
    if owner != declared_by:
        raise err("DECLARER_MISMATCH", "%s is %r, which only %r can declare, not %r" % (where, name, owner, declared_by))


def validate_facts(facts, err=bad):
    """Check the four fact fields and return them rebuilt with keys in schema order and agents sorted by name."""
    _object(facts, "facts", FACT_KEYS, err)

    checks = []
    for i, c in enumerate(_array(facts["checks"], "checks", err)):
        where = "checks[%d]" % i
        _object(c, where, CHECK_KEYS, err)
        _string(c["name"], where + ".name", CHECK_NAME, err)
        _enum(c["kind"], where + ".kind", CHECK_KINDS, err)
        _string(c["command"], where + ".command", ONE_LINE, err)
        _enum(c["gate"], where + ".gate", GATES, err)
        item = {k: c[k] for k in CHECK_KEYS}
        if item in checks:
            raise err("BAD_FIELD", "%s repeats an earlier check" % where)
        checks.append(item)

    agents, seen = [], {}
    for i, a in enumerate(_array(facts["agents"], "agents", err)):
        where = "agents[%d]" % i
        _object(a, where, AGENT_KEYS, err)
        if not isinstance(a["readOnly"], bool):
            raise err("BAD_FIELD", "%s.readOnly must be true or false" % where)
        _string(a["declaredBy"], where + ".declaredBy", DECLARER, err)
        check_agent_name(a["name"], a["declaredBy"], where + ".name", err)
        folded = a["name"].casefold()
        if folded in seen:
            raise err("DUPLICATE_AGENT", "%s %r and %r are the same agent type" % (where, seen[folded], a["name"]))
        seen[folded] = a["name"]
        agents.append({k: a[k] for k in AGENT_KEYS})

    risky = []
    for i, r in enumerate(_array(facts["riskyPaths"], "riskyPaths", err)):
        where = "riskyPaths[%d]" % i
        _object(r, where, RISKY_KEYS, err)
        _string(r["path"], where + ".path", ONE_LINE, err)
        _string(r["why"], where + ".why", ONE_LINE, err)
        risky.append({k: r[k] for k in RISKY_KEYS})

    scripts = []
    for i, s in enumerate(_array(facts["setupScripts"], "setupScripts", err)):
        _enum(s, "setupScripts[%d]" % i, SETUP_SCRIPTS, err)
        if s in scripts:
            raise err("BAD_FIELD", "setupScripts[%d] repeats %r" % (i, s))
        scripts.append(s)

    return {"checks": checks, "agents": sort_agents(agents), "riskyPaths": risky, "setupScripts": scripts}


def sort_agents(agents):
    return sorted(agents, key=lambda a: a["name"])


def build(facts):
    m = {"version": MANIFEST_VERSION, "kit": KIT_VERSION}
    m.update((k, facts[k]) for k in FACT_KEYS)
    return m


def serialise(manifest):
    return (json.dumps(manifest, indent=2) + "\n").encode("utf-8")


# ---------- reading ----------

def manifest_path(repo):
    return os.path.abspath(os.path.join(repo, ".claude", "kit", "manifest.json"))


def read_manifest(path):
    """The existing manifest as (bytes, object), or (None, None) when there is none."""
    if not os.path.exists(path):
        return None, None
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise Fail("MANIFEST_CORRUPT", "%s can't be read: %s" % (path, e), 3)
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise Fail("MANIFEST_CORRUPT", "%s isn't JSON: %s" % (path, e), 3)
    if not isinstance(obj, dict):
        raise Fail("MANIFEST_CORRUPT", "%s isn't a JSON object" % path, 3)
    version = obj.get("version")
    if isinstance(version, int) and not isinstance(version, bool) and version > MANIFEST_VERSION:
        raise Fail("NEWER_VERSION", "%s is version %d; this kit (%s) writes version %d"
                   % (path, version, KIT_VERSION, MANIFEST_VERSION), 3)

    def corrupt(_code, detail):
        return Fail("MANIFEST_CORRUPT", "%s: %s" % (path, detail), 3)

    _object(obj, "manifest", MANIFEST_KEYS, corrupt)
    if version != MANIFEST_VERSION or isinstance(version, bool):
        raise corrupt(None, "version is %r, not %d" % (version, MANIFEST_VERSION))
    _string(obj["kit"], "kit", SEMVER, corrupt)
    validate_facts({k: obj[k] for k in FACT_KEYS}, corrupt)
    return raw, obj


def read_facts(source):
    try:
        if source == "-":
            raw = sys.stdin.buffer.read()
        else:
            with open(source, "rb") as f:
                raw = f.read()
    except OSError as e:
        raise bad("BAD_ARGS", "can't read --facts %s: %s" % (source, e))
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as e:
        raise bad("BAD_JSON", "--facts %s isn't JSON: %s" % (source, e))


# ---------- the stop gates ----------

def skip_list(agents):
    names, seen = list(BUILTIN_READ_ONLY), {n.casefold() for n in BUILTIN_READ_ONLY}
    for name in sorted(a["name"] for a in agents if a["readOnly"]):
        if name.casefold() not in seen:
            seen.add(name.casefold())
            names.append(name)
    return names


def gate_line(gate, names):
    if gate.endswith(".sh"):
        return 'case "$agent" in %s) exit 0 ;; esac' % "|".join(names)
    return "if ($in.agent_type -in %s) { exit 0 }" % ",".join("'%s'" % n for n in names)


def render_gate(raw, line):
    """The gate's bytes with one line between the markers, or None when it has no single begin/end pair.

    Works on bytes so everything outside the markers, line endings and any BOM included, stays as it was.
    The new line takes the begin marker's indent and line ending.
    """
    lines = raw.splitlines(keepends=True)
    begins = [i for i, l in enumerate(lines) if l.strip() == BEGIN]
    ends = [i for i, l in enumerate(lines) if l.strip() == END]
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        return None
    b, e = begins[0], ends[0]
    marker = lines[b]
    indent = marker[:len(marker) - len(marker.lstrip())]
    eol = marker[len(marker.rstrip(b"\r\n")):] or b"\n"
    return b"".join(lines[:b + 1]) + indent + line.encode("ascii") + eol + b"".join(lines[e:])


def plan_gates(repo, agents):
    """Each gate's status, and the (path, new bytes, old bytes) writes it needs."""
    names, statuses, writes = skip_list(agents), {}, []
    for gate in GATE_FILES:
        path = os.path.join(repo, ".claude", "kit", gate)
        if not os.path.isfile(path):
            statuses[gate] = "absent"
            continue
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            raise io_error("can't read", path, e)
        new = render_gate(raw, gate_line(gate, names))
        if new is None:
            statuses[gate] = "no-markers"
        elif new == raw:
            statuses[gate] = "unchanged"
        else:
            statuses[gate] = "updated"
            writes.append((path, new, raw))
    return statuses, writes


# ---------- writing ----------

def io_error(what, path, e):
    return Fail("IO_ERROR", "%s %s: %s" % (what, path, e.strerror or e), 1)


def stage(path, data):
    """A temp file beside path holding data, with path's mode when path exists (a gate's +x)."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if os.path.exists(path):
            shutil.copymode(path, tmp)
    except BaseException:
        discard(tmp)
        raise
    return tmp


def discard(tmp):
    """Remove a temp file if it is still there, read-only or not; return why it couldn't be, or None."""
    try:
        if os.path.lexists(tmp):
            os.chmod(tmp, stat.S_IREAD | stat.S_IWRITE)
            os.remove(tmp)
    except OSError as e:
        return "left %s: %s" % (tmp, e.strerror or e)
    return None


def restore(path, backup):
    """Put back a file write_all already replaced; return why it couldn't, or None.

    Retried briefly: on Windows a file renamed a moment ago can be held open by a virus scanner or the indexer.
    """
    for attempt in range(5):
        try:
            if backup is None:
                os.remove(path)
            else:
                os.replace(backup, path)
            return None
        except OSError as e:
            if attempt == 4:
                return "couldn't restore %s: %s" % (path, e.strerror or e)
            time.sleep(0.1)


def write_all(writes):
    """Write every (path, new bytes, old bytes or None), or as far as the OS allows none of them.

    First every temp file: the new bytes, and a backup of the old bytes for a file that exists. A failure
    there changes nothing. Then each new file is renamed into place; if a rename fails, the files already
    replaced get their backups back (or are removed, when they didn't exist). No temp file is left behind.
    """
    staged, temps, error = [], [], None
    try:
        for path, new, old in writes:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = stage(path, new)
            temps.append(tmp)
            backup = None
            if old is not None:
                backup = stage(path, old)
                temps.append(backup)
            staged.append((path, tmp, backup))
    except OSError as e:
        error = io_error("can't write", path, e)

    done = []
    for path, tmp, backup in ([] if error else staged):
        try:
            os.replace(tmp, path)
        except OSError as e:
            error = io_error("can't write", path, e)
            break
        done.append((path, backup))

    problems = []
    if error:
        for path, backup in reversed(done):
            problem = restore(path, backup)
            if problem:
                problems.append(problem)
    problems += [p for p in map(discard, temps) if p]
    if error:
        error.detail = "; ".join([error.detail] + problems)
        raise error
    if problems:
        raise Fail("IO_ERROR", "wrote everything, but " + "; ".join(problems), 1)


def commit(repo, path, old_raw, manifest):
    """Write the manifest (when its bytes changed) and the gates, all or none, and return the stdout object."""
    data = serialise(manifest)
    changed = data != old_raw
    statuses, writes = plan_gates(repo, manifest["agents"])
    if changed:
        writes.insert(0, (path, data, old_raw))
    write_all(writes)
    return {"manifest": path, "changed": changed, "gates": statuses}


def cmd_write(repo, facts_source):
    facts = validate_facts(read_facts(facts_source))
    path = manifest_path(repo)
    old_raw, old = read_manifest(path)
    if old is not None:
        named = {a["name"].casefold() for a in facts["agents"]}
        kept = [a for a in old["agents"] if a["declaredBy"] not in OWN_DECLARERS and a["name"].casefold() not in named]
        facts["agents"] = sort_agents(facts["agents"] + [{k: a[k] for k in AGENT_KEYS} for a in kept])
    return commit(repo, path, old_raw, build(facts))


def cmd_declare(repo, by, names_arg):
    if not DECLARER.fullmatch(by):
        raise bad("BAD_ARGS", "--by %r isn't a plugin name (lower-case letters, digits and -)" % by)
    names = [n.strip() for n in names_arg.split(",")]
    if not all(names):
        raise bad("BAD_ARGS", "--read-only %r has an empty name" % names_arg)
    seen = {}
    for name in names:
        check_agent_name(name, by, "--read-only name", bad)
        if name.casefold() in seen:
            raise bad("DUPLICATE_AGENT", "--read-only names %r and %r twice" % (seen[name.casefold()], name))
        seen[name.casefold()] = name
    path = manifest_path(repo)
    old_raw, old = read_manifest(path)
    if old is None:
        raise Fail("NO_MANIFEST", "%s doesn't exist; run kit init first" % path, 3)
    agents = [{k: a[k] for k in AGENT_KEYS} for a in old["agents"] if a["name"].casefold() not in seen]
    agents += [{"name": n, "readOnly": True, "declaredBy": by} for n in names]
    facts = {k: old[k] for k in FACT_KEYS}
    facts["agents"] = sort_agents(agents)
    return commit(repo, path, old_raw, build(facts))


def main(argv=None):
    ap = Parser(prog="kit_manifest.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", parser_class=Parser)
    w = sub.add_parser("write", help="write the manifest from approved facts")
    w.add_argument("--repo", required=True)
    w.add_argument("--facts", required=True, help="a JSON file, or - for stdin")
    d = sub.add_parser("declare", help="mark a plugin's agent types read-only")
    d.add_argument("--repo", required=True)
    d.add_argument("--by", required=True)
    d.add_argument("--read-only", required=True, dest="read_only", help="comma-separated full agent types")
    try:
        a = ap.parse_args(argv)
        if a.command is None:
            raise bad("BAD_ARGS", "want a command: write or declare")
        if not os.path.isdir(a.repo):
            raise Fail("NO_REPO", "%s isn't a directory" % a.repo, 3)
        if a.command == "write":
            out = cmd_write(a.repo, a.facts)
        else:
            out = cmd_declare(a.repo, a.by, a.read_only)
        sys.stdout.write(json.dumps(out) + "\n")
        return 0
    except Fail as caught:
        f = caught
    except OSError as e:  # the guard: an OS error no code path names still ends as one line, not a traceback
        f = Fail("IO_ERROR", str(e), 1)
    detail = " ".join(f.detail.split())  # one line, whatever the detail held
    sys.stderr.write("kit_manifest: %s: %s\n" % (f.code, detail))
    return f.exit_code


if __name__ == "__main__":
    sys.exit(main())
