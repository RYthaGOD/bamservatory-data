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

# ── Seed refresh ─────────────────────────────────────────────────────────────
# The seed is what a fresh volume restores from, and it only ever gets older.
# Frozen at the migration it would, after six months of running, silently roll
# the published series back six months on the first volume loss — the recovery
# path quietly becoming the thing that loses the data.
#
# It cannot simply be rebuilt from the archive at boot instead: reflattening
# fifty days of raw capture takes longer than a deploy should, and grows.
#
# So it is refreshed here, weekly, and kept small. summary.csv is carried whole
# because it *is* the series; nodes.csv only as a tail, since every consumer now
# tail-reads it; validators.csv not at all, because one tick rebuilds it.
refresh_seed() {
  local seed="$ARCHIVE/seed"
  [ -d "$ARCHIVE/.git" ] || return 0
  [ -s "$DIR/summary.csv" ] || return 0

  # Weekly. Frequent enough that a restore loses days rather than months, rare
  # enough that the repo does not fill with near-identical snapshots.
  #
  # Age is taken from THROUGH — the capture timestamp the seed was built at —
  # not from file mtime. Git does not record mtimes, so every sync_repo reset
  # restamps the checked-out seed with the current time; an mtime test can never
  # see a seed older than the last deploy, and the refresh would have been
  # skipped forever while appearing to be scheduled.
  local seed_through age_days
  seed_through=$(cat "$seed/THROUGH" 2>/dev/null | tr -d ' \t\r\n')
  if [ -n "$seed_through" ]; then
    local s_epoch n_epoch
    s_epoch=$(date -u -d "$seed_through" +%s 2>/dev/null || echo 0)
    n_epoch=$(date -u +%s)
    age_days=$(( (n_epoch - s_epoch) / 86400 ))
    [ "$s_epoch" -gt 0 ] && [ "$age_days" -lt 7 ] && return 0
  fi

  local latest node_rows tmp
  latest=$(tail -n1 "$DIR/summary.csv" | cut -d, -f1)
  tmp="$seed.new.$$"
  rm -rf "$tmp"; mkdir -p "$tmp"

  gzip -9 -c "$DIR/summary.csv"                     > "$tmp/summary.csv.gz"
  tail -n 5000 "$DIR/nodes.csv" | gzip -9 -c        > "$tmp/nodes.csv.gz"
  gzip -9 -c "$DIR/detections.log"                  > "$tmp/detections.log.gz"
  [ -f "$DIR/detections_replay.log" ] && gzip -9 -c "$DIR/detections_replay.log" > "$tmp/detections_replay.log.gz"
  tail -n 2 "$DIR/ticks.jsonl" | gzip -9 -c         > "$tmp/ticks.tail.jsonl.gz"

  # The node tail has to reach the newest summary row, or a restore comes up
  # with a series but no topology: no nodes, no regions, every Nakamoto
  # coefficient zero. Since a seed is only ever read during a disaster, a broken
  # one is discovered at the worst possible moment — so it is checked now, while
  # a good copy still exists to fall back on.
  node_rows=$(gzip -dc "$tmp/nodes.csv.gz" | grep -c "^$latest," || true)
  if [ "${node_rows:-0}" -lt 1 ]; then
    rm -rf "$tmp"
    log "seed refresh ABORTED — node tail does not cover $latest; keeping previous seed."
    return 0
  fi

  # Plain text, and deliberately outside SHA256SUMS: it is the throttle's clock,
  # readable in the repo without decompressing anything, and says plainly how
  # far back a restore from this seed would land.
  printf '%s\n' "$latest" > "$tmp/THROUGH"
  ( cd "$tmp" && sha256sum ./*.gz | sed 's|\./||' > SHA256SUMS )
  rm -rf "$seed"; mv "$tmp" "$seed"
  log "seed refreshed through $latest ($node_rows node rows for the latest snapshot)"
}

# ── Archive ──────────────────────────────────────────────────────────────────
if [ -d "$ARCHIVE/.git" ]; then
  sync_repo "$ARCHIVE" || log "archive: could not sync with origin — skipping."

  # After the reset, never before it: sync_repo resets the clone hard, so a seed
  # written earlier in this cycle would be discarded before it could be staged.
  #
  # Only the primary owns the seed. A witness holds its own partial history and
  # would overwrite the bootstrap with a record that starts weeks later.
  [ "$VANTAGE" = "primary" ] && refresh_seed

  # The cross-source verification series, published whole.
  #
  # It is the one artifact here that checks BAM rather than describing it, so it
  # belongs in the open next to the captures it draws on. Small enough to carry
  # entire — one row per half hour is a few KB a day — which keeps it trivially
  # diffable: a reader can see every reading ever taken, not a rolling window.
  if [ "$VANTAGE" = "primary" ] && [ -s "$DIR/verification.csv" ]; then
    cp "$DIR/verification.csv" "$ARCHIVE/verification.csv"
  fi

  # The attestation probe's own answer, published for the same reason: the
  # project's largest stated limit should be dated by the last time a machine
  # looked, not by the last time someone remembered to. Its commit history is
  # then the record of how long BAM has been asked.
  if [ "$VANTAGE" = "primary" ] && [ -s "$DIR/attestations.json" ]; then
    cp "$DIR/attestations.json" "$ARCHIVE/attestations.json"
  fi

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
    # The primary also carries the bootstrap seed. Without staging it the
    # refresh above would be written, reset away on the next cycle, rewritten,
    # and never actually published — a weekly no-op that looks like it works.
    [ "$VANTAGE" = "primary" ] && [ -d "$ARCHIVE/seed" ] && git -C "$ARCHIVE" add seed
    [ "$VANTAGE" = "primary" ] && [ -f "$ARCHIVE/verification.csv" ] && git -C "$ARCHIVE" add verification.csv
    [ "$VANTAGE" = "primary" ] && [ -f "$ARCHIVE/attestations.json" ] && git -C "$ARCHIVE" add attestations.json
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
