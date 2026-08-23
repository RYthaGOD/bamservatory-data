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
EVIDENCE="$DIR/verification-evidence.jsonl"
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
# Discard only what is already published, and nothing else.
#
# This is the only code in the system that destroys raw records, and they have
# no other copy. An earlier version checked merely that the watermark file
# existed and then kept the last N records regardless of what it said — so if
# publishing stalled for longer than N records' worth of time (an expired token,
# a GitHub outage), rotation would delete days that had never been archived. The
# capture log would keep looking healthy while the history quietly went missing.
#
# Records are kept when their day is *after* the last confirmed-published day.
# A minimum tail is always retained regardless, because churn compares the last
# two captures and flatten reads the last one.
watermark=$(cat "$WATERMARK" 2>/dev/null | tr -d ' \t\r\n')
if [ "$(size_mb "$LOG")" -gt "$TICKS_TRIM_ABOVE_MB" ] && [ -n "$watermark" ]; then
  keep="$LOG.keep.$$"
  # ts is a fixed-offset prefix: `{"ts":"2026-08-09T...` puts the day at col 8.
  awk -v w="$watermark" 'substr($0,8,10) > w' "$LOG" > "$keep" 2>/dev/null

  kept=$(wc -l < "$keep" 2>/dev/null || echo 0)
  if [ "$kept" -lt 2 ]; then
    # Everything is published. Keep a short tail anyway so the next tick has
    # something to compare against, rather than reporting a spurious node-set
    # change on a log that starts empty.
    tail -n "$RETAIN_TICKS" "$LOG" > "$keep" 2>/dev/null
    kept=$(wc -l < "$keep" 2>/dev/null || echo 0)
  fi

  if [ "$kept" -ge 2 ]; then
    # Rename is atomic within the volume, so a crash mid-rotation leaves either
    # the old log or the new one — never a truncated file the collector would
    # then append a valid record onto.
    mv "$keep" "$LOG"
    echo "$(date -u +%FT%TZ) rotated ticks.jsonl → $kept records after $watermark" >> "$DIR/ticks.log"
  else
    rm -f "$keep"
    echo "$(date -u +%FT%TZ) ticks.jsonl rotation SKIPPED — refusing to leave fewer than 2 records" >> "$DIR/ticks.log"
  fi
fi

# ── verification-evidence.jsonl ──────────────────────────────────────────────
# Around 8 MB a day of inputs behind the verification rows, so it needs bounding
# like the others — but it is not derived from anything, so a record trimmed
# before it is archived is gone and the row it explains becomes uncheckable
# forever.
#
# Hence the same rule ticks.jsonl gets: keep whole days strictly after the last
# day confirmed published, and never trim on a bare retention count.
#
# But not the same watermark. .archived_through says raw capture is published
# through that day, and evidence is archived by a different script in the same
# cycle — so a run where archive.sh succeeded and archive-evidence.sh did not
# would advance it and rotation would then delete evidence that was never
# published. That is precisely the fault the two markers on this volume already
# exist to prevent, arriving by a third route.
#
# So the watermark is a SET of days, written by publish.sh only after the push
# that made them durable. Two earlier versions of this were wrong:
#
#   * Reading the manifest in the local clone. That manifest can name a day whose
#     commit never reached the remote, and sync_repo resets the clone at the top
#     of the next cycle — so the evidence was deleted while the archive never
#     received it.
#   * Taking the newest day recorded, as a high-water mark. A day that failed to
#     archive while later ones succeeded fell behind the mark and was trimmed
#     anyway. 2026-08-15 and 2026-08-21 were both lost exactly that way, each on
#     the run that archived the day after it. One missed run, one day gone.
#
# Membership, not a maximum: a record is discarded only if its own day is listed
# as durably archived. A gap is therefore kept, and archive-evidence.sh — which
# publishes every complete day it finds rather than only yesterday's — collects
# it on the next run without anyone intervening.
#
# No list, no trimming. The file appears after the first confirmed push.
EV_DAYS="$DIR/.evidence_days"
if [ -s "$EVIDENCE" ] && [ -s "$EV_DAYS" ]; then
  ev_keep="$EVIDENCE.keep.$$"
  # ts is a fixed-offset prefix: `{"ts":"2026-08-09T...` puts the day at col 8.
  awk -v F="$EV_DAYS" '
    BEGIN { while ((getline d < F) > 0) if (d != "") archived[d] = 1 }
    !(substr($0, 8, 10) in archived)
  ' "$EVIDENCE" > "$ev_keep" 2>/dev/null

  ev_kept=$(wc -l < "$ev_keep" 2>/dev/null || echo 0)
  ev_have=$(wc -l < "$EVIDENCE" 2>/dev/null || echo 0)
  if [ "$ev_kept" -lt "$ev_have" ]; then
    mv "$ev_keep" "$EVIDENCE"
    echo "$(date -u +%FT%TZ) rotated verification-evidence.jsonl → $ev_kept records, dropped $((ev_have - ev_kept)) already archived" >> "$DIR/ticks.log"
  else
    rm -f "$ev_keep"
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
