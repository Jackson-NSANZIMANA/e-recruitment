# syntax=docker/dockerfile:1
# ══════════════════════════════════════════════════════════════════
# MinIO + mc, built from pinned upstream source (ADR-047 document door).
#
# WHY. MinIO's community edition is source-only: `minio/minio` and `minio/mc` left Docker Hub in
# September 2026 and no new images are published. The compose files pin one mirrored image
# (ghcr.io/jackson-nsanzimana/usrp-minio@sha256:52dfd5c0…), a single artifact on a single host. This
# file is how that image is produced from source, so the document door never depends on a registry
# blob being reachable, and so a security release can be adopted the day it is tagged.
#
# PROVENANCE. Sources come through the Go module proxy, pinned by commit (pseudo-version), and are
# verified against the public checksum database (sum.golang.org): an append-only log, so the bytes
# cannot differ from what everyone else gets for that commit. The build then asserts that the module's
# recorded VCS origin is exactly the pinned commit, and stamps release and commit into `--version`.
#
# PINS. MinIO RELEASE.2025-10-15T17-29-55Z (commit 9e49d5e7): the last community release, which carries
# c1a4949 "fix: check sub-policy properly when present", a privilege escalation in service-account /
# STS sub-policy validation present in RELEASE.2025-09-07T16-13-09Z. mc RELEASE.2025-08-13T08-35-41Z
# (commit 7394ce0d), the last mc release. To move a pin: take the tag's commit from
# `git ls-remote https://github.com/minio/<repo> refs/tags/<tag>^{}`, then its pseudo-version from
# https://proxy.golang.org/github.com/minio/<repo>/@v/<commit>.info, and update the four ARGs as a set.
#
# RUNTIME. `scratch`: two static binaries, CA certificates and a home for mc's config. Root, like the
# image it replaces, so an existing data volume keeps working. Healthcheck as before: `mc ready local`.
#
#   docker build -t usrp-minio:RELEASE.2025-10-15T17-29-55Z infrastructure/docker/minio
#   (behind a TLS-intercepting proxy: --secret id=extra_ca,src=/path/to/proxy-ca.crt)
# ══════════════════════════════════════════════════════════════════
FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS build

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_VERSION=v0.0.0-20251015172955-9e49d5e7a648
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_VERSION=v0.0.0-20250813083541-7394ce0dd2a8
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

# The module proxy and checksum database are Go's defaults, stated so a GOPROXY/GOSUMDB/GOFLAGS from
# the build environment cannot weaken them. GOTOOLCHAIN=auto fetches the toolchain the module requires.
ENV CGO_ENABLED=0 GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GONOSUMDB= GOFLAGS=-trimpath GOTOOLCHAIN=auto

# Optional: one extra CA certificate for a TLS-intercepting proxy, as a build secret (never a layer).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then cat /run/secrets/extra_ca >> /etc/ssl/certs/ca-certificates.crt; fi; \
    set -eu; \
    check_origin() { \
      got="$(go mod download -json "$1@$2" | sed -n 's/.*"Hash": "\([0-9a-f]*\)".*/\1/p' | head -1)"; \
      [ "$got" = "$3" ] || { echo "✗ $1@$2 resolved to commit '${got}', not the pinned $3" >&2; exit 1; }; \
      echo "✓ $1@$2 is commit $3 (verified against sum.golang.org)"; \
    }; \
    check_origin github.com/minio/minio "$MINIO_VERSION" "$MINIO_COMMIT"; \
    check_origin github.com/minio/mc "$MC_VERSION" "$MC_COMMIT"; \
    minio_ts="$(echo "$MINIO_RELEASE" | sed -E 's/^RELEASE\.([0-9-]+)T([0-9]+)-([0-9]+)-([0-9]+)Z$/\1T\2:\3:\4Z/')"; \
    mc_ts="$(echo "$MC_RELEASE" | sed -E 's/^RELEASE\.([0-9-]+)T([0-9]+)-([0-9]+)-([0-9]+)Z$/\1T\2:\3:\4Z/')"; \
    go install -ldflags "-s -w \
      -X github.com/minio/minio/cmd.Version=$minio_ts -X github.com/minio/minio/cmd.ReleaseTag=$MINIO_RELEASE \
      -X github.com/minio/minio/cmd.CommitID=$MINIO_COMMIT -X github.com/minio/minio/cmd.ShortCommitID=$(echo $MINIO_COMMIT | cut -c1-12)" \
      "github.com/minio/minio@$MINIO_VERSION"; \
    go install -ldflags "-s -w \
      -X github.com/minio/mc/cmd.Version=$mc_ts -X github.com/minio/mc/cmd.ReleaseTag=$MC_RELEASE \
      -X github.com/minio/mc/cmd.CommitID=$MC_COMMIT" \
      "github.com/minio/mc@$MC_VERSION"; \
    /go/bin/minio --version; /go/bin/mc --version; \
    mkdir -p /rootfs/data /rootfs/root /rootfs/tmp && chmod 1777 /rootfs/tmp

FROM scratch
ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
LABEL org.opencontainers.image.title="usrp-minio" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.version="$MINIO_RELEASE" \
      org.opencontainers.image.revision="$MINIO_COMMIT" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /rootfs/ /
COPY --from=build /go/bin/minio /go/bin/mc /usr/bin/
ENV HOME=/root PATH=/usr/bin
EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/minio"]
