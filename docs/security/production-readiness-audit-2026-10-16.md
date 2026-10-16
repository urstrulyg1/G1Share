# G1Viewer Production Readiness & Security Audit — Remediation Update
Date: 2026-10-16
Repository: https://github.com/urstrulyg1/G1Viewer
Baseline audited commit: 845953a4f49f672934ad68d411a4c0a7de0ff5d1
Security-hardening merge: `cb987d960d76638a6c8794947a4584ed855421ab` (PR #7, merged to `main`)
Dynamic-bootstrap work: PR #8, `feature/dynamic-zero-config-connect` (merged to `main` before the TURN deployment work)
TURN deployment and credential endpoint: `25e73f32bb02615c050423e0a8025217427daa3c` (PR #9, merged to `main`)

## Release verdict

**Not yet approved for public production release.** Security hardening, dynamic network bootstrap, and deployable TURN credential/deployment tooling are merged to `main`. The active bootstrap intentionally keeps `turnCredentialsUrl` unset until a real TURN host has been provisioned, deployed, and verified. Passing CI does not substitute for independent cryptographic review, production infrastructure, or physical-device/network validation.

## Implemented remediation

### P0 — Authenticated, confidential WAN relay envelopes
File: `src/main/embedded-signaling.ts`

- Added versioned Ed25519-signed relay envelopes binding sender, recipient, timestamp, nonce, and payload/ciphertext.
- Added end-to-end encryption for all non-discovery WAN messages. Payloads use ephemeral X25519 key agreement, HKDF-SHA-256, and AES-256-GCM; the long-term Ed25519 identity key remains local and is used for signatures.
- The initial discovery query is the only permitted plaintext message; it contains discovery metadata only. Device summaries, session requests/decisions, WebRTC signaling, and session-close messages are encrypted.
- Added timestamp freshness, replay rejection, message-size bounds, per-sender/global inbound rate limits, and observed-key continuity checks.
- Bound peer metadata to the signing key and recipient identity. Invalid signatures, malformed ciphertext, expired messages, wrong recipients, and replayed nonces are rejected before dispatch.

### P0 — Session authorization and signaling integrity
Files: `src/main/embedded-signaling.ts`, `src/main/index.ts`

- Session signal forwarding and closure require a real session participant and a valid session state.
- Embedded WebRTC offer/answer messages now require the sender's registered Ed25519 signature, a valid SDP payload, and the correct role (host sends offer; viewer sends answer).
- Approved permissions must be a subset of requested permissions. Session decisions must have a boolean outcome and valid permission arrays.
- Device registration rejects ID/public-key mismatches and key replacement attempts.
- Electron navigation is restricted to the packaged renderer document (or same-origin development server); redirects to arbitrary file URLs and external origins are blocked, and IPC additionally validates the main-frame URL.
- Session-detail retrieval is participant-only and returns both the session and peer summary expected by the approval flow.
- WAN session requests fail closed if they cannot be injected locally or published to the relay; WAN decision/signal/close delivery failures are returned to the caller rather than silently reported as successful.
- Accepted sessions receive an active-session expiry instead of retaining the short pending-request timeout. Expired/terminal sessions are cleaned up, and device/session registries are bounded.

### P1 — TURN and LAN discovery hardening
Files: `src/main/embedded-signaling.ts`, `services/signaling/handlers.go`, `services/signaling/broker.go`, `docker-compose.turn.yml`, and `scripts/prepare-turn-deployment.sh`

- Removed the static `g1viewer/g1viewer` TURN credential fallback. TURN entries are omitted unless explicit credentials are configured.
- Automatic coordinator discovery only accepts HTTP origins on loopback/private/link-local LAN addresses or `.local` hosts, rejects paths/credentials/query strings, and refuses redirects.
- Added body validation for authenticated embedded signaling routes, device-name validation, and limits on challenge/session/device state.

## Regression tests added or updated

- Session signals/closure from non-participants are rejected.
- Invalid role and unsigned/invalid WebRTC signals are rejected; valid signed signals are accepted.
- Session decisions cannot grant unrequested permissions.
- Session details include peer identity for participants and are hidden from third parties.
- WAN envelopes are encrypted, tampering and replay are rejected, and a non-participant cannot forge a session decision.
- Active WAN sessions get the longer active TTL.
- LAN coordinator discovery rejects external or malformed targets.
- Renderer-navigation policy tests reject arbitrary file URLs, external origins, and cross-origin development navigation.

## Dynamic device-ID-first network configuration (PR #8)

- Added `src/main/network-config.ts` and a source-controlled `config/network-bootstrap.json` fetched from the project's HTTPS raw-content endpoint at runtime.
- The bootstrap supplies the WAN signaling relay and STUN list; configuration is validated, bounded by a timeout, briefly cached, and falls back to safe defaults if unavailable.
- Optional TURN credentials are fetched from a separately configured HTTPS endpoint and must expire within 24 hours. Static/shared TURN credentials are not embedded in the desktop client.
- The default bootstrap currently has no TURN credential endpoint. Therefore the app needs no manual signaling URL for normal device-ID-first use, but cannot guarantee connections through every NAT/firewall until TURN infrastructure is deployed and real-network tested.
- User-facing first-run and Settings guidance now describes this flow. Device fingerprint verification and host consent are intentionally retained.

## CI evidence

The GitHub Actions run for commit `a2ea98c209a022fa70de954729f8a89d11df2cdd` passed the core verification job:
- TypeScript typecheck
- Vitest: **18 test files, 143 tests passed**
- Desktop build
- `npm audit --audit-level=high`
- Go signaling tests with race detector and `go vet`

Run: https://github.com/urstrulyg1/G1Viewer/actions/runs/38899798261

PR #7 was squash-merged after the security-hardening work. PR #8 adds runtime-fetched relay/STUN configuration and optional ephemeral TURN credentials. The latest PR #8 core verification run passed TypeScript typecheck, unit tests, desktop build, npm audit, Go race tests, and Go vet; its current workflow run is tracked at https://github.com/urstrulyg1/G1Viewer/actions. CI results are not proof of real-world cross-NAT media transport or physical-device input/capture behavior.

## Remaining release gates

### P0 — Required before public release
1. Obtain an independent cryptographic review of the Ed25519-to-X25519 key conversion, envelope canonicalization, nonce/replay handling, and AES-GCM/HKDF construction. Do not ship the new protocol until this review and the full current-head CI pass are complete.
2. Test two real devices across separate networks with STUN-only, TURN-only, restrictive NAT, IPv4/IPv6, network changes, disconnect/reconnect, and relay failure. Verify media transport separately from signaling delivery.
3. Test real screen capture, native keyboard/mouse input, clipboard, file transfer, and supported audio behavior on actual Windows, macOS, and Linux desktops. Headless Chromium tests do not prove native behavior.
4. Run clean-install and upgrade smoke tests on each supported OS/architecture.

### P1 — Required for a supported release
1. Set up code signing and macOS notarization using release-owner-controlled certificates/secrets; current installers are not signed/notarized.
2. Automate dependency license-policy checks and document any required notices.
3. Validate relay provider availability, retention, and abuse policies. Payload contents are end-to-end encrypted, but the public relay can still observe device IDs/public keys, timing, message sizes, and topic metadata and can deny service.
4. Perform a soak test for long-running sessions, relay reconnects, event overflow, memory/CPU use, and repeated session creation/closure.

### Product limitations to disclose
- Unattended access remains unavailable.
- The README already states that native input, system audio, real cross-device streaming, and real-client file transfer have not all been verified on physical desktops.
- Universal cross-network connectivity must not be claimed without reproducible results for the supported network matrix.

## Reproducible commands

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test -race -cover ./... && go vet ./...)
CHROME_PATH=/path/to/chrome npm run test:e2e
```

## Changed application files

- `src/main/embedded-signaling.ts`
- `src/main/index.ts`
- `src/main/embedded-signaling.test.ts`
- `src/main/wan-relay.test.ts`
- `src/main/renderer-navigation.ts`
- `src/main/renderer-navigation.test.ts`

PR #7 is merged into `main`; PR #8 remains separate until its latest CI and packaging jobs finish. The remaining release gates above still apply.


## Current release blockers after the 2026-10-16 main-branch merge

- **Live TURN is not deployed.** `config/network-bootstrap.json` still has `turnCredentialsUrl: null`; the deployment script requires a real public IPv4 address, DNS hostname, and reachable firewall ports. Do not replace this with a placeholder URL.
- **Cross-network relay validation is outstanding.** Unit and two-client browser tests do not prove that TURN works through independent NATs or restrictive enterprise networks.
- **Real desktop validation is outstanding.** Install and test signed/release packages on physical Windows and macOS devices, including capture, input permissions, reconnect, and cross-network media.
- **Release trust is incomplete.** Complete independent cryptographic review, signing/notarization, update verification, and incident/abuse operations before claiming production readiness.
- **CI status must be checked on the merged `main` SHA** `25e73f32bb02615c050423e0a8025217427daa3c`; packaging and end-to-end jobs were still queued at the time of this update.
