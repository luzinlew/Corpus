#!/usr/bin/env python3
"""PreToolUse guard for Bash in Corpus. Protects against accidents, not a sandbox:
denies what an agent never does on its own and asks Lev before anything reaches the live site.

Input: the hook JSON on stdin ({"tool_input": {"command": ...}}). Exit 2 = blocked (reason on stderr);
a JSON "ask" decision on stdout = Lev confirms in the UI; exit 0 with no output = normal permission rules."""
import json, os, re, subprocess, sys

try:
    cmd = str(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    cmd = ""
cmd = " ".join(cmd.split())

DENY = [
    (r"\bgit\s+push\b.*(\s(-f|--force|--force-with-lease|--force-if-includes|--mirror|--delete|-d|--prune)\b|\s\+\S|\s:\S)",
     "force / delete push: only Lev does this"),
    (r"\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s|\.(\s|$))|restore\s+(--worktree\s+)?\.(\s|$)|stash\s+(drop|clear)|branch\s+-D\b)",
     "would discard uncommitted work or an unmerged branch"),
    (r"\bgit\s+(commit|push)\b.*--no-verify", "skips checks"),
    (r"(^|[;&|(]\s*)(npx\s+(--yes\s+)?)?supabase\s", "Supabase CLI: production changes go through Lev"),
    (r"\bpsql\b", "direct database access: through Lev only"),
    (r"iymempapqvbwcaclwnvk", "the production Supabase project: through Lev only"),
    (r"(^|[;&|]\s*)(printenv|env)\s*($|[;&|])", "printing the environment may expose secrets"),
]


def ask(why):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "ask", "permissionDecisionReason": why}}))
    sys.exit(0)


for pat, why in DENY:
    if re.search(pat, cmd):
        print("Blocked by .claude/hooks/guard.py: " + why, file=sys.stderr)
        sys.exit(2)

if re.search(r"\bgit\s+push\b", cmd):
    if re.search(r"\b(main|gh-pages)\b", cmd):
        ask("push to main / gh-pages publishes corpusapp.ee: needs Lev's «деплой»")
    head = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True,
                          cwd=os.environ.get("CLAUDE_PROJECT_DIR") or None).stdout.strip()
    if head in ("main", "gh-pages", "HEAD", ""):
        ask("pushing from " + (head or "an unknown branch") + " may publish corpusapp.ee: needs Lev's «деплой»")
sys.exit(0)
