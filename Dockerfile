# BAMservatory capture node.
#
# One container replaces the Windows box: it captures the public BAM API every
# minute, flattens each snapshot into the live datasets, runs the rollover
# detector, and on a throttle rebuilds and publishes both the dashboard and the
# raw archive.
#
# The collector is pinned by commit, not by branch. A capture pipeline whose
# binary can change underneath it cannot claim its history was gathered the same
# way throughout, which is the whole point of the archive.

ARG BAM_NET_REPO=https://github.com/RYthaGOD/bam-net.git
ARG BAM_NET_REF=0fcd020edfd9d71e7c36d971dad47ba88442a520

FROM rust:1-bookworm AS collector
ARG BAM_NET_REPO
ARG BAM_NET_REF
RUN git clone "$BAM_NET_REPO" /src \
 && cd /src \
 && git checkout --quiet "$BAM_NET_REF"
WORKDIR /src
# --release, unlike the debug build the Windows capture has been running. Same
# outputs, but it is the build anyone auditing this repo would reproduce.
RUN cargo build --release --locked --bin bam-net
# Record what was actually built so the running container can state its own
# provenance rather than asserting it from an env var.
RUN printf '%s\n' "$BAM_NET_REF" > /src/BAM_NET_REF

FROM node:22-bookworm-slim
ARG BAM_NET_REF
# stats.js stamps this into metrics.json provenance, so a published metric names
# the exact collector build that gathered its inputs.
ENV BAM_NET_REF=${BAM_NET_REF}
# bash + gawk + coreutils: the pipeline scripts. git: publishing. zstd: archive
# compression. ca-certificates: HTTPS to the BAM API and GitHub.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash gawk coreutils findutils git zstd ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=collector /src/target/release/bam-net /usr/local/bin/bam-net
COPY --from=collector /src/BAM_NET_REF /app/BAM_NET_REF
COPY pipeline/ /app/pipeline/
RUN chmod +x /app/pipeline/*.sh

# CAPTURE_DIR lives on the Railway volume; everything else is derived from it.
ENV CAPTURE_DIR=/data/capture \
    REPO_DIR=/data/repos \
    TICK_SECONDS=60 \
    PUBLISH_MINUTES=15 \
    SITE_REPO=https://github.com/RYthaGOD/bamservatory.git \
    ARCHIVE_REPO=https://github.com/RYthaGOD/bamservatory-data.git \
    ARCHIVE_URL=https://github.com/RYthaGOD/bamservatory-data

# tini reaps the detached publish subshells; without it they accumulate as
# zombies over a long-lived capture loop.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/pipeline/entrypoint.sh"]
