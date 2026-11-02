// The fixtures use Windows paths (`C:/r`). On a POSIX host those are relative, so the engine resolves them against
// the plugin dir before a `fs.*` handler sees them (`/home/x/plugins/worktrees/C:/r/...`). The mocks key their files
// by the path the plugin asked for, so they undo that: drop whatever precedes a drive letter, and use forward slashes.
export function hostPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/(?:[^/]+\/)*?(?=[A-Za-z]:\/)/, '')
}
