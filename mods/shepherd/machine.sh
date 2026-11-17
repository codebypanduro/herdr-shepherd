#!/bin/sh
# One machine at a glance, for the Spaces sidebar: the mod reads this file and runs its text with
# `sh -c` on each machine (exec … {on: machine}), so nothing has to be installed there.
# Prints key=value lines: cpu, mem, disk (percent), and with "full" as $1 also kind and model.
# CPU and memory are counted as in shepherd/bin/load.sh (Shepherd's `shep room`): keep them alike.
if [ "$(uname)" = Darwin ]; then
  n=$(sysctl -n hw.ncpu)
  cpu=$(ps -A -o %cpu= | awk -v n="$n" '{ s += $1 } END { printf "%d", s / n }')
  mem=$(vm_stat | awk -v total="$(sysctl -n hw.memsize)" '
    /page size of/ { ps = $8 }
    /^Pages active/ { a = $3 } /^Pages wired down/ { w = $4 } /occupied by compressor/ { c = $5 }
    END { printf "%d", (a + w + c) * ps * 100 / total }')
  disk=$(df -P /System/Volumes/Data 2>/dev/null || df -P /)
else
  read -r _ u1 n1 s1 i1 w1 x1 y1 z1 _ < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 w2 x2 y2 z2 _ < /proc/stat
  busy=$(( (u2 + n2 + s2 + x2 + y2 + z2) - (u1 + n1 + s1 + x1 + y1 + z1) ))
  idle=$(( (i2 + w2) - (i1 + w1) ))
  cpu=$(( busy * 100 / (busy + idle + 1) ))
  mem=$(awk '/^MemTotal/ { t = $2 } /^MemAvailable/ { a = $2 } END { printf "%d", (t - a) * 100 / t }' /proc/meminfo)
  disk=$(df -P /)
fi
echo "cpu=$cpu"
echo "mem=$mem"
echo "disk=$(echo "$disk" | awk 'NR == 2 { sub("%", "", $5); print $5 }')"
[ "${1:-}" = full ] || exit 0
if [ "$(uname)" = Darwin ]; then
  model=$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Model Name/ { print $2; exit }')
  [ -n "$model" ] || model=$(sysctl -n hw.model)
  case "$model" in
    *MacBook*) kind=laptop ;;
    *"Mac mini"*|*Macmini*) kind=mini ;;
    *) if pmset -g batt 2>/dev/null | grep -q InternalBattery; then kind=laptop; else kind=tower; fi ;;
  esac
else
  model=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
  [ -n "$model" ] || model=Linux
  if ls /sys/class/power_supply/BAT* >/dev/null 2>&1; then kind=laptop
  elif [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && ! ls /usr/share/xsessions/* >/dev/null 2>&1; then kind=server
  else kind=tower; fi
fi
echo "kind=$kind"
echo "model=$model"
