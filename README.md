# bamservatory-data

The capture node and public raw archive behind [BAMservatory](https://rythagod.github.io/bamservatory/).

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

**Single-vantage capture.** All observations come from one collector. Two
collectors in different regions cross-publishing would make a divergent vantage
point detectable. Not yet implemented.

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
