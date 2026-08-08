#!/usr/bin/env bash
# One BAM capture → raw log + flattened datasets + structural-tick log.
#
# Ported from the Windows Task Scheduler version. Two things changed:
#
#   • No single-instance lock. The supervisor calls this serially in one
#     process, so the lock it used to need (and the stale-lock reclaim that
#     went with it) only existed to defend against Task Scheduler overlap.
#   • Paths come from the environment instead of d:/bam-net-ticks.
#
# Everything else is deliberately identical: the flatten, the churn comparison
# and the tick threshold all feed a series that has been running since
# 2026-06-20, and changing how a row is derived mid-series would put a seam in
# the published history.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
LOG="$DIR/ticks.jsonl"
SUMMARY="$DIR/summary.csv"
NODES="$DIR/nodes.csv"
VALS="$DIR/validators.csv"
TICKS="$DIR/ticks.log"
FLATTEN=/app/pipeline/flatten.awk
BIN=bam-net

# Headers if a dataset file is missing (first run / manual delete).
[ -f "$SUMMARY" ] || echo "ts,bam_stake,bam_stake_percentage,node_count,validator_count,connected_validators,unconnected_validators,total_node_stake,total_validator_stake,top_node,top_node_share,node_stake_hhi" > "$SUMMARY"
[ -f "$NODES" ]   || echo "ts,bam_node,region,connected_validators,node_stake,node_stake_share" > "$NODES"
[ -f "$VALS" ]    || echo "ts,validator_pubkey,bam_node_connection,stake,stake_percentage" > "$VALS"

# Capture (appends one raw record to the log).
if ! "$BIN" snapshot --cache "$LOG" --no-color >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) capture FAILED" >> "$TICKS"
  exit 0
fi

# Flatten just the new record into the live datasets.
tail -n1 "$LOG" | awk -f "$FLATTEN" -v SUMMARY="$SUMMARY" -v NODES="$NODES" -v VALS="$VALS"

# Structural-tick check, derived from files (no persistent state).
ts=$(tail -n1 "$SUMMARY" | cut -d, -f1)
cn=$(tail -n1 "$SUMMARY" | cut -d, -f4)
cv=$(tail -n1 "$SUMMARY" | cut -d, -f5)
prev=$(tail -n2 "$SUMMARY" | head -1)
pn=$(echo "$prev" | cut -d, -f4)
pv=$(echo "$prev" | cut -d, -f5)

ch=$("$BIN" churn --cache "$LOG" --json --no-color 2>/dev/null)
struct=0
echo "$ch" | grep -qE '"(moved|joined|left)":\[[^]]' && struct=1

# Only compare once a real previous data row exists (pn numeric).
if [[ "$pn" =~ ^[0-9]+$ ]] && { [ "$cn" != "$pn" ] || [ "$cv" != "$pv" ] || [ "$struct" -eq 1 ]; }; then
  {
    echo "=== TICK @ $ts ===  nodes:$pn->$cn validators:$pv->$cv"
    echo "$ch"
    echo
  } >> "$TICKS"
fi

# Node-set event detector: signals imminent cutovers, scores predictions.
bash /app/pipeline/detect.sh

# Keep the tail-read files from growing without bound. Cheap when there is
# nothing to do, so it runs every tick rather than on its own schedule.
bash /app/pipeline/rotate.sh

# Publish on a throttle, detached, so a slow push never delays the next capture.
# The marker is touched up-front: a failed publish then waits out the window
# instead of retrying every minute against a service that is already unhappy.
PUB="$DIR/.last_publish"
PUBLISH_MINUTES="${PUBLISH_MINUTES:-15}"
if [ ! -f "$PUB" ] || find "$PUB" -maxdepth 0 -mmin "+$PUBLISH_MINUTES" 2>/dev/null | grep -q .; then
  touch "$PUB"
  # tee rather than redirect: the file is the detailed record, but publish
  # failures need to reach the container's own log stream too. Sending them only
  # to a file on the volume is how a push that had been failing for hours stayed
  # invisible while every other signal looked healthy.
  nohup bash /app/pipeline/publish.sh 2>&1 | tee -a "$DIR/publish.log" &
fi
