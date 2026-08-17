#!/bin/bash
# Generic active watchdog for a long ffmpeg (or similar) background job.
# Polls every INTERVAL seconds and exits with a clear verdict so the caller is
# NOTIFIED on success / failure / STALL — never silently waits forever.
#
#   bash watchdog.sh <output_file> <log_file> <encoder_grep_pattern> [interval] [max_seconds]
#
# SUCCESS: process gone AND output is a valid media file (ffprobe duration).
# FAILURE: process gone but output invalid/missing.
# STALL:   process alive but ffmpeg "time=" not advancing for >stall_limit.
# TIMEOUT: exceeded max_seconds.
#
# Portability: uses `pgrep -f PATTERN | grep -c .` (NOT `pgrep -fc`, which is
# GNU-only and errors on macOS/BSD pgrep — that exact bug silently stalled a
# finisher once). Keep macOS-safe.
set -u
OUT="${1:?output file}"; LOG="${2:?log file}"; PAT="${3:?process grep pattern}"
INTERVAL="${4:-20}"; MAX="${5:-1800}"
alive() { pgrep -f "$PAT" >/dev/null 2>&1; }   # BSD-safe presence check
last=""; stall=0; waited=0
while true; do
  if ! alive; then
    if dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null) && [ -n "$dur" ]; then
      echo "SUCCESS dur=${dur}s size=$(ls -la "$OUT" 2>/dev/null | awk '{print $5}')"; exit 0
    fi
    echo "FAILURE: process gone without valid output ($OUT)"; tail -6 "$LOG" 2>/dev/null; exit 1
  fi
  now=$(tail -c 200 "$LOG" 2>/dev/null | tr '\r' '\n' | grep -o 'time=[0-9:.]*' | tail -1)
  if [ -n "$now" ] && [ "$now" = "$last" ]; then stall=$((stall+INTERVAL)); else stall=0; fi
  last="$now"
  if [ "$stall" -ge 120 ]; then echo "STALL: stuck at $now for ${stall}s"; tail -6 "$LOG" 2>/dev/null; exit 2; fi
  waited=$((waited+INTERVAL))
  [ "$waited" -ge "$MAX" ] && { echo "TIMEOUT after ${MAX}s (last=$now)"; exit 3; }
  sleep "$INTERVAL"
done
