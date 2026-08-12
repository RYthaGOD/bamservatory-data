# bamservatory-data

[![verify](https://github.com/RYthaGOD/bamservatory-data/actions/workflows/verify.yml/badge.svg)](https://github.com/RYthaGOD/bamservatory-data/actions/workflows/verify.yml)

The capture node and public raw archive behind [BAMservatory](https://rythagod.github.io/bamservatory/).

That badge is the point of this repo in one line. It runs on GitHub's
infrastructure, on a schedule, and checks three things the operator cannot
quietly influence: every archived day still hashes to what the manifest
recorded, the three vantages still agree, and the published dashboard has not
gone stale. A red run is visible to anyone.

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

`pipeline/probe-attestations.mjs` asks daily whether that has happened and
publishes the answer to [`attestations.json`](attestations.json), so the claim
carries the date a machine last looked rather than the date someone last
remembered to. It records whether BAM's API was reachable at all, because "we
looked and there was nothing" and "we could not look" are different results and
only one of them is evidence.

**That capture was continuous.** Collectors miss windows — restarts, API
timeouts, deploys. `verify.sh` prints per-day coverage against the expected
1440 captures/day rather than claiming completeness, and the gaps are visible in
the archive itself.

1440 is the nominal rate, not a ceiling: the tick loop corrects for drift rather
than sleeping a flat 60 seconds, so a day lands within a handful either side and
recent days record 1445–1468. Coverage above 100% means a few minutes were
sampled twice, not that time was invented. Every record carries its own
timestamp, and consumers of the series de-duplicate on it.

**That every capture is complete.** The API has returned coherent but incomplete
views — valid JSON, self-consistent totals, a fraction of the network. Recording
one as an observation is how a published minimum came to be 10 nodes and 190
validators, neither of which was ever true of BAM.

`flatten.awk` now withholds a capture that collapses against the previous one,
and releases it if the smaller network is still there two captures later, so a
genuine change costs a couple of minutes of delay rather than being suppressed.
Withheld captures are listed in `partial.log` on the volume, and the raw record
is archived either way — what is withheld is the interpretation, never the
record.

**History, by re-derivation.** Nobody else holds 2026-06-20. The archive's value
is that it exists at all, and that dependency is honest to name: for the past you
are trusting an append-only record, not re-deriving from source.

**That the API told the same story to everyone.** Three collectors record
independently and publish separate archives, so a view served to only one of
them is detectable:

| vantage | region |
|---|---|
| primary | US East (Ashburn) |
| `sin` | Singapore |
| `ams` | Amsterdam |

Three rather than two is a deliberate choice. With two, a disagreement tells you
something is wrong but not which side is wrong. With three, a single divergent
vantage can be identified rather than merely flagged.

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

#### When a divergence has been explained

`compare.mjs` fails on any divergence, which is the right default and a bad
permanent state. The archive is append-only, so one bad minute would fail every
run from then on, and a badge that is always red is a badge nobody reads — the
next real divergence would arrive inside a failure that was already there.

[`REVIEWED.tsv`](REVIEWED.tsv) is how a divergence stops failing the build
without disappearing. Each entry names one vantage at one minute and explains
the cause. Entries are still printed in full on every run, with the explanation
attached and a count of how many findings they covered, and they cannot cover a
divergence at any other minute or vantage. `node compare.mjs --all --strict`
ignores the file entirely.

It records that someone looked. It is not a way to make a red run green.

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
| `pipeline/verify-sources.mjs` | Cross-checks BAM against Solana and Jito's Kobe API → `verification.csv` |
| `pipeline/verification-schema.mjs` | Every schema `verification.csv` has had, and the migration between them |
| `pipeline/probe-attestations.mjs` | Daily: has BAM published attestations yet? → `attestations.json` |
| `verify.sh` | Third-party verification. No credentials required |
| `test/flatten-guard.sh` | Asserts the partial-response guard in both directions. Runs in CI |

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
| `VERIFY_MINUTES` | Default `15`. Cross-source verification interval; primary only, and skipped entirely without `SOLANA_RPC_URL` |
| `SOLANA_RPC_URL` | Optional. Enables the cross-source verification run; without it the panel is simply absent |
| `ARCHIVE_URL` | Stamped into `metrics.json` provenance. Unset publishes `null` |
| `BAM_NET_REF` | Set from the Dockerfile build arg; names the collector build in provenance |

`ARCHIVE_URL` and `BAM_NET_REF` default to `null` rather than to hardcoded
values, so a pipeline that has not been configured publishes "not known" instead
of a claim that cannot be checked.

The collector is pinned by commit in the Dockerfile (`BAM_NET_REF`), not tracked
to a branch. A capture pipeline whose binary can change underneath it cannot
claim its history was gathered the same way throughout.

### Recovery

A collector starting on an empty volume restores from [`seed/`](seed/), so the
published series resumes where it left off instead of restarting at today.

The primary rewrites that seed weekly from its own live state, and
[`seed/THROUGH`](seed/THROUGH) records the capture timestamp it was built at —
which is how far back a restore would land. Left frozen, a seed only ever gets
older, and the recovery path eventually becomes the thing that destroys the
history it exists to protect.

| file | why |
|---|---|
| `summary.csv.gz` | whole — it *is* the series |
| `nodes.csv.gz` | tail only; every consumer tail-reads it |
| `detections.log.gz` | event history, not derivable from raw captures |
| `detections_replay.log.gz` | the validated 2026-06-24 rollover |
| `ticks.tail.jsonl.gz` | two records, so churn has something to compare |
| `THROUGH` | the seed's own age, in plain text |

`validators.csv` is not seeded: it is derived and only its tail is read, so one
capture rebuilds what matters.

The seed is written to a temporary directory and moved into place only after its
node tail is confirmed to reach the newest summary row. Without that overlap a
restore comes up with a series and no topology — no nodes, no regions, every
Nakamoto coefficient zero — and since a seed is read only during a disaster, the
fault would surface at the worst possible moment.

Rebuilding the derived files from `raw/` instead would be more elegant, and is
the obvious thing to reach for, but reflattening the archive already takes longer
than a deploy should and only grows.

## License

MIT. The archive is open data; the metrics are meant to be independently
reproducible.
