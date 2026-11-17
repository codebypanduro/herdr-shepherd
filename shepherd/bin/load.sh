#!/bin/sh
# This machine's load, in percent of what it has: "cpu 34 mem 61".
# Used by `shep room` (may a ticket start?) and the board's status bar (hc exec --on <machine>).
if [ "$(uname)" = Darwin ]; then
  n=$(sysctl -n hw.ncpu)
  cpu=$(ps -A -o %cpu= | awk -v n="$n" '{ s += $1 } END { printf "%d", s / n }')
  mem=$(vm_stat | awk -v total="$(sysctl -n hw.memsize)" '
    /page size of/ { ps = $8 }
    /^Pages active/ { a = $3 } /^Pages wired down/ { w = $4 } /occupied by compressor/ { c = $5 }
    END { printf "%d", (a + w + c) * ps * 100 / total }')
else
  read -r _ u1 n1 s1 i1 w1 x1 y1 z1 _ < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 w2 x2 y2 z2 _ < /proc/stat
  busy=$(( (u2 + n2 + s2 + x2 + y2 + z2) - (u1 + n1 + s1 + x1 + y1 + z1) ))
  idle=$(( (i2 + w2) - (i1 + w1) ))
  cpu=$(( busy * 100 / (busy + idle + 1) ))
  mem=$(awk '/^MemTotal/ { t = $2 } /^MemAvailable/ { a = $2 } END { printf "%d", (t - a) * 100 / t }' /proc/meminfo)
fi
echo "cpu $cpu mem $mem"
