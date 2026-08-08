#!/usr/bin/env bash
# Publish completed UTC days of raw capture into the public archive.
#
# This is the file that answers "how do we know the numbers are real?".
#
# Everything the dashboard shows is derived: metrics.json comes from the CSVs,
# and the CSVs come from flatten.awk over ticks.jsonl. Only ticks.jsonl is a
# primary record — what the public BAM API returned, as captured, unmodified.
# So the archive stores the raw log, day by day, and commits a SHA-256 for each
# day into an append-only manifest.
#
# What that establishes, precisely:
#
#   • Any published figure can be recomputed from published inputs. Nothing in
#     the chart depends on a file only the operator holds.
#   • A day's contents cannot be revised after the fact without changing its
#     hash, and the manifest is append-only in a public commit history, so a
#     revision is visible to anyone who recorded the old hash.
#
# What it does NOT establish, and the methodology must say so: that the BAM API
# told the truth. This is a faithful recording of a public endpoint, not an
# attestation from BAM. Until BAM attestations are publicly queryable there is
# no cryptographic link from this archive to what the network actually did.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
ARCHIVE="${REPO_DIR:-/data/repos}/archive"
LOG="$DIR/ticks.jsonl"
CAPTURED_FROM="$DIR/.captured_from"

# A second collector in another region writes its own record rather than merging
# into the first one's. Two vantages that agree are evidence; two vantages
# blended into a single file are just an assertion, because a disagreement would
# already have been averaged away by the time anyone looked.
VANTAGE="${VANTAGE:-primary}"
if [ "$VANTAGE" = "primary" ]; then
  RAW_REL="raw"
  MANIFEST_REL="MANIFEST.tsv"
else
  RAW_REL="vantage/$VANTAGE/raw"
  MANIFEST_REL="vantage/$VANTAGE/MANIFEST.tsv"
fi
MANIFEST="$ARCHIVE/$MANIFEST_REL"

[ -d "$ARCHIVE/.git" ] || { echo "archive repo not cloned — skipping"; exit 0; }
[ -s "$LOG" ] || exit 0

today=$(date -u +%F)
mkdir -p "$ARCHIVE/$RAW_REL" "$(dirname "$MANIFEST")"
[ -f "$MANIFEST" ] || printf 'sha256\tpath\trecords\tfirst_ts\tlast_ts\tarchived_at\tcollector\n' > "$MANIFEST"

# Every distinct UTC day present in the log, except today's — a day still being
# captured would be archived incomplete and its hash would change tomorrow,
# which is exactly the property the manifest exists to rule out.
#
# ts is always the first field, so the date is a fixed-offset prefix: a record
# opens `{"ts":"2026-06-20T...` and the date begins at column 8. Matching on that
# rather than parsing JSON keeps this linear and cheap on a large log. The regex
# is a guard, not a parser — if the record shape ever changes, no day matches and
# archiving stops rather than writing mislabelled files.
days=$(cut -c8-17 "$LOG" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -u | grep -v "^$today$")

if [ -z "$days" ]; then
  # Having nothing to archive is normal — on the first day, or between the last
  # archived day and midnight. Having nothing *parseable* is not: it means the
  # record shape moved and this script would go on exiting 0 forever while the
  # archive quietly stopped advancing. Fail loudly instead of silently.
  if [ -s "$LOG" ] && ! cut -c8-17 "$LOG" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    echo "$(date -u +%FT%TZ) archive ERROR: no parseable date prefix in $LOG." >&2
    echo "$(date -u +%FT%TZ) archive ERROR: capture record format has changed — archiving is STALLED." >&2
    exit 1
  fi
  exit 0
fi

# Days at or before this were not captured by this node — they came in with the
# seed, which carries only enough raw records for churn to have something to
# compare against. Archiving them would publish a manifest entry claiming a
# couple of records' coverage for a day that was captured in full elsewhere.
captured_from=$(cat "$CAPTURED_FROM" 2>/dev/null | tr -d ' \t\r\n')

archived_any=0
for day in $days; do
  y=${day:0:4}; m=${day:5:2}; d=${day:8:2}
  rel="$RAW_REL/$y/$m/$d.jsonl.zst"
  out="$ARCHIVE/$rel"

  if [ -n "$captured_from" ] && ! [ "$day" \> "$captured_from" ]; then
    continue
  fi

  # Already published: re-archiving would either be a no-op or a silent revision
  # of a day someone may already have verified. Skip and leave the manifest be.
  #
  # This check runs against a clone publish.sh has just reset to origin, so it
  # reflects what is actually published rather than what this node once wrote.
  # That is deliberate: if a push failed, the file is legitimately absent here
  # and the day *should* be rebuilt and retried. An earlier version consulted a
  # local watermark instead, which made a single failed push drop the day
  # forever — the archive silently losing exactly what it exists to preserve.
  if [ -f "$out" ]; then
    continue
  fi

  mkdir -p "$(dirname "$out")"
  tmp="$out.tmp.$$"
  if ! grep "^{\"ts\":\"$day" "$LOG" | zstd -19 -q -o "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "$(date -u +%FT%TZ) archive FAILED for $day" >&2
    continue
  fi

  records=$(zstd -dc "$tmp" | wc -l)
  if [ "$records" -eq 0 ]; then
    rm -f "$tmp"
    continue
  fi
  first_ts=$(zstd -dc "$tmp" | head -n1 | cut -c8-27)
  last_ts=$(zstd -dc "$tmp" | tail -n1 | cut -c8-27)
  mv "$tmp" "$out"

  sha=$(sha256sum "$out" | cut -d' ' -f1)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$sha" "$rel" "$records" "$first_ts" "$last_ts" \
    "$(date -u +%FT%TZ)" "$(cat /app/BAM_NET_REF 2>/dev/null || echo unknown)" >> "$MANIFEST"

  echo "$(date -u +%FT%TZ) archived $day → $rel ($records records, sha ${sha:0:12})"
  archived_any=1
done

# Deliberately does not advance .archived_through. Writing a day to disk here
# says nothing about whether it reached GitHub, and rotate.sh trims the capture
# log on the strength of that marker. Only publish.sh, which knows whether the
# push succeeded, is entitled to move it.
exit 0
