#!/usr/bin/env bash
# Node-set-change event detector — live, per-capture.
# Called from tick-once.sh after each successful flatten.
#
# Compares the most-recent capture's node set to the previous one and emits
# structured events to detections.log:
#
#   SIGNAL        — new node appeared in same region as current top node
#                   ("handoff_likely": strong predictor of an imminent cutover)
#   SIGNAL_XREGION — new node in a different region ("expansion_possible")
#   CUTOVER       — top node changed; scored with lead time from first SIGNAL
#
# Region is the city prefix of the node name: fra-mainnet-bam-1-tee → fra.
# All nodes named {city}-mainnet-bam-{N}-tee follow this scheme.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
NODES="$DIR/nodes.csv"
SUMMARY="$DIR/summary.csv"
DETLOG="$DIR/detections.log"

# Need header + at least 2 data rows
[ "$(wc -l < "$SUMMARY")" -lt 3 ] && exit 0

ts_cur=$(tail -n1  "$SUMMARY" | cut -d, -f1)
ts_prev=$(tail -n2 "$SUMMARY" | head -n1 | cut -d, -f1)
top_cur=$(tail -n1  "$SUMMARY" | cut -d, -f10)
top_prev=$(tail -n2 "$SUMMARY" | head -n1 | cut -d, -f10)

# Guard: header leaked in or same-timestamp duplicate
[[ "$ts_cur"  == "ts" || "$ts_prev" == "ts" || "$ts_cur" == "$ts_prev" ]] && exit 0

# City prefix: fra-mainnet-bam-1-tee → fra
region_of() { printf '%s' "$1" | cut -d- -f1; }
top_cur_region=$(region_of "$top_cur")

# Sorted node name sets for the two most-recent captures.
#
# Read from a tail buffer rather than the whole file. nodes.csv gains one row
# per node per capture — roughly 1.9 MB a day, unbounded — and this runs every
# 60 seconds, so scanning all of it would grow into the tick budget and
# eventually start costing captures. That is exactly how the original Windows
# collector decayed to a third of its intended rate, and it was invisible until
# the coverage figures were plotted.
#
# 4000 lines is ~260 captures at the current node count: far more than the two
# this needs, and cheap to re-read every minute.
NODES_TAIL=$(tail -n 4000 "$NODES")
nodes_cur=$(printf '%s\n' "$NODES_TAIL" | awk -F, -v t="$ts_cur"  '$1==t{print $2}' | sort)
nodes_prev=$(printf '%s\n' "$NODES_TAIL" | awk -F, -v t="$ts_prev" '$1==t{print $2}' | sort)

new_nodes=$(comm -13 \
  <(printf '%s\n' "$nodes_prev") \
  <(printf '%s\n' "$nodes_cur"))

# ── SIGNAL ────────────────────────────────────────────────────────────────────
while IFS= read -r nn; do
  [ -z "$nn" ] && continue
  nn_region=$(region_of "$nn")
  if [ "$nn_region" = "$top_cur_region" ]; then
    printf '%s SIGNAL region=%s new_node=%s top=%s prediction=handoff_likely\n' \
      "$ts_cur" "$nn_region" "$nn" "$top_cur" >> "$DETLOG"
  else
    printf '%s SIGNAL_XREGION region=%s new_node=%s top=%s prediction=expansion_possible\n' \
      "$ts_cur" "$nn_region" "$nn" "$top_cur" >> "$DETLOG"
  fi
done <<< "$new_nodes"

# ── CUTOVER ───────────────────────────────────────────────────────────────────
if [ "$top_cur" != "$top_prev" ] && [[ "$top_prev" != "top_node" && -n "$top_prev" ]]; then
  new_region=$(region_of "$top_cur")
  # A structural rollover is preceded by a FRESH same-region node appearing, so
  # match the MOST RECENT same-region SIGNAL (tail, not head) and accept it only
  # if it lands within LEAD_WINDOW minutes. Whale-driven stake flips create no new
  # node, so their nearest signal is stale and gets rejected → first_signal=none.
  # (The old head/unbounded match paired flips with week-old signals, yielding
  # lead_min in the thousands.) Trailing space excludes SIGNAL_XREGION.
  LEAD_WINDOW=60
  cand=$(grep " SIGNAL region=${new_region} " "$DETLOG" 2>/dev/null | tail -1 | cut -d' ' -f1)
  first_signal=none
  lead_min=0
  if [ -n "$cand" ]; then
    lm=$(awk -v t1="$cand" -v t2="$ts_cur" 'BEGIN{
      split(t1, a, /[-T:Z]/); split(t2, b, /[-T:Z]/)
      e1 = a[2]*30*86400 + a[3]*86400 + a[4]*3600 + a[5]*60 + a[6]+0
      e2 = b[2]*30*86400 + b[3]*86400 + b[4]*3600 + b[5]*60 + b[6]+0
      print int((e2 - e1) / 60)
    }')
    if [ "${lm:-999}" -ge 0 ] && [ "${lm:-999}" -le "$LEAD_WINDOW" ]; then
      first_signal="$cand"
      lead_min="$lm"
    fi
  fi
  printf '%s CUTOVER old=%s new=%s region=%s first_signal=%s lead_min=%d\n' \
    "$ts_cur" "$top_prev" "$top_cur" "$new_region" "$first_signal" "$lead_min" >> "$DETLOG"
fi
