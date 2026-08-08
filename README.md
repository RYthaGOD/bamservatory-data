# bamservatory-data

[![verify](https://github.com/RYthaGOD/bamservatory-data/actions/workflows/verify.yml/badge.svg)](https://github.com/RYthaGOD/bamservatory-data/actions/workflows/verify.yml)

The capture node and public raw archive behind [BAMservatory](https://rythagod.github.io/bamservatory/).

That badge is the point of this repo in one line. It runs on GitHub's
infrastructure, on a schedule, and checks three things the operator cannot
quietly influence: every archived day still hashes to what the manifest
recorded, the two vantages still agree, and the published dashboard has not gone
stale. A red run is visible to anyone.

This repo exists so that nothing on the dashboard has to be taken on trust. It
holds the primary record — what the public BAM API returned, as captured — plus
the infrastructure that gathers it and the tooling to check it.

```
bam-net  ──────────►  bamservatory-data  ──────────►  bamservatory
(collector)           (raw archive + capture node)     (published metrics + site)

how data is           what was observed,               what it means
gathered              and proof it was not
                      revised afterwards
```

## The trust model

State this plainly, because an institution consuming the feed will ask, and a
vaguer answer is worse than a narrow one.

### What can be verified independently

**Present-day figures, by anyone, right now.** Every headline number —
BAM stake share, node count, topology, connected validators — comes from public
endpoints (`/nodes`, `/validators`, `/bam_stake`). Query them yourself and
compare against the latest `metrics.json`. No part of the current-state claim
requires trusting this project.

**The transform, in full.** Published metrics are a pure function of published
inputs. `flatten.awk` turns raw captures into CSVs; `stats.js` in the
[bamservatory](https://github.com/RYthaGOD/bamservatory) repo turns CSVs into
`metrics.json`. Both are public, and both are deterministic. Nakamoto
coefficients, HHI, top-N concentration — recompute them all from `raw/` and
compare.

**That history was not revised.** Each completed UTC day of raw capture is
compressed to `raw/YYYY/MM/DD.jsonl.zst` and its SHA-256 appended to
[`MANIFEST.tsv`](MANIFEST.tsv). The manifest is append-only in a public commit
history. Record a day's hash today and it must still match years from now; if it
ever doesn't, that is detectable by anyone who kept the old value, without
needing our cooperation.

```bash
git clone https://github.com/RYthaGOD/bamservatory-data.git
cd bamservatory-data
./verify.sh                # hashes, record counts, boundary timestamps, coverage
./verify.sh 2026-06-20     # one day
```

### What cannot

**That the BAM API told the truth.** This is a faithful recording of a public
endpoint, not an attestation from BAM. There is no cryptographic link between
this archive and what the network actually executed. When BAM node attestations
become publicly queryable, that link becomes possible and closing it is the
single most valuable thing this project could add.

**That capture was continuous.** Collectors miss windows — restarts, API
timeouts, deploys. `verify.sh` prints per-day coverage against the expected
1440 captures/day rather than claiming completeness, and the gaps are visible in
the archive itself.

**History, by re-derivation.** Nobody else holds 2026-06-20. The archive's value
is that it exists at all, and that dependency is honest to name: for the past you
are trusting an append-only record, not re-deriving from source.

**That the API told the same story to everyone.** Two collectors in separate
regions record independently and publish separate archives, so a view served to
only one of them is detectable:

```bash
node compare.mjs --all
```

Minute by minute, this checks that both vantages saw the same node set, the same
validator population within tolerance, and the same BAM stake within tolerance.
Stake and validator counts move continuously and the two never sample the same
instant, so demanding equality there would report ordinary drift as divergence
and make the check worthless. The node set is compared exactly — nodes join and
leave rarely enough that a disagreement means something.

Agreement across vantages is corroboration, not proof. Both collectors could be
shown the same false view, and no number of vantages fixes that — only
attestations do.

## Architecture

One long-lived container, one volume, one clock.

| Script | Role |
|---|---|
| `pipeline/entrypoint.sh` | Supervisor. Preflight, clones, drift-corrected tick loop, clean shutdown |
| `pipeline/tick-once.sh` | One capture → raw log → flattened CSVs → detector |
| `pipeline/flatten.awk` | Raw snapshot → `summary.csv`, `nodes.csv`, `validators.csv` |
| `pipeline/detect.sh` | Rollover precursor / cutover events → `detections.log` |
| `pipeline/rotate.sh` | Bounds the two tail-read files; never trims past the archive watermark |
| `pipeline/archive.sh` | Completed days → `raw/`, hashes → `MANIFEST.tsv` |
| `pipeline/publish.sh` | Rebuilds the dashboard, pushes site and archive |
| `verify.sh` | Third-party verification. No credentials required |

A Railway cron job would spawn a fresh container per run, and a volume admits
only one active deployment — so capture runs as a service with an internal loop
instead.

### Two markers on the volume, and why they are separate

They look similar and answer completely different questions. Collapsing them
into one caused the archive to silently drop days.

| Marker | Question | Written by | Read by |
|---|---|---|---|
| `.captured_from` | Which days predate this node? | `entrypoint.sh`, once at seed restore | `archive.sh` |
| `.archived_through` | Which days are durably on GitHub? | `publish.sh`, only after a confirmed push | `rotate.sh` |

`.captured_from` exists because the seed carries a couple of raw records purely
so churn has something to compare against. Without it, `archive.sh` sees a
completed UTC day holding two records and publishes a manifest entry claiming
0.1% coverage for a day that was captured in full on the machine being migrated
from.

`.archived_through` gates trimming. `rotate.sh` discards raw records once they
are archived, so if this advanced on anything less than a confirmed push, a
failed push would leave the only copy of those records in a local commit that
never left the container — and the next reset to origin would destroy it.

An earlier version used one marker for both. A single failed push then advanced
it, the next cycle reset the clone to origin, and `archive.sh` skipped the day
as already handled: the day was lost permanently, from the artifact whose entire
purpose is to be complete. Whether a day is *written* and whether it is
*published* are different facts, and only the second one is safe to build on.

### Why the live files stay small

The pipeline reads far less than it stores. `summary.csv` (the series),
`nodes.csv`, and `detections.log` are read in full and are never trimmed.
`validators.csv` and `ticks.jsonl` are read only at the tail, yet on the
original Windows capture they had grown to 1.5 GB and 2.3 GB — scanned in full
every minute to reach their last few lines. `rotate.sh` bounds both, and nothing
is trimmed until it is archived.

## Deployment

Railway service, Dockerfile build, volume mounted at `/data`.

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT, `contents: write` on `bamservatory` and `bamservatory-data` |
| `OPENAI_API_KEY` | Optional. Briefing generation; failure never blocks a publish |
| `CAPTURE_DIR` | Default `/data/capture` |
| `TICK_SECONDS` | Default `60` |
| `PUBLISH_MINUTES` | Default `15` |
| `ARCHIVE_URL` | Stamped into `metrics.json` provenance. Unset publishes `null` |
| `BAM_NET_REF` | Set from the Dockerfile build arg; names the collector build in provenance |

`ARCHIVE_URL` and `BAM_NET_REF` default to `null` rather than to hardcoded
values, so a pipeline that has not been configured publishes "not known" instead
of a claim that cannot be checked.

The collector is pinned by commit in the Dockerfile (`BAM_NET_REF`), not tracked
to a branch. A capture pipeline whose binary can change underneath it cannot
claim its history was gathered the same way throughout.

### Seeding

Before first deploy, copy the existing capture state onto the volume so the
series does not restart at today:

```
summary.csv              4.6 MB   the series — every plotted point
nodes.csv                 50 MB   region rollups
detections.log            39 KB   event history
detections_replay.log      2 KB   the validated 2026-06-24 rollover
ticks.jsonl (tail)                 last ~2 records, for churn continuity
```

`validators.csv` does not need seeding — it is derived, and only its tail is
read.

## License

MIT. The archive is open data; the metrics are meant to be independently
reproducible.
