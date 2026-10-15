# Build the signaling service for the target platform/architecture.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags="-s -w" -o /out/opendesk-signaling .

FROM alpine:3.21
RUN addgroup -S -g 10001 opendesk \
    && adduser -S -D -H -u 10001 -G opendesk opendesk \
    && mkdir -p /var/lib/opendesk \
    && chown 10001:10001 /var/lib/opendesk
COPY --from=build --chown=10001:10001 /out/opendesk-signaling /usr/local/bin/opendesk-signaling
USER 10001:10001
ENV OPENDESK_SIGNALING_ADDR=0.0.0.0:8787 \
    OPENDESK_DATA_DIR=/var/lib/opendesk
EXPOSE 8787
VOLUME ["/var/lib/opendesk"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/opendesk-signaling"]
