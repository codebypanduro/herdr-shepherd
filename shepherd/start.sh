#!/bin/sh
# Starts this space's Shepherd: start.sh [--space <id>] [repo dir]
# Run it from a terminal in the space (its herdr.space label is used), or pass --space.
# Shepherd gets its own tab, keeps running when this shell ends, and is labelled
# herdr.role=shepherd and shepherd.dir=<repo> so the mods can find it.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SPACE=""
if [ "${1:-}" = "--space" ]; then SPACE=$2; shift 2; fi
REPO=$(cd "${1:-.}" && git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ -z "$SPACE" ]; then
  [ -n "${HC_TERMINAL_ID:-}" ] || { echo "start.sh: not in a Herdr terminal; pass --space <id>" >&2; exit 1; }
  SPACE=$(hc get "$HC_TERMINAL_ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).labels?.["herdr.space"]??""))')
  [ -n "$SPACE" ] || { echo "start.sh: this terminal has no herdr.space label; pass --space <id>" >&2; exit 1; }
fi

EXISTING=$(hc ls --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const t=(Array.isArray(a)?a:a.terminals??[]).find(x=>x.state==="live"&&x.labels?.["herdr.role"]==="shepherd"&&x.labels?.["herdr.space"]===process.argv[1]);process.stdout.write(t?t.address:"")})' "$SPACE")
if [ -n "$EXISTING" ]; then echo "Shepherd already runs in this space: $EXISTING"; exit 0; fi

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

PROMPT=$(mktemp -t shepherd-prompt)
sed -e "s#{{SHEP}}#node $HERE/bin/shep.mjs#g" -e "s#{{WORKFLOW}}#$CONFIG#g" -e "s#{{REPO}}#$REPO#g" -e "s#{{SPACE}}#$SPACE#g" \
  "$HERE/PROMPT.md" > "$PROMPT"

hc run --bg --keep --outlive-parent --no-parent --name "shepherd-$(echo "$SPACE" | tr -cd 'a-z0-9' | cut -c1-20)" \
  --cwd "$REPO" \
  --label herdr.space="$SPACE" --label herdr.tab="shepherd-$SPACE" \
  --label herdr.role=shepherd --label shepherd.dir="$REPO" --label shepherd.workflow="$CONFIG" \
  -- env SHEP_FILE="$FILE" SHEP_WORKFLOW="$CONFIG" claude --model "$MODEL" --append-system-prompt-file "$PROMPT" \
  "You are Shepherd for $REPO. Read $CONFIG, run: node $HERE/bin/shep.mjs ls, then wait for the person."
