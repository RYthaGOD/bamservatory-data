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
#   collapse-persistent.jsonl
#                        The shape of 2026-10-21: 16 nodes and 375 validators,
#                        then one dev node with one validator for eight captures,
#                        then recovery. Synthetic records, real counts. Must be
#                        withheld for as long as it lasts, never released on
#                        persistence alone.
#   collapse-empty.jsonl Healthy captures, an empty response as the API served
#                        from 02:17Z that day, then a collapsed one.
#
# A guard that passes only the first is a guard that can freeze the series. One
# that passes only the second is the guard that published BAM at 0.12%.
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
# An optional fourth argument names a capture timestamp: the accept file is
# created just before that capture is flattened, as an operator would.
replay() {
  local fixture="$1" name="$2" streak="$3" accept_at="${4:-}"
  local sum="$WORK/$name.summary.csv"
  echo "ts,bam_stake,bam_stake_percentage,node_count,validator_count,connected_validators,unconnected_validators,total_node_stake,total_validator_stake,top_node,top_node_share,node_stake_hhi" > "$sum"
  : > "$WORK/$name.partial.log"
  rm -f "$WORK/$name.streak" "$WORK/$name.accept"

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
    [ "$streak" = "stateful" ] && args+=(-v STREAK_FILE="$WORK/$name.streak" -v ACCEPT_FILE="$WORK/$name.accept")
    [ -n "$accept_at" ] && [[ "$rec" == *"\"ts\":\"$accept_at\""* ]] && touch "$WORK/$name.accept"
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

# Persistence is what separates a failed read from a real change — until the
# read stays failed. 2026-10-21 held the API at one node for longer than any
# bounded release, so the third capture of it went into the series as observed.
echo "── a collapse is held for as long as it lasts ──"
replay "$FIX/collapse-persistent.jsonl" collapse stateful
check "only the healthy captures and the recovery are in the series" "$(rows collapse)" "3"
check "the third collapsed capture is not released"  "$(has_ts collapse 2026-10-21T01:22:38Z)" "no"
check "nor the last"                                 "$(has_ts collapse 2026-10-21T01:27:38Z)" "no"
check "the recovery is kept"                         "$(has_ts collapse 2026-10-21T01:28:38Z)" "yes"
check "every collapsed capture is logged as withheld" "$(withheld collapse)" "8"
check "and none as persisted"                        "$(grep -c 'persisted past' "$WORK/collapse.partial.log" || true)" "0"

# A collapse can be real, and then a person says so. Acceptance answers the
# collapse in front of it: the capture it lands on is recorded, the file is gone,
# and the smaller network is the baseline from then on.
echo "── an operator can accept a collapse, once ──"
replay "$FIX/collapse-persistent.jsonl" accepted stateful 2026-10-21T01:23:38Z
check "the captures before acceptance stay withheld" "$(has_ts accepted 2026-10-21T01:22:38Z)" "no"
check "the accepted capture is recorded"             "$(has_ts accepted 2026-10-21T01:23:38Z)" "yes"
check "and the rest of the run after it"             "$(has_ts accepted 2026-10-21T01:27:38Z)" "yes"
check "the acceptance is logged"                     "$(grep -c 'collapse accepted by operator' "$WORK/accepted.partial.log" || true)" "1"
check "the accept file is consumed"                  "$([ -e "$WORK/accepted.accept" ] && echo present || echo gone)" "gone"

# An accept file left lying around must not wave through the next incident.
echo "── an acceptance with nothing to accept is discarded ──"
replay "$FIX/collapse-persistent.jsonl" stale stateful 2026-10-21T01:19:38Z
check "it is removed on a healthy capture"           "$(grep -c 'discarded unused' "$WORK/stale.partial.log" || true)" "1"
check "and the collapse after it is still withheld"  "$(withheld stale)" "8"
check "so none of it reaches the series"             "$(rows stale)" "3"

# The API spent hours on 2026-10-21 returning nothing between collapsed
# responses. An acceptance made then must be spent on the empty capture it lands
# on, not carried to whatever sub-quarter response turns up next.
echo "── an acceptance that lands on an empty capture is discarded ──"
replay "$FIX/collapse-empty.jsonl" empty stateful 2026-10-21T02:17:09Z
check "it is logged as discarded"                    "$(grep -c 'discarded unused — capture had no nodes' "$WORK/empty.partial.log" || true)" "1"
check "the file is gone"                             "$([ -e "$WORK/empty.accept" ] && echo present || echo gone)" "gone"
check "and the collapse after it is still withheld"  "$(has_ts empty 2026-10-21T02:18:38Z)" "no"
check "so it is not recorded as accepted"            "$(grep -c 'collapse accepted by operator' "$WORK/empty.partial.log" || true)" "0"

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
replay "$FIX/collapse-persistent.jsonl" rebuild-collapse stateless
check "a collapse is flattened during a rebuild too" "$(rows rebuild-collapse)" "11"

echo
if [ "$fails" -eq 0 ]; then
  echo "flatten guard: all checks passed"
  exit 0
fi
echo "flatten guard: $fails check(s) FAILED"
exit 1
