#!/bin/sh
# "Set up Shepherd on <machine>": clones herdr-shepherd into ~/.herdr-shepherd on the machine it
# runs on (the mod runs this file's text there with exec … {on}). It clones the default branch's tip
# (main), unpinned. Nothing else is changed: no links
# in ~/.config/herdr-app, no settings. shepherdOn (ui.js) looks in ~/.herdr-shepherd last.
#   setup.sh [repo url]   prints ok=<dir>, or no=<reason> (one line)
URL=${1:-https://github.com/codebypanduro/herdr-shepherd}
DEST="$HOME/.herdr-shepherd"
# git may live on the login shell's PATH only (as in shepherdOn's check).
P=$("${SHELL:-sh}" -lc 'printf "__P=%s\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__P=//p' | tail -n 1)
[ -n "$P" ] && PATH="$P:$PATH"
if [ -f "$DEST/shepherd/start.sh" ] && [ -f "$DEST/shepherd/bin/shep.mjs" ]; then echo "ok=$DEST"; exit 0; fi
if [ -e "$DEST" ]; then echo "no=$DEST is there but isn't a herdr-shepherd checkout: move it away and try again"; exit 0; fi
command -v git >/dev/null 2>&1 || { echo "no=git isn't installed there"; exit 0; }
# Clone beside it under a name of its own and move it into place only when whole, so a clone cut
# off (a timeout) or a second setup at the same time never leaves a half checkout at $DEST.
# Never ask for credentials (the repo is public; a prompt would hang with no terminal).
TMP="$DEST.tmp.$$"
out=$(GIT_TERMINAL_PROMPT=0 git clone --quiet "$URL" "$TMP" 2>&1) || { rm -rf "$TMP"; echo "no=git clone failed: $(printf '%s\n' "$out" | tail -n 1)"; exit 0; }
[ -f "$TMP/shepherd/start.sh" ] || { rm -rf "$TMP"; echo "no=the clone has no shepherd/start.sh"; exit 0; }
if ! mv "$TMP" "$DEST" 2>/dev/null || [ -d "$DEST/$(basename "$TMP")" ]; then
  # Another setup put one there first (mv moved ours inside it, or failed): keep theirs.
  rm -rf "$TMP" "$DEST/$(basename "$TMP")"
  [ -f "$DEST/shepherd/start.sh" ] || { echo "no=$DEST appeared while cloning and isn't a herdr-shepherd checkout"; exit 0; }
fi
echo "ok=$DEST"
