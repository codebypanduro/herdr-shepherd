#!/bin/sh
# Starts this space's Shepherd: start.sh [--restart] [--space <id>] [repo dir]
# Run it from a terminal in the space (its herdr.space label is used), or pass --space.
# Shepherd gets its own tab, keeps running when this shell ends, and is labelled
# herdr.role=shepherd and shepherd.dir=<repo> so the mods can find it.
# --restart: a running Shepherd is replaced in place by a fresh one (the current PROMPT.md and
# workflow) in the same terminal, so its address, tab and sub-agents stay (see restart below).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SPACE=""
RESTART=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restart) RESTART=1; shift ;;
    --space) SPACE=$2; shift 2 ;;
    *) break ;;
  esac
done
REPO=$(cd "${1:-.}" && git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ -z "$SPACE" ]; then
  [ -n "${HC_TERMINAL_ID:-}" ] || { echo "start.sh: not in a Herdr terminal; pass --space <id>" >&2; exit 1; }
  SPACE=$(hc get "$HC_TERMINAL_ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).labels?.["herdr.space"]??""))')
  [ -n "$SPACE" ] || { echo "start.sh: this terminal has no herdr.space label; pass --space <id>" >&2; exit 1; }
fi

# hc ls --json carries no labels: filter on them instead.
EXISTING=$(hc ls --json --label herdr.role=shepherd --label herdr.space="$SPACE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const t=(Array.isArray(a)?a:a.terminals??[]).find(x=>x.state==="live");process.stdout.write(t?t.address:"")})')
if [ -n "$EXISTING" ] && [ -z "$RESTART" ]; then echo "Shepherd already runs in this space: $EXISTING"; exit 0; fi

CONFIG="$HERE/workflow.json"; [ -f "$CONFIG" ] || CONFIG="$HERE/workflow.example.json"
MODEL=$(node -e 'process.stdout.write(require(process.argv[1]).shepherd?.model??"opus")' "$CONFIG")
FILE="$REPO/.herdr/shepherd/tasks.json"
# Shepherd's files stay out of git without touching the repo's .gitignore.
EXCLUDE="$(git -C "$REPO" rev-parse --git-path info/exclude 2>/dev/null || true)"
if [ -n "$EXCLUDE" ]; then
  case "$EXCLUDE" in /*) ;; *) EXCLUDE="$REPO/$EXCLUDE" ;; esac
  mkdir -p "$(dirname "$EXCLUDE")"
  grep -qx '.herdr/' "$EXCLUDE" 2>/dev/null || echo '.herdr/' >> "$EXCLUDE"
fi
node "$HERE/bin/shep.mjs" --tasks "$FILE" init "$SPACE" >/dev/null

# hc's server starts the terminal with its own PATH, which on another machine often lacks
# ~/.local/bin, nvm and the like: give Shepherd this shell's PATH and claude's full path.
CLAUDE=$(command -v claude || true)
[ -n "$CLAUDE" ] || { echo "start.sh: claude isn't on PATH here ($PATH)" >&2; exit 1; }
# Codex is optional: stages set to a Codex model run it by this path. Without Codex here the agent's
# terminal exits at once (hc run itself succeeds); Shepherd sees that when it checks the agent started
# and asks the person (PROMPT, Codex agents).
CODEX=$(command -v codex || echo codex)

PROMPT=$(mktemp "${TMPDIR:-/tmp}/shepherd-prompt.XXXXXX")
sed -e "s#{{SHEP}}#node $HERE/bin/shep.mjs#g" -e "s#{{WORKFLOW}}#$CONFIG#g" -e "s#{{REPO}}#$REPO#g" -e "s#{{SPACE}}#$SPACE#g" -e "s#{{CODEX}}#$CODEX#g" \
  "$HERE/PROMPT.md" > "$PROMPT"

FIRST="You are Shepherd for $REPO. Read $CONFIG, run: node $HERE/bin/shep.mjs ls, then wait for the person."
if [ -n "$EXISTING" ]; then
  FIRST="You are Shepherd for $REPO, restarted: the Shepherd before you ran in this same terminal and was stopped, so its running work is yours now. Read $CONFIG, run: node $HERE/bin/shep.mjs ls, then follow 'Restarted' in your instructions."
fi

if [ -z "$EXISTING" ]; then
OUT=$(hc run --json --bg --keep --outlive-parent --no-parent --name "shepherd-$(echo "$SPACE" | tr -cd 'a-z0-9' | cut -c1-20)" \
  --cwd "$REPO" \
  --label herdr.space="$SPACE" --label herdr.tab="shepherd-$SPACE" \
  --label herdr.role=shepherd --label shepherd.dir="$REPO" --label shepherd.workflow="$CONFIG" \
  -- env PATH="$PATH" SHEP_FILE="$FILE" SHEP_WORKFLOW="$CONFIG" "$CLAUDE" --model "$MODEL" --disallowedTools AskUserQuestion --allowedTools "Bash(node $HERE/bin/shep.mjs trust:*)" --append-system-prompt-file "$PROMPT" \
  "$FIRST")
ADDR=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).address??"")}catch{}})')
# A Shepherd that dies at once (a bad PATH, a missing flag) would otherwise leave every panel on
# "Starting…": look again after a few seconds and fail with its last line.
sleep 4
STATE=$(hc get "$ADDR" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s);process.stdout.write(t.state==="live"?"live":`exit ${t.exit_code}`)}catch{process.stdout.write("gone")}})')
if [ "$STATE" != "live" ]; then
  echo "start.sh: Shepherd ($ADDR) stopped at once ($STATE): $(hc read "$ADDR" --lines 5 2>/dev/null | grep -v '^\s*$' | tail -1)" >&2
  exit 1
fi
echo "Shepherd started: $ADDR"
exit 0
fi

# ---- restart in place ----------------------------------------------------------------------
# Shepherd's sub-agents are hc children of its terminal: `hc kill` on it (or closing its pane) ends
# them all, hc can't give a running terminal another parent, and a new terminal would have another
# address than the one their briefs report to. But Shepherd's terminal is kept (--keep): when its
# program dies by a signal, the core gives the same terminal a shell (same address, labels, tab and
# children; probes in .herdr/slices/slice-10l.md). So: stop the old Claude with SIGKILL (a normal
# exit would end the terminal, and its children with it), wait for that shell, and start the fresh
# Claude in it. Everything Claude needs is in a launcher file, so the typed line is short. The
# launcher doesn't exec over the shell: if the new Claude fails, the shell stays and so do the agents.
ADDR=$EXISTING
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
LAUNCH="$PROMPT.sh"
printf 'exec env PATH=%s SHEP_FILE=%s SHEP_WORKFLOW=%s %s --model %s --disallowedTools AskUserQuestion --allowedTools %s --append-system-prompt-file %s %s\n' \
  "$(q "$PATH")" "$(q "$FILE")" "$(q "$CONFIG")" "$(q "$CLAUDE")" "$(q "$MODEL")" "$(q "Bash(node $HERE/bin/shep.mjs trust:*)")" "$(q "$PROMPT")" "$(q "$FIRST")" > "$LAUNCH"
hc label "$ADDR" shepherd.dir="$REPO" shepherd.workflow="$CONFIG" >/dev/null

# What runs in it: "<state> <keep> <root pid> <pid to stop, or -> <foreground is a shell: 1|0>".
# Claude is the terminal's root program after start.sh, or the shell's foreground job after a restart.
look() {
  hc get "$ADDR" --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let t; try { t=JSON.parse(s) } catch { process.stdout.write("gone 0 0 - 0"); return; }
  const isClaude = (argv) => (argv ?? []).some((a) => /(^|\/)claude$/.test(String(a)) || /(^|\/)\.?claude\/.*versions\//.test(String(a)));
  const fg = t.foreground ?? {};
  const shell = /^-?(zsh|bash|sh|fish|dash|ksh|nu)$/.test(String(fg.name ?? "")) && !isClaude(fg.argv);
  const app = t.status?.app === "claude-code" && !shell;
  const stop = isClaude(fg.argv) || app ? fg.pid ?? t.pid : isClaude(t.argv) ? t.pid : null;
  process.stdout.write(`${t.state} ${t.keep ? 1 : 0} ${t.pid ?? 0} ${stop ?? "-"} ${shell ? 1 : 0}`);
})'
}
set -- $(look)
[ "$1" = "live" ] || { echo "start.sh: Shepherd ($ADDR) isn't live ($1)" >&2; exit 1; }
[ "$2" = "1" ] || hc keep "$ADDR" >/dev/null
STOP=$4
if [ "$STOP" != "-" ]; then
  # Its process group too (its tool commands: an `hc wait`, a shep call); sub-agents aren't in it,
  # the core holds them.
  kill -9 -- "-$STOP" 2>/dev/null || kill -9 "$STOP"
  # The shell: the core's recovery (a second or two) when Claude was the root, else the shell's prompt.
  i=0
  while :; do
    set -- $(look)
    [ "$1" = "live" ] || { echo "start.sh: Shepherd's terminal $ADDR ended ($1) when Claude was stopped" >&2; exit 1; }
    [ "$4" = "-" ] && [ "$5" = "1" ] && break
    i=$((i + 1)); [ $i -lt 60 ] || { echo "start.sh: $ADDR has no shell 30 s after Claude was stopped" >&2; exit 1; }
    sleep 0.5
  done
elif [ "$5" != "1" ]; then
  echo "start.sh: $ADDR runs neither Claude nor a shell; restart it by hand" >&2; exit 1
fi
hc send "$ADDR" "sh $(q "$LAUNCH")" >/dev/null
# Up when Claude is its foreground program a few seconds on (as a start's check above).
i=0
while :; do
  set -- $(look)
  [ "$4" != "-" ] && break
  i=$((i + 1)); [ $i -lt 40 ] || { echo "start.sh: Claude didn't start in $ADDR: $(hc read "$ADDR" --lines 5 2>/dev/null | grep -v '^\s*$' | tail -1)" >&2; exit 1; }
  sleep 0.5
done
sleep 4
set -- $(look)
if [ "$4" = "-" ]; then
  echo "start.sh: the new Shepherd in $ADDR stopped at once: $(hc read "$ADDR" --lines 5 2>/dev/null | grep -v '^\s*$' | tail -1)" >&2
  exit 1
fi
echo "Shepherd restarted: $ADDR"
