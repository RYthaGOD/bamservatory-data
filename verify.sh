#!/usr/bin/env bash
# Third-party verification of the BAMservatory archive.
#
# Run this against a clone of this repo. It needs no credentials, no access to
# the capture nodes, and no cooperation from the operator — which is the point.
#
#   ./verify.sh                # check every archived day, every vantage
#   ./verify.sh 2026-06-20     # check one day across all vantages
#
# Checks three things per day: that the file still hashes to what the manifest
# recorded, that its contents match the recorded record count and boundary
# timestamps, and what capture coverage it actually achieved.
#
# Every vantage is checked, not just the primary. An earlier version read only
# the root manifest and skipped anything outside raw/, so the two witness
# archives went unverified while this script — and the CI badge built on it —
# reported success. A verification tool that silently covers a third of the
# thing it claims to verify is worse than none, because the green result is
# taken at face value.
#
# Requires: sha256sum, zstd, awk.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
target="${1:-}"

# Say plainly which tool is missing.
#
# Without this, an absent zstd reports every day as INCONSISTENT with a record
# count of zero — which reads as "the archive is corrupt" rather than "you do not
# have zstd installed". The first impression of a verification tool should never
# be a false accusation against the thing it is verifying.
for t in sha256sum zstd awk; do
  command -v "$t" >/dev/null 2>&1 || {
    echo "verify.sh needs '$t' and it is not on PATH."
    echo "  Debian/Ubuntu: sudo apt-get install -y coreutils zstd gawk"
    echo "  macOS:         brew install coreutils zstd gawk"
    exit 2
  }
done

