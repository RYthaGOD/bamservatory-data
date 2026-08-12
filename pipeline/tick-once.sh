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
#
# The previous capture's counts go in so flatten.awk can recognise a partial API
# response — a coherent but incomplete view — and withhold it from the series
# rather than record it as a smaller network. Read before flattening, since the
# new row is about to become the last line.
prev_row=$(tail -n1 "$SUMMARY")
prev_nodes=$(printf '%s' "$prev_row" | cut -d, -f4)
prev_vals=$(printf '%s' "$prev_row" | cut -d, -f5)
[[ "$prev_nodes" =~ ^[0-9]+$ ]] || prev_nodes=0     # header row, or first capture
[[ "$prev_vals"  =~ ^[0-9]+$ ]] || prev_vals=0

tail -n1 "$LOG" | awk -f "$FLATTEN" \
  -v SUMMARY="$SUMMARY" -v NODES="$NODES" -v VALS="$VALS" \
  -v PREV_NODES="$prev_nodes" -v PREV_VALS="$prev_vals" \
  -v STREAK_FILE="$DIR/.partial_streak" -v SKIPLOG="$DIR/partial.log"

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

# Cross-source verification, on its own slower clock.
#
# Separate from capture because it is a different kind of measurement and a much
# heavier one: it pulls the full Solana vote-account set and Jito's whole
# validator table, so running it every minute would be rude to three services to
# restate a figure that moves on the order of hours. It is also strictly
# optional — capture is the irreplaceable part, and a verification run that
# fails, times out or is unconfigured must never cost a snapshot.
#
# Primary only. A witness exists to corroborate the capture, and duplicating this
# from three vantages would triple the load on other people's APIs to compute the
# same answer from the same public data.
# Aligned with the publish cycle rather than half as often. At 30 minutes a
# published page could carry a verification reading half an hour older than its
# headline, and the two panels would disagree on validator counts with nothing
# on the page explaining why. Matching the publish interval keeps the worst-case
# gap to roughly one cycle, and the panel states its own read time regardless.
VERIFY_MINUTES="${VERIFY_MINUTES:-15}"
if [ "${VANTAGE:-primary}" = "primary" ] && [ -n "${SOLANA_RPC_URL:-}" ]; then
  VER="$DIR/.last_verify"
  if [ ! -f "$VER" ] || find "$VER" -maxdepth 0 -mmin "+$VERIFY_MINUTES" 2>/dev/null | grep -q .; then
    touch "$VER"
    # --evidence records the inputs each row was computed from, so the row can be
    # recomputed by someone who does not trust it (see recompute.mjs). It is the
    # bulk of what this pipeline publishes: roughly 250 KB archived per day
    # against the raw capture's 35 KB. Set VERIFY_EVIDENCE= to disable, or raise
    # VERIFY_MINUTES to record fewer, at the cost of rows nobody can re-check.
    node /app/pipeline/verify-sources.mjs --out "$DIR/verification.csv" \
      --evidence "${VERIFY_EVIDENCE-$DIR/verification-evidence.jsonl}" \
      >> "$DIR/verify.log" 2>&1 \
      || echo "$(date -u +%FT%TZ) verification run failed (capture unaffected)" >> "$DIR/verify.log"
  fi
fi

# Has BAM published attestations yet? Checked daily, primary only.
#
# This is the project's largest stated limit, and both READMEs carry it with a
# hand-written date. A date maintained by memory drifts in the worst direction:
# it would go on saying no endpoint exists long after one appeared. Daily is
# frequent enough that the claim on the page is never more than a day old, and
# rare enough to be eight requests against someone else's API.
ATTEST_MINUTES="${ATTEST_MINUTES:-1440}"
if [ "${VANTAGE:-primary}" = "primary" ]; then
  ATT="$DIR/.last_attest"
  if [ ! -f "$ATT" ] || find "$ATT" -maxdepth 0 -mmin "+$ATTEST_MINUTES" 2>/dev/null | grep -q .; then
    touch "$ATT"
    node /app/pipeline/probe-attestations.mjs --out "$DIR/attestations.json" \
      >> "$DIR/verify.log" 2>&1 \
      || echo "$(date -u +%FT%TZ) attestation probe failed (capture unaffected)" >> "$DIR/verify.log"
  fi
fi

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
