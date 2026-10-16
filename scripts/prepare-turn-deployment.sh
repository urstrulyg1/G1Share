#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v openssl >/dev/null 2>&1 || fail "OpenSSL is required."
command -v getent >/dev/null 2>&1 || fail "getent is required to validate DNS."
command -v python3 >/dev/null 2>&1 || fail "Python 3 is required to validate the public IPv4 address."

: "${G1VIEWER_DOMAIN:?Set G1VIEWER_DOMAIN to a real DNS hostname pointing to this server.}"
: "${G1VIEWER_TURN_EXTERNAL_IP:?Set G1VIEWER_TURN_EXTERNAL_IP to this server's public IPv4 address.}"

DOMAIN="${G1VIEWER_DOMAIN,,}"
PUBLIC_IP="$G1VIEWER_TURN_EXTERNAL_IP"

[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "G1VIEWER_DOMAIN must be a real DNS hostname."
[[ "$DOMAIN" != *example* && "$DOMAIN" != *test* && "$DOMAIN" != *invalid* ]] || fail "Example/test hostnames are not allowed."
python3 - "$PUBLIC_IP" <<'PY'
import ipaddress, sys
try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit("G1VIEWER_TURN_EXTERNAL_IP must be a valid IP address.")
if address.version != 4 or not address.is_global:
    raise SystemExit("G1VIEWER_TURN_EXTERNAL_IP must be a globally routable public IPv4 address.")
PY

if ! getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | grep -Fxq "$PUBLIC_IP"; then
  fail "DNS for $DOMAIN does not resolve to $PUBLIC_IP. Configure the DNS A record and wait for propagation before deploying."
fi

if [[ -e .env && "${G1VIEWER_OVERWRITE_ENV:-0}" != "1" ]]; then
  fail ".env already exists. Back it up, review it, then rerun with G1VIEWER_OVERWRITE_ENV=1 to replace it."
fi

SECRET="${G1VIEWER_TURN_SHARED_SECRET:-$(openssl rand -hex 32)}"
[[ "$SECRET" =~ ^[a-fA-F0-9]{64,}$ ]] || fail "G1VIEWER_TURN_SHARED_SECRET must be at least 32 random bytes encoded as hex."

umask 077
cat > .env <<EOF
G1VIEWER_DOMAIN=$DOMAIN
OPENDESK_DOMAIN=$DOMAIN
G1VIEWER_STUN_URLS=stun:$DOMAIN:3478
OPENDESK_STUN_URLS=stun:$DOMAIN:3478
G1VIEWER_TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
OPENDESK_TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
G1VIEWER_TURN_REALM=$DOMAIN
OPENDESK_TURN_REALM=$DOMAIN
G1VIEWER_TURN_EXTERNAL_IP=$PUBLIC_IP
OPENDESK_TURN_EXTERNAL_IP=$PUBLIC_IP
G1VIEWER_TURN_SHARED_SECRET=$SECRET
OPENDESK_TURN_SHARED_SECRET=$SECRET
G1VIEWER_TURN_CREDENTIAL_TTL=10m
OPENDESK_TURN_CREDENTIAL_TTL=10m
EOF
chmod 600 .env

docker compose config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile turn config >/dev/null

cat <<EOF
Configuration generated in .env (permissions 0600).
Domain: $DOMAIN
Public IPv4: $PUBLIC_IP
TURN URIs: turn:$DOMAIN:3478 (UDP and TCP)
Temporary TURN credential lifetime: 10 minutes

Before starting services, allow inbound TCP 80/443, TCP+UDP 3478, and TCP+UDP 49160-49200 in both the host firewall and provider firewall/security group.
EOF

if [[ "${G1VIEWER_DEPLOY:-0}" == "1" ]]; then
  docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile turn up -d --build
  printf '\nDeployment started. Check status with: docker compose -f docker-compose.yml -f docker-compose.turn.yml --profile turn ps\n'
  printf 'Health check: curl -fsS https://%s/healthz\n' "$DOMAIN"
  printf 'TURN credential endpoint: https://%s/api/v1/turn-credentials\n' "$DOMAIN"
else
  printf '\nConfiguration validated but services were not started. To deploy now, rerun with G1VIEWER_DEPLOY=1.\n'
fi
