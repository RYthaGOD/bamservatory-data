#!/usr/bin/env bash
# Publish completed UTC days of verification evidence.
#
# Deliberately separate from archive.sh rather than a second mode of it. That
# script handles the irreplaceable artifact — raw captures that exist nowhere
# else — and carries seed handling, a captured-from watermark and a
# rebuild-on-failed-push path that this does not need. Evidence is regenerable
# in the sense that matters least (it cannot be re-fetched, but losing a day of
# it costs the ability to re-check a day of arithmetic, not the record itself),
# and a bug here must not be able to reach the raw archive.
#
# Same shape as archive.sh where it matters: whole completed days only, sorted
# before compression so the output is canonical, hash appended to an append-only
# manifest, never re-archiving a day already published.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
ARCHIVE="${REPO_DIR:-/data/repos}/archive"
LOG="$DIR/verification-evidence.jsonl"

# Primary only, like the verification run that produces it. A witness has no
# evidence to publish because it does not perform the cross-source checks.
[ "${VANTAGE:-primary}" = "primary" ] || exit 0
[ -d "$ARCHIVE/.git" ] || exit 0
[ -s "$LOG" ] || exit 0

REL_DIR="verification"
MANIFEST="$ARCHIVE/$REL_DIR/MANIFEST.tsv"

today=$(date -u +%F)
mkdir -p "$ARCHIVE/$REL_DIR"
[ -f "$MANIFEST" ] || printf 'sha256\tpath\trecords\tfirst_ts\tlast_ts\tarchived_at\tcollector\n' > "$MANIFEST"

# Every distinct UTC day in the log except today's. A day still being written
# would be archived incomplete and its hash would change tomorrow, which is the
# property the manifest exists to rule out.
#
# Each record opens {"ts":"YYYY-MM-DD..., so the date is a fixed-offset prefix.
days=$(cut -c8-17 "$LOG" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -u | grep -v "^$today$")
[ -n "$days" ] || exit 0

for day in $days; do
  y=${day:0:4}; m=${day:5:2}; d=${day:8:2}
  rel="$REL_DIR/$y/$m/$d.jsonl.zst"
  out="$ARCHIVE/$rel"

  # Published already, with its hash recorded: leave it alone. Re-archiving is
  # either a no-op or a silent revision of a day someone may have checked.
  if [ -f "$out" ] && awk -F'\t' -v r="$rel" '$2==r{f=1} END{exit !f}' "$MANIFEST" 2>/dev/null; then
    continue
  fi
  rm -f "$out"

  mkdir -p "$(dirname "$out")"
  tmp="$out.tmp.$$"
  if ! grep "^{\"ts\":\"$day" "$LOG" | sort | zstd -19 -q -o "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "$(date -u +%FT%TZ) evidence archive FAILED for $day" >&2
    continue
  fi

  records=$(zstd -dc "$tmp" | wc -l)
  if [ "$records" -eq 0 ]; then rm -f "$tmp"; continue; fi
  first_ts=$(zstd -dc "$tmp" | head -n1 | cut -c8-27)
  last_ts=$(zstd -dc "$tmp" | tail -n1 | cut -c8-27)
  mv "$tmp" "$out"

  sha=$(sha256sum "$out" | cut -d' ' -f1)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$sha" "$rel" "$records" "$first_ts" "$last_ts" \
    "$(date -u +%FT%TZ)" "$(cat /app/BAM_NET_REF 2>/dev/null || echo unknown)" >> "$MANIFEST"

  echo "$(date -u +%FT%TZ) archived evidence $day → $rel ($records records, sha ${sha:0:12})"
done

exit 0
