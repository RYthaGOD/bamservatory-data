#!/usr/bin/env bash
# Supervisor for the capture node.
#
# A long-lived loop rather than a Railway cron job, for two reasons: cron spawns
# a fresh container per run, which at a 60-second cadence spends most of its life
# starting up, and a volume can only be mounted by one active deployment — so
# overlapping cron containers would fight for it. One process, one mount, one
# clock.

set -uo pipefail

CAPTURE_DIR="${CAPTURE_DIR:-/data/capture}"
REPO_DIR="${REPO_DIR:-/data/repos}"
TICK_SECONDS="${TICK_SECONDS:-60}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ── Preflight ────────────────────────────────────────────────────────────────
# Fail loudly at boot rather than silently capturing into a container filesystem
# that vanishes on the next deploy. A capture node that loses history is worse
# than one that refuses to start, because the loss is invisible until someone
# asks for the history.
if ! mountpoint -q /data 2>/dev/null && [ ! -d /data ]; then
  log "FATAL: /data is not present. Attach a Railway volume mounted at /data."
  exit 1
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  log "FATAL: GITHUB_TOKEN is unset. Capture would run but could never publish."
  exit 1
fi

mkdir -p "$CAPTURE_DIR" "$REPO_DIR"

git config --global user.name  "${GIT_AUTHOR_NAME:-BAMservatory capture}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-capture@bamservatory.xyz}"
git config --global --add safe.directory '*'
# Credentials go in a file mode 600, never into a remote URL: a token embedded
# in `git remote -v` leaks into every error message and process listing.
printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > /root/.git-credentials
chmod 600 /root/.git-credentials
git config --global credential.helper store

# ── Working clones ───────────────────────────────────────────────────────────
# Both live on the volume so a redeploy resumes instead of re-cloning, and so a
# publish interrupted mid-push leaves a recoverable working tree.
. /app/pipeline/lib.sh

clone_or_update() {
  local url="$1" dir="$2"
  if [ -d "$dir/.git" ]; then
    sync_repo "$dir"
  else
    log "cloning $url → $dir"
    git clone --quiet "$url" "$dir"
  fi
}

clone_or_update "${SITE_REPO}"    "$REPO_DIR/site"    || log "WARN: site repo unavailable at boot"
clone_or_update "${ARCHIVE_REPO}" "$REPO_DIR/archive" || log "WARN: archive repo unavailable at boot"

# ── Push preflight ───────────────────────────────────────────────────────────
# A token that can read but not write is the worst failure this service has,
# because everything looks healthy: the clone succeeds, capture runs, the volume
# fills, the logs are clean. Only the publish fails, hours later, in a detached
# subshell whose output goes to a file on the volume — so the dashboard silently
# stops updating while every visible signal says fine.
#
# GitHub's API is no help here: a fine-grained PAT's own scope is not
# introspectable, and the repo `permissions` block reports the *user's* rights,
# not the token's. It will happily say push:true for a read-only token. The only
# honest test is asking the server whether this credential may write, which is
# what a dry-run push does.
push_check() {
  local dir="$1" label="$2"
  [ -d "$dir/.git" ] || return 0
  if git -C "$dir" push --dry-run origin HEAD >/dev/null 2>&1; then
    log "preflight: $label writable"
  else
    log "PREFLIGHT FAILED: cannot push to $label."
    log "PREFLIGHT FAILED: capture will run and the volume will stay healthy, but"
    log "PREFLIGHT FAILED: nothing will be published until this is fixed."
    log "PREFLIGHT FAILED: check GITHUB_TOKEN has Contents: Read and write on this repo,"
    log "PREFLIGHT FAILED: and that it has not expired."
    return 1
  fi
}
push_check "$REPO_DIR/site"    "${SITE_REPO}"    || true
push_check "$REPO_DIR/archive" "${ARCHIVE_REPO}" || true

