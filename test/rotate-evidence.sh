#!/usr/bin/env bash
# What rotate.sh is allowed to delete.
#
# This is the second piece of code in the system that destroys records with no
# other copy, and it has already got it wrong twice. Evidence for 2026-08-15 and
# 2026-08-21 is gone because the rule was a high-water mark: a day that failed to
# archive while later ones succeeded fell behind the mark and was trimmed anyway,
# each on the very run that archived the day after it. One missed run, one day
# lost, silently, with nothing checking.
#
# The rule is now membership in a set of days confirmed durable by a push. These
# assertions pull in opposite directions, and both matter:
#
#   an archived day    must be trimmed, or the volume fills
#   an unarchived day  must survive, however old, or the archive gets a hole
#
# The gap case is the one that was broken. It is first.
#
#   ./test/rotate-evidence.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROTATE="$ROOT/pipeline/rotate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n          expected %s, got %s\n' "$1" "$3" "$2"
    fails=$((fails + 1))
  fi
}

# A capture dir holding evidence for four days. ticks.jsonl and validators.csv
# stay tiny so their size-gated branches never run: this exercises the evidence
# rule alone.
setup() {
  DIR="$WORK/run.$$.$RANDOM"
  mkdir -p "$DIR"
  : > "$DIR/ticks.jsonl"
  : > "$DIR/validators.csv"
  for day in 15 21 22 23; do
    printf '{"ts":"2026-08-%sT01:00:00Z","sources":{}}\n' "$day" >> "$DIR/verification-evidence.jsonl"
    printf '{"ts":"2026-08-%sT02:00:00Z","sources":{}}\n' "$day" >> "$DIR/verification-evidence.jsonl"
  done
}

days_left() { cut -c8-17 "$DIR/verification-evidence.jsonl" | sort -u | tr '\n' ' ' | sed 's/ $//'; }

# ── the gap ─────────────────────────────────────────────────────────────────
# 22 is durably archived; 15 and 21 never were. Under the old high-water rule
# both would go, because 22 is newer than either.
echo "── an unarchived day survives, even when newer days are archived ──"
setup
printf '2026-08-22\n' > "$DIR/.evidence_days"
CAPTURE_DIR="$DIR" bash "$ROTATE" >/dev/null 2>&1
check "the gap days and today are kept, the archived day is dropped" \
  "$(days_left)" "2026-08-15 2026-08-21 2026-08-23"

# ── the ordinary case ───────────────────────────────────────────────────────
echo "── archived days are trimmed ──"
setup
printf '2026-08-15\n2026-08-21\n2026-08-22\n' > "$DIR/.evidence_days"
CAPTURE_DIR="$DIR" bash "$ROTATE" >/dev/null 2>&1
check "only the unarchived day remains" "$(days_left)" "2026-08-23"

# ── refusing to act without confirmation ────────────────────────────────────
# publish.sh writes .evidence_days only after a push it watched succeed. Absent
# or empty, nothing here is known to be durable and nothing may be deleted.
echo "── no confirmed list, no deletion ──"
setup
rm -f "$DIR/.evidence_days"
CAPTURE_DIR="$DIR" bash "$ROTATE" >/dev/null 2>&1
check "a missing list trims nothing" "$(days_left)" "2026-08-15 2026-08-21 2026-08-22 2026-08-23"

setup
: > "$DIR/.evidence_days"
CAPTURE_DIR="$DIR" bash "$ROTATE" >/dev/null 2>&1
check "an empty list trims nothing" "$(days_left)" "2026-08-15 2026-08-21 2026-08-22 2026-08-23"

# ── the raw capture log is not touched by any of this ───────────────────────
# Different watermark, different file, and the one whose loss is unrecoverable.
echo "── raw captures are left alone ──"
setup
printf '2026-08-22\n' > "$DIR/.evidence_days"
printf '{"ts":"2026-08-01T00:00:00Z"}\n{"ts":"2026-08-02T00:00:00Z"}\n' > "$DIR/ticks.jsonl"
printf '2026-08-22\n' > "$DIR/.archived_through"
CAPTURE_DIR="$DIR" bash "$ROTATE" >/dev/null 2>&1
check "ticks.jsonl is untouched below the size threshold" \
  "$(wc -l < "$DIR/ticks.jsonl" | tr -d ' ')" "2"

if [ "$fails" -eq 0 ]; then
  echo
  echo "rotate evidence: all checks passed"
  exit 0
fi
echo
echo "rotate evidence: $fails check(s) FAILED"
exit 1
