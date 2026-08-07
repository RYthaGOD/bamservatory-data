#!/usr/bin/env bash
# Shared helpers for the capture pipeline.

# Reset a working clone to the remote's current default branch.
#
# The clones live on the volume and outlive any single deployment, so a publish
# that failed mid-push would otherwise leave a divergent local commit that
# quietly blocks every later publish. Resetting to the remote before rebuilding
# makes each cycle independent of the last one's outcome.
#
# origin/HEAD rather than a hardcoded branch name, so renaming the default branch
# on GitHub does not strand the capture node. It is re-resolved each time because
# a clone taken while the repo was still empty has no origin/HEAD at all, and
# without the fallback every reset would fail and the drift it exists to prevent
# would happen silently.
sync_repo() {
  local dir="$1"
  [ -d "$dir/.git" ] || return 1
  git -C "$dir" fetch --quiet origin || return 1
  git -C "$dir" remote set-head origin --auto >/dev/null 2>&1
  local ref
  ref=$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -n "$ref" ] || ref="origin/main"
  git -C "$dir" reset --quiet --hard "$ref"
}
