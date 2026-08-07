#!/usr/bin/env bash
# Keep the two tail-read files bounded.
#
# The live pipeline reads far less than it stores:
#
#   summary.csv     read in full     — the series. Never trimmed.
#   nodes.csv       read in full     — region rollups. Never trimmed.
#   detections.log  read in full     — event history. Never trimmed.
#   validators.csv  latest row only  — 1.5 GB on the Windows box, tail-read
#   ticks.jsonl     last 2 records   — 2.3 GB, scanned to find its own end
#
# So the two largest files are scanned in full every minute to reach their last
# few lines. Trimming them is not just housekeeping: on a network-backed volume
# it is the difference between a tick that reads ~50 MB and one that reads ~4 GB.
#
# Nothing is trimmed until it is archived. ticks.jsonl is the raw capture and the
# provenance record; validators.csv is derived from it by flatten.awk and can be
# rebuilt, so it is trimmed on a retention window alone.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
LOG="$DIR/ticks.jsonl"
VALS="$DIR/validators.csv"
WATERMARK="$DIR/.archived_through"

# Rewriting a multi-hundred-MB file is expensive, so only do it when there is
# real slack to reclaim. Below these thresholds the scan cost is already small.
TICKS_TRIM_ABOVE_MB="${TICKS_TRIM_ABOVE_MB:-256}"
VALS_TRIM_ABOVE_MB="${VALS_TRIM_ABOVE_MB:-256}"

# Retention in the *live* files. History lives in the archive, not here.
RETAIN_TICKS="${RETAIN_TICKS:-4320}"      # ~3 days at one capture per minute
RETAIN_VAL_DAYS="${RETAIN_VAL_DAYS:-3}"

size_mb() { [ -f "$1" ] && echo $(( $(stat -c%s "$1") / 1048576 )) || echo 0; }

# ── ticks.jsonl ──────────────────────────────────────────────────────────────
# Only trim past the archive watermark. Without an archived day behind us,
# trimming would destroy the only copy of a capture window.
if [ "$(size_mb "$LOG")" -gt "$TICKS_TRIM_ABOVE_MB" ] && [ -s "$WATERMARK" ]; then
  keep="$LOG.keep.$$"
  if tail -n "$RETAIN_TICKS" "$LOG" > "$keep" 2>/dev/null && [ -s "$keep" ]; then
    # Rename is atomic within the volume, so a crash mid-rotation leaves either
    # the old log or the new one — never a truncated file the collector would
    # then append a valid record onto.
    mv "$keep" "$LOG"
    echo "$(date -u +%FT%TZ) rotated ticks.jsonl → last $RETAIN_TICKS records (archived through $(cat "$WATERMARK"))" >> "$DIR/ticks.log"
  else
    rm -f "$keep"
  fi
fi

# ── validators.csv ───────────────────────────────────────────────────────────
# Derived, so retention is time-based and needs no watermark. Keep the header:
# stats.js tail-reads for the latest snapshot but the column order comes from it.
if [ "$(size_mb "$VALS")" -gt "$VALS_TRIM_ABOVE_MB" ]; then
  cutoff=$(date -u -d "$RETAIN_VAL_DAYS days ago" +%FT%TZ 2>/dev/null) || cutoff=""
  if [ -n "$cutoff" ]; then
    keep="$VALS.keep.$$"
    {
      head -n1 "$VALS"
      awk -F, -v c="$cutoff" 'NR>1 && $1 >= c' "$VALS"
    } > "$keep" 2>/dev/null
    # Guard against a cutoff that matched nothing (clock skew, format drift):
    # a validators.csv containing only a header would publish an empty topology.
    if [ "$(wc -l < "$keep")" -gt 1 ]; then
      mv "$keep" "$VALS"
      echo "$(date -u +%FT%TZ) rotated validators.csv → rows since $cutoff" >> "$DIR/ticks.log"
    else
      rm -f "$keep"
      echo "$(date -u +%FT%TZ) validators.csv rotation SKIPPED — cutoff $cutoff matched no rows" >> "$DIR/ticks.log"
    fi
  fi
fi
