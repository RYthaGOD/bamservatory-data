#!/usr/bin/env bash
# Rebuild the dashboard and push both public repos.
#
# Runs detached from the capture loop on a throttle, so neither a slow push nor
# a GitHub outage can delay a capture. Publishing is best-effort by design:
# missing a refresh costs freshness, missing a capture costs a data point that
# cannot be recovered.

set -u

DIR="${CAPTURE_DIR:-/data/capture}"
REPOS="${REPO_DIR:-/data/repos}"
SITE="$REPOS/site"
ARCHIVE="$REPOS/archive"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

. /app/pipeline/lib.sh

VANTAGE="${VANTAGE:-primary}"

# ── Dashboard ────────────────────────────────────────────────────────────────
# Only the primary renders the site. A witness exists to be an independent
# second recording; if it could also publish the dashboard, the two vantages
# would race to overwrite the same metrics.json and whichever pushed last would
# win — turning an agreement check into a coin toss.
if [ "$VANTAGE" != "primary" ]; then
  log "vantage '$VANTAGE': witness — skipping dashboard, publishing raw record only."
elif [ -d "$SITE/.git" ]; then
  sync_repo "$SITE" || log "site: could not sync with origin — building on the local tree."

  node "$SITE/stats.js" --dir "$DIR" \
    && { node "$SITE/brief.js" || log "brief.js failed — publishing with the previous briefing."; } \
    && node "$SITE/build.js"

  if git -C "$SITE" diff --quiet -- index.html metrics.json briefing.json; then
    log "site: no change."
  else
    git -C "$SITE" add index.html metrics.json briefing.json
    git -C "$SITE" commit --quiet -m "data refresh $(date -u +%Y-%m-%dT%H:%MZ)"
    if git -C "$SITE" push --quiet; then
      log "site: published."
    else
      log "site: push FAILED — will retry next cycle."
    fi
  fi
else
  log "site: repo not cloned — skipping."
fi

# ── Archive ──────────────────────────────────────────────────────────────────
if [ -d "$ARCHIVE/.git" ]; then
  sync_repo "$ARCHIVE" || log "archive: could not sync with origin — skipping."

  bash /app/pipeline/archive.sh || log "archive: archive.sh reported a failure."

  # Each vantage owns its own subtree, so the two collectors never stage the
  # same paths and a push race costs a retry rather than someone's data.
  if [ "$VANTAGE" = "primary" ]; then
    RAW_REL="raw"; MANIFEST_REL="MANIFEST.tsv"
  else
    RAW_REL="vantage/$VANTAGE/raw"; MANIFEST_REL="vantage/$VANTAGE/MANIFEST.tsv"
  fi

  if [ -n "$(git -C "$ARCHIVE" status --porcelain)" ]; then
    git -C "$ARCHIVE" add "$RAW_REL" "$MANIFEST_REL"
    # The commit message names the days added, so the archive's own history is
    # readable without decompressing anything.
    added=$(git -C "$ARCHIVE" diff --cached --name-only -- "$RAW_REL" \
      | sed "s|$RAW_REL/||; s|\.jsonl\.zst$||; s|/|-|g" | tr '\n' ' ')
    git -C "$ARCHIVE" commit --quiet -m "archive[$VANTAGE]: ${added:-manifest update}"
    if git -C "$ARCHIVE" push --quiet; then
      log "archive: published ${added:-manifest update}"
      # Now, and only now, is a day durably published. rotate.sh trims the
      # capture log up to this marker, so advancing it on anything less than a
      # confirmed push would discard raw records whose only other copy was a
      # local commit that never left the container.
      newest=$(ls "$ARCHIVE/$RAW_REL"/*/*/*.jsonl.zst 2>/dev/null \
        | sed "s|.*/$RAW_REL/||; s|\.jsonl\.zst$||; s|/|-|g" | sort | tail -n1)
      if [ -n "$newest" ]; then
        echo "$newest" > "$DIR/.archived_through"
        log "archive: durable through $newest"
      fi
    else
      log "archive: push FAILED — will retry next cycle."
    fi
  else
    log "archive: nothing new to publish."
  fi
else
  log "archive: repo not cloned — skipping."
fi
