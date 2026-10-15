# Build the signaling service for the target platform/architecture.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags="-s -w" -o /out/g1viewer-signaling .

FROM alpine:3.21
RUN addgroup -S -g 10001 g1viewer \
    && adduser -S -D -H -u 10001 -G g1viewer g1viewer \
    && mkdir -p /var/lib/g1viewer \
    && chown 10001:10001 /var/lib/g1viewer
COPY --from=build --chown=10001:10001 /out/g1viewer-signaling /usr/local/bin/g1viewer-signaling
USER 10001:10001
ENV G1VIEWER_SIGNALING_ADDR=0.0.0.0:8787 \
    G1VIEWER_DATA_DIR=/var/lib/g1viewer
EXPOSE 8787
VOLUME ["/var/lib/g1viewer"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/g1viewer-signaling"]