# ── Seed restore ─────────────────────────────────────────────────────────────
# summary.csv is the series: every point the dashboard plots comes from it. An
# empty volume would still run, but `window.from` would restart at today and the
# history back to 2026-06-20 would silently vanish from the published metrics.
#
# So a fresh volume restores from seed/ in the archive repo, which carries the
# capture state at cutover, hashed. This runs once — the moment summary.csv
# exists the branch is skipped, so a restart never overwrites live capture with
# a stale bootstrap.
SEED="$REPO_DIR/archive/seed"
if [ ! -s "$CAPTURE_DIR/summary.csv" ] && [ -d "$SEED" ]; then
  log "empty volume — restoring capture state from seed"
  if ( cd "$SEED" && sha256sum --quiet -c SHA256SUMS ); then
    gzip -dc "$SEED/summary.csv.gz"           > "$CAPTURE_DIR/summary.csv"
    gzip -dc "$SEED/nodes.csv.gz"             > "$CAPTURE_DIR/nodes.csv"
    gzip -dc "$SEED/detections.log.gz"        > "$CAPTURE_DIR/detections.log"
    gzip -dc "$SEED/detections_replay.log.gz" > "$CAPTURE_DIR/detections_replay.log"
    # Churn compares the last two captures, so the raw log needs those two
    # records or the first tick after cutover reports a spurious node-set change.
    gzip -dc "$SEED/ticks.tail.jsonl.gz"      > "$CAPTURE_DIR/ticks.jsonl"

    # Those two records are continuity scaffolding, not a day this node
    # captured. Without a watermark covering them, archive.sh sees a completed
    # UTC day holding 2 records and publishes it as such — a manifest entry
    # claiming 2/1440 coverage for a day that in reality was fully captured
    # elsewhere. That is a false statement about the record, which is precisely
    # what the archive exists to make impossible. Mark the seed's own day as
    # already archived so only genuinely locally-captured days are published.
    seed_day=$(tail -n1 "$CAPTURE_DIR/ticks.jsonl" | cut -c8-17)
    case "$seed_day" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
        echo "$seed_day" > "$CAPTURE_DIR/.archived_through"
        log "seed spans $seed_day — marked archived so the partial tail is never published as a day"
        ;;
    esac

    log "restored: $(wc -l < "$CAPTURE_DIR/summary.csv") series rows, from $(sed -n '2p' "$CAPTURE_DIR/summary.csv" | cut -d, -f1)"
  else
    log "FATAL: seed checksums do not verify — refusing to bootstrap from it."
    log "FATAL: publishing from a corrupt seed would put bad points in the series."
    exit 1
  fi
elif [ ! -s "$CAPTURE_DIR/summary.csv" ]; then
  log "WARN: no capture state and no seed/ in the archive repo."
  log "WARN: the series will restart at today rather than 2026-06-20."
fi

# validators.csv is deliberately not seeded: it is derived, only its tail is
# read, and it rebuilds itself within one tick.

log "capture node up — collector $(cat /app/BAM_NET_REF 2>/dev/null || echo unknown)"
log "tick every ${TICK_SECONDS}s into $CAPTURE_DIR"

# ── Shutdown ─────────────────────────────────────────────────────────────────
# Railway stops the old deployment before starting the new one. Finishing the
# tick in flight keeps a half-flattened row out of the CSVs, which would
# otherwise surface as a corrupt point in a published series.
RUNNING=1
trap 'RUNNING=0; log "shutdown requested — finishing current tick"' TERM INT

while [ "$RUNNING" -eq 1 ]; do
  started=$(date +%s)
  bash /app/pipeline/tick-once.sh || log "tick failed (continuing)"

  # Drift correction: sleep the remainder of the interval, not the whole of it,
  # so capture timestamps stay on a stable cadence as tick cost varies.
  elapsed=$(( $(date +%s) - started ))
  remaining=$(( TICK_SECONDS - elapsed ))
  [ "$remaining" -lt 1 ] && remaining=1
  [ "$RUNNING" -eq 1 ] && sleep "$remaining"
done

log "capture node stopped cleanly"
