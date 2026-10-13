"""Small helpers shared by the workflow-audit modules."""
import os
import re
from datetime import datetime, timezone

# Bump when a metric's definition changes, so a follow-up doesn't compare numbers measured two different ways.
# 2: verification counts a project's own check scripts (python bin/selftest.py and the like).
# 3: project labels map worktree and Claude scratchpad cwds to the owning project; cost by_kind, fresh_instead_of_resume, size.by_week, plugins_installed.
# 4: scratchpad paths win over worktree cuts; worktrees cut at the first hidden folder.
# 5: CLAUDE.md lines include @imports and AGENTS.md; in-repo scratchpad worktrees map to their project.
# 6: a cleaned-up worktree reads its project root's CLAUDE.md instead of counting as missing.
# 7: tool rejections counted from toolDenialKind; new permissions.denials, effort.by_model, verification.review_after_edits,
#    practices.usage.rewinds_after_untracked_edits and commands_used.
METRICS_VERSION = 7


def parse_ts(s):
    """ISO timestamp string -> epoch seconds, or None."""
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def day(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d") if t else None


def iso_week(t):
    y, w, _ = datetime.fromtimestamp(t, timezone.utc).isocalendar()
    return "%d-W%02d" % (y, w)


def resolve_cwd(cwd):
    """(name, owner_parts, slug) for a cwd. Worktree dirs map to the segment before the hidden worktree segment;
    a Claude scratchpad path (.../claude/<slug>/...) gives slug and a best-effort name (resolved later against known names)."""
    parts = path_parts(cwd)
    # a scratchpad first, since eval harnesses make worktrees inside them: <tmp>/claude[-uid]/<project slug>/...
    for i, p in enumerate(parts[:-1]):
        if re.match(r"(?i)^claude(-\d+)?$", p) and "-" in parts[i + 1]:
            slug = parts[i + 1]
            toks = [t for t in slug.split("-") if t]
            return (toks[-1] if toks else slug), None, slug
    # a worktree: cut at the first hidden folder on the way to it (app/.hardening/x/.run-worktrees/y -> app)
    if any("worktree" in p.lower() for p in parts):
        w = next(i for i, p in enumerate(parts) if "worktree" in p.lower())
        k = next((i for i in range(1, w + 1) if parts[i].startswith(".") or parts[i].lower() == "scratchpad"), None)
        if k:
            return parts[k - 1], parts[:k], None
    if parts:
        return parts[-1], parts, None
    return None, None, None


def slug_name(slug, known):
    """Longest known project name the slug ends with, else the slug's last token."""
    s = slug.lower()
    best = None
    for n in known:
        nl = re.sub(r"[^a-z0-9]+", "-", n.lower()).strip("-")
        if nl and (s == nl or s.endswith("-" + nl)) and (best is None or len(nl) > len(re.sub(r"[^a-z0-9]+", "-", best.lower()).strip("-"))):
            best = n
    if best:
        return best
    toks = [t for t in slug.split("-") if t]
    return toks[-1] if toks else slug


def project_name(cwd, folder=""):
    """Readable project name: owning project of cwd (worktrees and scratchpads mapped back), else of the folder slug."""
    name = resolve_cwd(cwd)[0]
    if name:
        return name
    return folder.split("-")[-1] if folder else "unknown"


def owner_root(cwd):
    """The project folder a worktree cwd belongs to, as a path in cwd's own spelling, or None when cwd is
    not a worktree (or is a temp scratchpad, whose project can't be spelled back from the slug)."""
    owner = resolve_cwd(cwd)[1]
    if not owner:
        return None
    segs = list(re.finditer(r"[^\\/]+", cwd))
    return cwd[:segs[len(owner) - 1].end()] if len(owner) <= len(segs) else None


def path_parts(cwd):
    return [p for p in re.split(r"[\\/]+", cwd or "") if p]


def percentile(values, q):
    """Nearest-rank percentile (q in 0..100) of a list, or None."""
    v = sorted(values)
    if not v:
        return None
    return v[min(len(v) - 1, max(0, int(round(q / 100.0 * len(v) + 0.5)) - 1))]


def home_dir():
    # WORKFLOW_AUDIT_HOME lets tests run against a throwaway home instead of the real ~/.claude
    return os.environ.get("WORKFLOW_AUDIT_HOME") or os.path.expanduser("~")


def pct(x, total):
    return round(100.0 * x / total, 3) if total else 0.0


_SECRET_PATTERNS = [
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(?:ghp|gho|ghs|github_pat|xox[a-z]|AKIA|AIza)[A-Za-z0-9_-]{12,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|apikey)(\s*[=:]\s*)[^\s\"',;]+"),
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),
]
_LONG_RUN = re.compile(r"[A-Za-z0-9+/=_-]{32,}")


def _long_run(m):
    s = m.group(0)
    return "[redacted]" if re.search(r"\d", s) and re.search(r"[A-Za-z]", s) else s


def redact(text):
    """Replace secret-looking strings with [redacted]."""
    for pat in _SECRET_PATTERNS:
        if pat.groups >= 2:
            text = pat.sub(lambda m: m.group(1) + m.group(2) + "[redacted]", text)
        else:
            text = pat.sub("[redacted]", text)
    return _LONG_RUN.sub(_long_run, text)
