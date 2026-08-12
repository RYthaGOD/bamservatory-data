#!/usr/bin/env bash
# What flatten.awk does with an incomplete capture.
#
# The guard this exercises decides whether a capture becomes part of the
# published series, so getting it wrong is expensive in both directions: admit a
# partial response and the site publishes a network that never existed, withhold
# a real one and the series stops tracking BAM. It had been checked once, by
# hand, against data that happened to be lying around. That is not a standing
# guarantee, and the property it protects is not the kind that should rest on
# someone remembering to re-check it.
#
# Both fixtures are the cases that actually matter, and they pull in opposite
# directions:
#
#   partial-real.jsonl   Real captures from 2026-07-29, when the API served a
#                        coherent but incomplete view. Must be withheld.
#   sustained-drop.jsonl A network that genuinely halves and stays halved. Must
#                        be recorded, after a bounded delay.
#
# A guard that passes only the first is a guard that can freeze the series.
#
#   ./test/flatten-guard.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLATTEN="$ROOT/pipeline/flatten.awk"
FIX="$ROOT/test/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# gawk, not mawk: flatten.awk uses three-argument match(), which only gawk has.
# Under mawk the third argument is silently ignored and every field comes out
# empty, so this needs to fail loudly rather than test nothing.
AWK=$(command -v gawk || command -v awk)
if ! echo | "$AWK" '{ if (match("a1", /a([0-9])/, m) && m[1] == "1") ok = 1 } END { exit !ok }' 2>/dev/null; then
  echo "FAIL: need gawk (three-argument match is not available in this awk)"
  exit 1
fi

fails=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected %s, got %s\n' "$1" "$3" "$2"
    fails=$((fails + 1))
  fi
}

# Replay a fixture one capture at a time, exactly as tick-once.sh does: read the
# previous counts from the summary written so far, then flatten the next record.
replay() {
  local fixture="$1" name="$2" streak="$3"
  local sum="$WORK/$name.summary.csv"
  echo "ts,bam_stake,bam_stake_percentage,node_count,validator_count,connected_validators,unconnected_validators,total_node_stake,total_validator_stake,top_node,top_node_share,node_stake_hhi" > "$sum"
  : > "$WORK/$name.partial.log"
  rm -f "$WORK/$name.streak"

  while IFS= read -r rec; do
    [ -z "$rec" ] && continue
    local prev pn pv
    prev=$(tail -n1 "$sum")
    pn=$(printf '%s' "$prev" | cut -d, -f4)
    pv=$(printf '%s' "$prev" | cut -d, -f5)
    [[ "$pn" =~ ^[0-9]+$ ]] || pn=0
    [[ "$pv" =~ ^[0-9]+$ ]] || pv=0
    local args=(-v SUMMARY="$sum" -v NODES="$WORK/$name.nodes.csv" -v VALS="$WORK/$name.vals.csv"
                -v PREV_NODES="$pn" -v PREV_VALS="$pv" -v SKIPLOG="$WORK/$name.partial.log")
    [ "$streak" = "stateful" ] && args+=(-v STREAK_FILE="$WORK/$name.streak")
    printf '%s\n' "$rec" | "$AWK" -f "$FLATTEN" "${args[@]}"
  done < "$fixture"
}

rows()   { awk -F, 'NR>1' "$WORK/$1.summary.csv" | grep -c . || true; }
has_ts() { awk -F, -v t="$2" 'NR>1 && $1==t {f=1} END{exit !f}' "$WORK/$1.summary.csv" && echo yes || echo no; }
withheld() { grep -c "partial response withheld" "$WORK/$1.partial.log" 2>/dev/null || true; }

echo "── a real partial response is withheld ──"
replay "$FIX/partial-real.jsonl" real stateful
check "the two degraded captures are kept out of the series" "$(rows real)" "3"
check "19:12 (10 nodes, 235 validators) is not in the series"  "$(has_ts real 2026-07-29T19:12:06Z)" "no"
check "19:16 (14 nodes, 297 validators) is not in the series"  "$(has_ts real 2026-07-29T19:16:08Z)" "no"
check "the healthy capture before it is kept"                  "$(has_ts real 2026-07-29T19:08:45Z)" "yes"
check "the recovery capture is kept"                           "$(has_ts real 2026-07-29T19:18:46Z)" "yes"
check "both withholdings are logged"                           "$(withheld real)" "2"

echo "── a genuine sustained drop is delayed, never suppressed ──"
replay "$FIX/sustained-drop.jsonl" drop stateful
check "the series continues at the new size"    "$(rows drop)" "4"
check "the third reduced capture is recorded"   "$(has_ts drop 2026-09-01T00:03:00Z)" "yes"
check "and every one after it"                  "$(has_ts drop 2026-09-01T00:05:00Z)" "yes"
check "exactly two captures were withheld"      "$(withheld drop)" "2"
check "the release is logged, not silent"       "$(grep -c 'persisted past' "$WORK/drop.partial.log" || true)" "1"

# A record written twice with no newline between them is still one line. Nothing
# below parses JSON, so the segment boundaries run through both copies and the
# counts come out summed — raw/2026/06/29 holds exactly one such line, and it
# yielded a row claiming 771 validators against 380 either side.
echo "── two records on one line are not one capture ──"
replay "$FIX/doubled-line.jsonl" doubled stateful
check "the malformed line is not flattened"     "$(rows doubled)" "2"
check "no row appears for its timestamp"        "$(has_ts doubled 2026-06-29T04:04:58Z)" "no"
check "the valid captures either side survive"  "$(has_ts doubled 2026-06-29T04:03:58Z)$(has_ts doubled 2026-06-29T04:05:54Z)" "yesyes"
check "it is logged as malformed, not as partial" \
  "$(grep -c 'malformed capture withheld' "$WORK/doubled.partial.log" || true)" "1"

# Without somewhere to count withholdings the release can never fire, so the
# guard must not run at all — otherwise re-flattening the archive by hand would
# silently drop every record of a real reduction.
echo "── with no state file the guard stands down ──"
replay "$FIX/sustained-drop.jsonl" rebuild stateless
check "every capture is flattened during a rebuild" "$(rows rebuild)" "6"
check "nothing is withheld"                         "$(withheld rebuild)" "0"

echo
if [ "$fails" -eq 0 ]; then
  echo "flatten guard: all checks passed"
  exit 0
fi
echo "flatten guard: $fails check(s) FAILED"
exit 1
