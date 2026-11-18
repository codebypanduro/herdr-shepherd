#!/bin/sh
# Starts this space's Shepherd: start.sh [--restart] [--space <id>] [repo dir]
# Run it from a terminal in the space (its herdr.space label is used), or pass --space.
# Shepherd gets its own tab, keeps running when this shell ends, and is labelled
# herdr.role=shepherd and shepherd.dir=<repo> so the mods can find it.
# --restart: a running Shepherd is replaced in place by a fresh one (the current PROMPT.md and
# workflow) in the same terminal, so its address, tab and sub-agents stay (restart_in_place below).
# Shepherd's terminal runs bin/run.sh, which runs Claude from <repo>/.herdr/shepherd/run/<space>/launch.sh.
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

# Everything Claude needs is in a launcher beside the rendered prompt, in the repo's .herdr (git-excluded
# above), one folder per space: bin/run.sh runs it, and runs it again after a restart.
RUN="$REPO/.herdr/shepherd/run/$(printf '%s' "$SPACE" | tr -c 'A-Za-z0-9_.-' '_')"
mkdir -p "$RUN"
sed -e "s#{{SHEP}}#node $HERE/bin/shep.mjs#g" -e "s#{{WORKFLOW}}#$CONFIG#g" -e "s#{{REPO}}#$REPO#g" -e "s#{{SPACE}}#$SPACE#g" -e "s#{{CODEX}}#$CODEX#g" \
  "$HERE/PROMPT.md" > "$RUN/prompt.md.new"
mv "$RUN/prompt.md.new" "$RUN/prompt.md"

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
write_launcher() { # $1: Claude's first message
  printf 'exec env PATH=%s SHEP_FILE=%s SHEP_WORKFLOW=%s %s --model %s --disallowedTools AskUserQuestion --allowedTools %s --append-system-prompt-file %s %s\n' \
    "$(q "$PATH")" "$(q "$FILE")" "$(q "$CONFIG")" "$(q "$CLAUDE")" "$(q "$MODEL")" "$(q "Bash(node $HERE/bin/shep.mjs trust:*)")" "$(q "$RUN/prompt.md")" "$(q "$1")" > "$RUN/launch.sh.new"
  mv "$RUN/launch.sh.new" "$RUN/launch.sh"
}

# What runs in Shepherd's terminal: "<state> <keep> <claude pid or -> <foreground is a shell: 1|0> <shepherd.up label or ->".
# Claude is the foreground job (run.sh), the root program (a Shepherd from before run.sh), or absent.
look() {
  hc get "$1" --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let t; try { t=JSON.parse(s) } catch { process.stdout.write("gone 0 - 0 -"); return; }
  const isClaude = (argv) => (argv ?? []).some((a) => /(^|\/)claude$/.test(String(a)) || /claude\/versions\//.test(String(a)) || /claude-code\/cli\.js$/.test(String(a)));
  const fg = t.foreground ?? {};
  const shell = /^-?(zsh|bash|sh|fish|dash|ksh|nu)$/.test(String(fg.name ?? "")) && !isClaude(fg.argv);
  const pid = isClaude(fg.argv) ? fg.pid : isClaude(t.argv) ? t.pid : null;
  process.stdout.write(`${t.state} ${t.keep ? 1 : 0} ${pid ?? "-"} ${shell ? 1 : 0} ${t.labels?.["shepherd.up"] ?? "-"}`);
})'
}
last_line() { hc read "$1" --lines 5 2>/dev/null | grep -v '^\s*$' | tail -1; }
DEADLINE=$(( $(date +%s) + 75 )) # the mod waits 150 s for this script: give up well before
past_deadline() { [ "$(date +%s)" -ge "$DEADLINE" ]; }

# Stops Claude: SIGKILL (an exit would end a terminal whose root it is, and every sub-agent with it) to
# its process group and every process under it, since Claude runs its tool commands (an `hc wait`, a
# shep call) in groups of their own. Sub-agents aren't among them: the core holds those.
stop_claude() {
  pids=$1; all=$1
  while [ -n "$pids" ]; do
    kids=""
    for p in $pids; do kids="$kids $(pgrep -P "$p" 2>/dev/null | tr '\n' ' ')"; done
    pids=$(echo $kids); all="$all $pids"
  done
  kill -9 -- "-$1" 2>/dev/null || :
  kill -9 $all 2>/dev/null || :
}

