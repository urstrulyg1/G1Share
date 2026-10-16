# G1Viewer Production Readiness & Security Audit
Date: 2026-10-16
Repository: https://github.com/urstrulyg1/G1Viewer
Reviewed commit: 845953a4f49f672934ad68d411a4c0a7de0ff5d1

## Verdict
NOT READY FOR PUBLIC PRODUCTION RELEASE. GitHub Actions passed, but source review found high-risk trust-boundary and authorization gaps in the embedded/WAN signaling path. This was a read-only remote review; no repository files were changed and no local test commands were run from this environment.

## Verified CI
Workflow run: https://github.com/urstrulyg1/G1Viewer/actions/runs/38896588814
Observed success: TypeScript typecheck, Vitest, desktop build, npm audit at high severity, Go tests with race detector, go vet, headless two-client E2E, Windows x64/ARM64, macOS x64/ARM64, Linux x64 DEB/AppImage package builds, and artifact validation.

CI proves those jobs passed, not real-world cross-NAT connectivity or production security. README documents real desktop media/input/audio/file-transfer validation as outstanding.

## Findings

### P0 — WAN relay payloads are not authenticated/authorized
File: src/main/embedded-signaling.ts, WanRelayBridge.handleIncomingRawMessage / handleRelayMessage.
Evidence: relay payload is parsed as JSON and dispatched by action. session_request injects a session and emits an event; session_decision changes session status based on payload.accepted; signal emits a signal event based on target ID; session_close marks a session closed. These routes do not cryptographically authenticate relay sender or bind the action to a trusted session participant/state.
Impact: anyone able to publish on a target relay topic may forge events, interfere with sessions, or cause denial of service. Peer-signal signing exists in a separate path but does not authenticate every relay action.
Remediation: define a versioned signed envelope; verify identity public key, device-ID binding, session participant membership, action-specific state transition, expiry, nonce/replay protection, payload bounds, and permission subset before mutating state. Add isolated tests for forged sender, forged decision, replay, stale session, signal injection, and unauthorized close.

### P0 — Embedded broker does not enforce participant authorization consistently
File: src/main/embedded-signaling.ts, EmbeddedSignalingBroker.forwardSignal / closeSession.
Evidence: forwardSignal verifies existence and status, but does not require fromDeviceId to equal either session participant. closeSession closes any existing session and computes destination as the initiator if the caller is not the initiator.
Impact: another authenticated device on this embedded coordinator can try to inject signaling or terminate sessions it does not own.
Remediation: reject unless actor is exactly fromDeviceId or toDeviceId; also enforce current session status and expiry. Make close/forward mutation and event emission atomic at the logical level. Test both valid participants and a third device.

### P1 — Device-ID-derived relay topic is not authentication
File: src/main/embedded-signaling.ts, deriveWanTopic.
Evidence: topic is derived from a nine-digit device ID via SHA-256 truncated to 24 hex chars. The effective search space is bounded by possible IDs, not hash output length.
Impact: topic secrecy cannot be treated as a security boundary; if the relay permits public subscribe/publish, knowledge or recovery of ID enables message access.
Remediation: require cryptographic authorization independent of topic, validate relay access control/retention policies; consider random high-entropy routing identifiers or authenticated coordination.

### P1 — Unsafe static TURN credential fallback
File: src/main/embedded-signaling.ts, GET /api/v1/ice.
Evidence: when TURN URLs are configured without username/credential env vars, handler emits username and credential 'g1viewer'.
Impact: inappropriate for publicly reachable TURN service; may permit unauthorized relay use depending on server configuration.
Remediation: do not send fixed fallback credentials. Require explicit credentials for local configured servers or issue short-lived TURN credentials from trusted service. Never expose long-lived TURN shared secret to clients.

### P1 — Embedded signaling server listens on 0.0.0.0
File: src/main/embedded-signaling.ts, AutoSignalingManager.startHttpServer.
Evidence: server binds to all IPv4 interfaces. Signed authentication is applied to API routes, but health and coordinator discovery routes are unauthenticated and LAN-exposed.
Impact: larger local-network attack surface; discovery/announcements are untrusted.
Remediation: prefer loopback by default unless LAN hosting is an intentional product requirement; if LAN use is required, document threat model and harden all reachable endpoints/discovery, with untrusted-LAN tests.

### P1 — Verify embedded session detail response contract
Files: src/main/embedded-signaling.ts GET /api/v1/sessions/:id; src/main/index.ts decideSession.
Evidence: embedded GET-session handler returns JSON.stringify(session), while decideSession expects response.session and response.peer. Need reproduce through actual caller to determine whether WAN incoming session approval fails on this path.
Remediation: add an end-to-end test for embedded WAN request -> host sees peer identity -> user approves/rejects -> requester sees outcome. Align response types deliberately; do not patch based solely on static inference.

## Partially verified / not established
- Signed HTTP API authentication exists in reviewed code, but the separate relay path does not apply equivalent verification.
- Peer fingerprint trust and signed offer/answer verification are implemented in Electron main process; tests still need to cover WAN-delivered malicious events end-to-end.
- STUN URLs are configured; arbitrary cross-NAT media is not proven. Real TURN-only tests with deployed TURN credentials are required.
- Screen sharing, native input, Windows-only system audio and file transfer are explicitly documented in README as not verified on real desktops / real clients.
- Unattended access is explicitly unavailable.
- CI builds six installable formats and validates artifacts; signed/notarized production release remains outstanding.
- Relay reconnection, pending-query cleanup, stale presence, slow request handling, rate limiting and long-poll resource use need soak/load testing.

## Remediation plan
P0:
1. Fix participant authorization in forwardSignal and closeSession.
2. Design and implement signed/authenticated WAN envelope with session binding, expiry and replay protection.
3. Add attacker-model tests for forged requests, forged decisions, replayed messages, cross-session signals and unauthorized teardown.
4. Add full embedded WAN approval E2E, including response-contract validation.

P1:
1. Remove static TURN credential fallback.
2. Decide and document loopback-vs-LAN binding; harden coordinator discovery.
3. Implement TURN-only WebRTC integration tests over a controlled test network.
4. Run real host/viewer tests on Windows, macOS and Linux, and clean-installer smoke tests.
5. Test reconnect, shutdown, stale presence, oversized inputs, slow clients and concurrency.

P2:
1. Add privacy-safe session diagnostics and correlation IDs.
2. Add soak tests and resource/latency baselines.
3. Complete signing/notarization and verify release provenance.
4. Clearly publish the tested platform and capability matrix.

## Reproducible CI commands
```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test -race -cover ./... && go vet ./...)
CHROME_PATH=/path/to/chrome npm run test:e2e
```
The repository's CI workflow ran these checks successfully at the reviewed commit. The commands were not executed locally during this remote audit.

## Changed files
None. No fix was committed because these findings require coordinated protocol/authentication changes and regression tests; implementing a partial untested patch remotely would not be responsible for a security-sensitive remote-control application.

