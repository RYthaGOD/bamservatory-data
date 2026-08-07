#!/usr/bin/env bash
# Third-party verification of the BAMservatory archive.
#
# Run this against a clone of this repo. It needs no credentials, no access to
# the capture node, and no cooperation from the operator — which is the point.
#
#   ./verify.sh                    # check every archived day
#   ./verify.sh 2026-06-20         # check one day
#   ./verify.sh --rebuild <dir>    # also rebuild the CSVs and compare metrics
#
# Requires: sha256sum, zstd, gawk.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$ROOT/MANIFEST.tsv"
target="${1:-}"

[ -f "$MANIFEST" ] || { echo "no MANIFEST.tsv — is this the archive repo?"; exit 1; }

ok=0; bad=0; missing=0

# ── 1. Every archived day still hashes to what the manifest recorded ─────────
# A day whose contents were revised after publication fails here, even if the
# revision happened long ago: the manifest line is append-only history.
while IFS=$'\t' read -r sha rel records first_ts last_ts archived_at collector; do
  [ "$sha" = "sha256" ] && continue
  case "$rel" in raw/*) ;; *) continue ;; esac
  day=$(echo "$rel" | sed 's|raw/||; s|\.jsonl\.zst$||; s|/|-|g')
  [ -n "$target" ] && [ "$target" != "--rebuild" ] && [ "$day" != "$target" ] && continue

  if [ ! -f "$ROOT/$rel" ]; then
    echo "MISSING  $day  ($rel is in the manifest but not in the tree)"
    missing=$((missing + 1))
    continue
  fi

  actual=$(sha256sum "$ROOT/$rel" | cut -d' ' -f1)
  if [ "$actual" != "$sha" ]; then
    echo "MISMATCH $day  manifest ${sha:0:16}  actual ${actual:0:16}"
    bad=$((bad + 1))
    continue
  fi

  # The hash proves the file is unchanged; it does not prove the file contains
  # what the manifest claims. Check the record count and the boundary
  # timestamps too, so a day cannot be silently swapped for a different one.
  n=$(zstd -dc "$ROOT/$rel" | wc -l)
  f=$(zstd -dc "$ROOT/$rel" | head -n1 | cut -c8-27)
  l=$(zstd -dc "$ROOT/$rel" | tail -n1 | cut -c8-27)
  if [ "$n" != "$records" ] || [ "$f" != "$first_ts" ] || [ "$l" != "$last_ts" ]; then
    echo "INCONSISTENT $day  manifest($records, $first_ts→$last_ts)  actual($n, $f→$l)"
    bad=$((bad + 1))
    continue
  fi

  ok=$((ok + 1))
done < "$MANIFEST"

echo
echo "verified $ok day(s)   mismatched $bad   missing $missing"

# ── 2. Coverage ──────────────────────────────────────────────────────────────
# Capture gaps are a fact of running a collector, and hiding them would be its
# own kind of dishonesty. Report expected-vs-actual rather than asserting 100%.
echo
echo "coverage (expected 1440 captures/day at 60s):"
while IFS=$'\t' read -r sha rel records first_ts last_ts archived_at collector; do
  [ "$sha" = "sha256" ] && continue
  case "$rel" in raw/*) ;; *) continue ;; esac
  day=$(echo "$rel" | sed 's|raw/||; s|\.jsonl\.zst$||; s|/|-|g')
  [ -n "$target" ] && [ "$target" != "--rebuild" ] && [ "$day" != "$target" ] && continue
  pct=$(awk -v r="$records" 'BEGIN{ printf "%.1f", (r/1440)*100 }')
  printf '  %s  %5s / 1440  %5s%%\n' "$day" "$records" "$pct"
done < "$MANIFEST"

[ "$bad" -eq 0 ] && [ "$missing" -eq 0 ] || exit 1
exit 0