# Waits until Claude has run 4 s under run.sh in $1 (shepherd.up=1), else fails with its last line.
wait_up() {
  while :; do
    set -- "$1" $(look "$1")
    [ "$2" = "live" ] || { echo "start.sh: Shepherd's terminal $1 ended ($2)" >&2; exit 1; }
    [ "$4" != "-" ] && [ "$6" = "1" ] && break
    past_deadline && { echo "start.sh: Claude didn't start in $1: $(last_line "$1")" >&2; exit 1; }
    sleep 0.5
  done
  sleep 4
  set -- "$1" $(look "$1")
  [ "$4" != "-" ] || { echo "start.sh: the new Shepherd in $1 stopped at once: $(last_line "$1")" >&2; exit 1; }
}

start_new() {
  write_launcher "You are Shepherd for $REPO. Read $CONFIG, run: node $HERE/bin/shep.mjs ls, then wait for the person."
  OUT=$(hc run --json --bg --keep --outlive-parent --no-parent --name "shepherd-$(echo "$SPACE" | tr -cd 'a-z0-9' | cut -c1-20)" \
    --cwd "$REPO" \
    --label herdr.space="$SPACE" --label herdr.tab="shepherd-$SPACE" \
    --label herdr.role=shepherd --label shepherd.dir="$REPO" --label shepherd.workflow="$CONFIG" \
    -- env PATH="$PATH" bash "$HERE/bin/run.sh" "$RUN")
  ADDR=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).address??"")}catch{}})')
  [ -n "$ADDR" ] || { echo "start.sh: hc run failed: $OUT" >&2; exit 1; }
  # A Shepherd that dies at once (a bad PATH, a missing flag) would otherwise leave every panel on
  # "Starting…": fail with its last line.
  wait_up "$ADDR"
  echo "Shepherd started: $ADDR"
}

# Shepherd's sub-agents are hc children of its terminal: `hc kill` on it (or closing its pane) ends them
# all, and hc can't give a running terminal another parent (probes in .herdr/slices/slice-10l.md). So a
# restart keeps the terminal and replaces only its Claude: run.sh starts the fresh launcher once Claude
# is stopped, and reads and drops whatever reaches the terminal in between. A Shepherd from before
# run.sh (no shepherd.up label) runs Claude as the terminal's root: stopping it gives the kept terminal
# a login shell (same address and children), into which `exec bash run.sh` is typed once.
restart_in_place() {
  ADDR=$1
  write_launcher "You are Shepherd for $REPO, restarted: the Shepherd before you ran in this same terminal and was stopped, so its running work is yours now. Read $CONFIG, run: node $HERE/bin/shep.mjs ls, then follow 'Restarted' in your instructions."
  hc label "$ADDR" shepherd.dir="$REPO" shepherd.workflow="$CONFIG" >/dev/null
  set -- $(look "$ADDR")
  [ "$1" = "live" ] || { echo "start.sh: Shepherd ($ADDR) isn't live ($1)" >&2; exit 1; }
  [ "$2" = "1" ] || hc keep "$ADDR" >/dev/null
  if [ "$5" != "-" ]; then
    : > "$RUN/restart"
    [ "$3" = "-" ] || stop_claude "$3"
  else
    [ "$3" != "-" ] || [ "$4" = "1" ] || { echo "start.sh: $ADDR runs neither Claude nor a shell; restart it by hand" >&2; exit 1; }
    [ "$3" = "-" ] || stop_claude "$3"
    while :; do
      set -- $(look "$ADDR")
      [ "$1" = "live" ] || { echo "start.sh: Shepherd's terminal $ADDR ended ($1) when Claude was stopped" >&2; exit 1; }
      [ "$3" = "-" ] && [ "$4" = "1" ] && break
      past_deadline && { echo "start.sh: $ADDR has no shell after Claude was stopped" >&2; exit 1; }
      sleep 0.3
    done
    hc send "$ADDR" "exec bash $(q "$HERE/bin/run.sh") $(q "$RUN")" >/dev/null
  fi
  wait_up "$ADDR"
  echo "Shepherd restarted: $ADDR"
}

if [ -n "$EXISTING" ]; then restart_in_place "$EXISTING"; else start_new; fi
