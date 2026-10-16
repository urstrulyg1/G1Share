# Self-hosting signaling and TURN

This guide deploys the HTTP signaling service behind Caddy for automatic HTTPS. Coturn is optional and is configured as a separate Compose profile. The desktop app never ships with a project-owned signaling/relay secret.

## What you need

- A Linux server with Docker Engine and Docker Compose v2.
- A DNS name pointing to the server and inbound TCP 80/443 for Caddy certificate issuance and HTTPS.
- A persistent, backed-up directory for the device registry.
- For TURN: a public IP, DNS name, unique random shared secret, and firewall access to TCP/UDP 3478 plus the configured relay-port range.
- The desktop client requires an HTTPS signaling origin for non-loopback URLs.

The Go service is plain HTTP. Do not publish port 8787 directly to the public internet. Put it behind a TLS reverse proxy or another reviewed HTTPS gateway.

## Compose deployment (Caddy + signaling)

From the repository root:

```sh
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

Set `G1VIEWER_DOMAIN` (or `OPENDESK_DOMAIN`) to a real DNS name pointing at this server. For a full TURN deployment, prefer `scripts/prepare-turn-deployment.sh`, which validates the public DNS/IP, generates a unique secret, writes a private `.env`, and validates both Compose files. Do not commit `.env`. Choose a non-overlapping private subnet if `172.30.10.0/24` is already in use, and update the fixed Caddy/signaling/Coturn addresses and `G1VIEWER_TRUSTED_PROXIES` together.

Prepare the persistent bind mount with the service's unprivileged UID/GID (10001):

```sh
sudo mkdir -p data/signaling
sudo chown 10001:10001 data/signaling
sudo chmod 700 data/signaling
```

Bring up the HTTPS gateway and signaling service:

```sh
docker compose up -d --build
docker compose ps
curl -fsS "https://${G1VIEWER_DOMAIN:-$OPENDESK_DOMAIN}/healthz"
```

Caddy obtains and renews the certificate. G1Viewer's Go service listens only inside the Compose network; Caddy is the only public path. `G1VIEWER_TRUSTED_PROXIES` is set to Caddy's fixed container IP so challenge rate limits use the client address supplied by that trusted proxy. Do not widen this range to untrusted containers. Registry JSON is stored at `./data/signaling/device-registry.json`; keep the data directory private and include it in encrypted backups.

The signaling service has no user account or administrator approval system. Anyone can register a new key; a session still requires the target user to approve it. Share device IDs only with intended peers and keep the service patched and monitored.

## Optional Coturn deployment

To prepare a complete TURN deployment, run the validated deployment script described in [the dynamic network-bootstrap guide](network-bootstrap.md). If configuring manually, generate a unique secret on the server (never reuse a sample value):

```sh
openssl rand -hex 32
```

Set in `.env`:

- `OPENDESK_TURN_SHARED_SECRET` to the generated secret.
- `OPENDESK_TURN_REALM` to your TURN realm/domain.
- `OPENDESK_TURN_EXTERNAL_IP` to the public IP Coturn advertises.
- `OPENDESK_STUN_URLS` to the STUN URI, for example `stun:turn.example.org:3478`.
- `OPENDESK_TURN_URLS` to comma-separated TURN URIs, for example `turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp`.

Ensure the TURN hostname resolves to the server and that the router/firewall forwards TCP/UDP 3478 and TCP/UDP 49160–49200. Adjust the relay range consistently in `docker-compose.turn.yml` and the firewall. The sample Coturn overlay does not configure TLS; TURN traffic is still carried as encrypted WebRTC (DTLS-SRTP), but signaling/credential issuance must use HTTPS. For networks that require TURN/TLS, configure Coturn certificates and a `turns:` URI separately; do not advertise a `turns:` URL until it has been tested.

Start the optional service:

```sh
docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile turn up -d --build
```

The Go service exposes `GET /api/v1/turn-credentials`, issuing random-username Coturn REST credentials with a configurable expiry (`G1VIEWER_TURN_CREDENTIAL_TTL`, default 10 minutes). The public endpoint is rate-limited to 20 requests per client IP per minute and returns HTTP 503 until a real TURN service is configured. Keep the shared secret identical for the signaling and Coturn services; it never leaves the Go service. The secret is visible to privileged Docker administrators, so protect Docker access and the server account. It is not a client private key.

## Firewall and operations

- Public: TCP 80/443 for Caddy; optionally UDP 443 for HTTP/3.
- Optional TURN: TCP/UDP 3478 and TCP/UDP 49160–49200, or the range you chose.
- Keep Go port 8787 private to the Compose network.
- Monitor `/healthz`, container logs, disk space, certificate renewal, and registry backups.
- The registry contains public keys and device metadata, not private identity keys. Session/event queues and online presence are in-memory and are lost on service restart; clients must reconnect.
- Use least-privilege host access, firewall rules, Docker updates, encrypted backups, and a secret manager or protected `.env` on the server. Do not upload `.env`, registry data, logs containing metadata, or secrets to the repository.

## Connecting desktop clients

For normal G1Viewer use, clients fetch the project's public relay/STUN bootstrap automatically and users enter only the remote Device ID. You do not need to enter this Go service as the signaling server. Once the TURN VPS is healthy, update `config/network-bootstrap.json` on `main` so `turnCredentialsUrl` points to `https://<your-real-domain>/api/v1/turn-credentials` and the STUN list includes `stun:<your-real-domain>:3478`. The desktop clients pick up the change dynamically after the bootstrap cache expires; no new client release is needed. For first-time peers, compare the displayed public-key fingerprint through a separate trusted channel and require host approval.

A STUN/TURN response only makes ICE endpoints available; it does not guarantee NAT traversal. Test from the actual networks you intend to support. Restrictive corporate firewalls may require TURN/TLS on port 443 and a relay configuration designed for that environment.

## Local Go service (development only)

```sh
cd services/signaling
go test -race -cover ./...
go vet ./...
go run .
```

By default this binds to `127.0.0.1:8787`. For a local container or reverse proxy, set `G1VIEWER_SIGNALING_ADDR` (or `OPENDESK_SIGNALING_ADDR`) explicitly. Never expose this development HTTP listener directly to the public internet.
