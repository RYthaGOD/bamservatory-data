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

# ── Dashboard ────────────────────────────────────────────────────────────────
if [ -d "$SITE/.git" ]; then
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

  if [ -n "$(git -C "$ARCHIVE" status --porcelain)" ]; then
    git -C "$ARCHIVE" add raw MANIFEST.tsv
    # The commit message names the days added, so the archive's own history is
    # readable without decompressing anything.
    added=$(git -C "$ARCHIVE" diff --cached --name-only -- raw | sed 's|raw/||; s|\.jsonl\.zst$||; s|/|-|g' | tr '\n' ' ')
    git -C "$ARCHIVE" commit --quiet -m "archive: ${added:-manifest update}"
    if git -C "$ARCHIVE" push --quiet; then
      log "archive: published ${added:-manifest update}"
    else
      log "archive: push FAILED — will retry next cycle."
    fi
  else
    log "archive: nothing new to publish."
  fi
else
  log "archive: repo not cloned — skipping."
fi
