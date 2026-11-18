#!/usr/bin/env bash
# Shepherd's terminal program (start.sh starts it): run.sh <dir>. Runs Claude from <dir>/launch.sh,
# labels the terminal shepherd.up=1 while Claude runs and shepherd.up=0 when it doesn't, and keeps
# the terminal while Claude is down, so nothing typed or sent to Shepherd's address meanwhile runs as
# a command: input is read and thrown away. Restart Shepherd (start.sh --restart) writes a fresh
# launch.sh and <dir>/restart, then stops Claude: this loop starts the new one at once. When Claude
# ends by itself (/exit, a crash) it says so and waits for a restart; the terminal, and with it every
# sub-agent Shepherd started, stays.
DIR=$1
exec 3>&2 2>/dev/null # this script's own notes (bash's "Killed: 9" for a stopped Claude) go nowhere; Claude's stderr is fd 3
set -m 2>/dev/null # Claude runs as a foreground job in its own process group, so a restart stops it alone
trap ':' INT QUIT TSTP # ctrl-c while Claude is down must not end the terminal (a handler, not ignore: Claude gets defaults)
up() { hc label "$HC_TERMINAL_ID" "shepherd.up=$1" >/dev/null 2>&1 || :; }
while :; do
  rm -f "$DIR/restart"
  up 1
  bash "$DIR/launch.sh" 2>&3
  up 0
  while read -r -t 1 _; do :; done # what was sent while Claude went down
  [ -e "$DIR/restart" ] && continue
  printf '\n\342\234\273 Shepherd stopped. Restart Shepherd (the palette, Space settings, or this terminal'"'"'s header) starts it again. Typing here does nothing.\n'
  until [ -e "$DIR/restart" ]; do read -r -t 1 _ || :; done
done