# Root manifest covers the primary; one per witness under vantage/.
#
# An array, not a space-separated string. Joined into one string these paths word
# -split on the first space in the repo's location — a clone under "BAM BAM PM"
# broke every path, verified nothing, and still exited 0.
MANIFESTS=("$ROOT/MANIFEST.tsv")
for m in "$ROOT"/vantage/*/MANIFEST.tsv; do
  [ -f "$m" ] && MANIFESTS+=("$m")
done
# The verification evidence is archived the same way and gets the same integrity
# check. Its cadence is different — one record per verification run, not one per
# minute — so the capture-coverage sections below skip it rather than measure it
# against a rate it was never meant to hit.
[ -f "$ROOT/verification/MANIFEST.tsv" ] && MANIFESTS+=("$ROOT/verification/MANIFEST.tsv")

[ -f "$ROOT/MANIFEST.tsv" ] || { echo "no MANIFEST.tsv — is this the archive repo?"; exit 1; }

total_ok=0; total_bad=0; total_missing=0

for MANIFEST in "${MANIFESTS[@]}"; do
  label=$(dirname "${MANIFEST#$ROOT/}")
  [ "$label" = "." ] && label="primary"

  ok=0; bad=0; missing=0
  echo
  echo "── $label ──"

  # ── 1. Every archived day still hashes to what the manifest recorded ───────
  # A day whose contents were revised after publication fails here, even if the
  # revision happened long ago: the manifest line is append-only history.
  while IFS=$'\t' read -r sha rel records first_ts last_ts archived_at collector; do
    [ "$sha" = "sha256" ] && continue
    [ -z "${rel:-}" ] && continue
    day=$(basename "$rel" .jsonl.zst)
    dir=$(dirname "$rel")
    day="$(basename "$(dirname "$dir")")-$(basename "$dir")-$day"
    [ -n "$target" ] && [ "$day" != "$target" ] && continue

    if [ ! -f "$ROOT/$rel" ]; then
      echo "  MISSING  $day  ($rel is in the manifest but not in the tree)"
      missing=$((missing + 1))
      continue
    fi

    actual=$(sha256sum "$ROOT/$rel" | cut -d' ' -f1)
    if [ "$actual" != "$sha" ]; then
      echo "  MISMATCH $day  manifest ${sha:0:16}  actual ${actual:0:16}"
      bad=$((bad + 1))
      continue
    fi

    # The hash proves the file is unchanged; it does not prove the file contains
    # what the manifest claims. Check the record count and the boundary
    # timestamps too, so a day cannot be silently swapped for a different one.
    # One decompression, not three, and no `head` on the stream.
    #
    # This read the file three times and piped one of them into `head -n1`, which
    # closes the pipe after the first line. zstd then dies on SIGPIPE and prints
    # "error 70 : Write error : cannot write block : Broken pipe" to stderr —
    # once per archived day, so a clean run of the verification tool ended with
    # sixty-odd errors in it and a summary saying everything was fine.
    #
    # The values were never wrong, which is what made it worth fixing rather than
    # leaving: a reader cannot tell a harmless SIGPIPE from a real decompression
    # failure, and this script exists to be run by people with no reason to trust
    # it yet. It says so itself thirty lines up.
    #
    # Tracking the last line explicitly rather than reading $0 in END, because
    # that is only defined behaviour in some awks and this runs under whichever
    # one the checker happens to have.
    counts=$(zstd -dc "$ROOT/$rel" \
      | awk 'NR==1 { f = substr($0,8,20) } { l = substr($0,8,20) } END { print NR, f, l }')
    n=${counts%% *}
    l=${counts##* }
    f=${counts#* }; f=${f%% *}
    if [ "$n" != "$records" ] || [ "$f" != "$first_ts" ] || [ "$l" != "$last_ts" ]; then
      echo "  INCONSISTENT $day  manifest($records, $first_ts→$last_ts)  actual($n, $f→$l)"
      bad=$((bad + 1))
      continue
    fi

    ok=$((ok + 1))
  done < "$MANIFEST"

  echo "  verified $ok day(s)   mismatched $bad   missing $missing"

  # ── 2. Coverage ───────────────────────────────────────────────────────────
  # Capture gaps are a fact of running a collector, and hiding them would be its
  # own kind of dishonesty. Report expected-vs-actual rather than asserting 100%.
  if [ "$ok" -gt 0 ] && [ "$label" != "verification" ]; then
    echo "  coverage (expected 1440 captures/day at 60s):"
    while IFS=$'\t' read -r sha rel records first_ts last_ts archived_at collector; do
      [ "$sha" = "sha256" ] && continue
      [ -z "${rel:-}" ] && continue
      day=$(basename "$rel" .jsonl.zst)
      dir=$(dirname "$rel")
      day="$(basename "$(dirname "$dir")")-$(basename "$dir")-$day"
      [ -n "$target" ] && [ "$day" != "$target" ] && continue
      [ -f "$ROOT/$rel" ] || continue
      pct=$(awk -v r="$records" 'BEGIN{ printf "%.1f", (r/1440)*100 }')
      printf '    %s  %5s / 1440  %5s%%\n' "$day" "$records" "$pct"
    done < "$MANIFEST"
  fi

  # ── 3. Continuity ─────────────────────────────────────────────────────────
  # Everything above walks the manifest, so it can only judge days that were
  # recorded. A day that was never archived at all leaves no entry to check and
  # would pass silently — and that is exactly the shape a rotation fault takes,
  # since rotation is the only thing that deletes raw captures. Absence has to be
  # checked against the calendar, not against the manifest.
  #
  # A gap is not automatically a fault: a collector that was genuinely down for a
  # day should show one. It is reported so a reader can tell the difference,
  # rather than assumed either way.
  if [ -z "$target" ] && [ "$ok" -gt 0 ] && [ "$label" != "verification" ]; then
    days=$(awk -F'\t' 'NR>1 && $2!="" {
      n=split($2, p, "/"); if (n<4) next
      print p[n-2]"-"p[n-1]"-"substr(p[n],1,2)
    }' "$MANIFEST" | sort)
    first=$(echo "$days" | head -n1); last=$(echo "$days" | tail -n1)
    gaps=0
    if [ -n "$first" ] && [ -n "$last" ]; then
      cur="$first"
      while [ "$cur" != "$last" ]; do
        echo "$days" | grep -qx "$cur" || { echo "  GAP      $cur  (no archive for this day)"; gaps=$((gaps + 1)); }
        cur=$(date -u -d "$cur + 1 day" +%F 2>/dev/null) || break
      done
    fi
    echo "  span $first → $last, $gaps day(s) with no archive"
  fi

  total_ok=$((total_ok + ok))
  total_bad=$((total_bad + bad))
  total_missing=$((total_missing + missing))
done

echo
echo "── total ──"
echo "  verified $total_ok day(s)   mismatched $total_bad   missing $total_missing"

# Verifying nothing is a failure, not a pass.
#
# Zero mismatches out of zero days satisfies every check below while
# establishing nothing at all, and it exits green — which is precisely the
# outcome this script exists to make impossible. It has already happened: word
# -split manifest paths produced "verified 0 day(s)  mismatched 0  missing 0"
# and an exit code of 0.
if [ "$total_ok" -eq 0 ]; then
  echo
  echo "  FAILED: no day was verified. The archive was not checked, so this run"
  echo "  proves nothing — treat it as a failure, not a pass."
  exit 1
fi

[ "$total_bad" -eq 0 ] && [ "$total_missing" -eq 0 ] || exit 1
exit 0
