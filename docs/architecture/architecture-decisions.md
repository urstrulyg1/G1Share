# OpenDesk architecture decisions

Status: implementation prototype. Decisions are provisional until a complete two-client session and platform packaging are verified.

## ADR-001: Desktop shell and renderer isolation

**Decision:** Electron, React, and TypeScript, with privileged capabilities owned by the Electron main process.

**Controls:** context isolation, sandbox enabled, Node integration disabled, web security enabled, restrictive renderer CSP, denied new windows, narrow preload methods, and sender/frame checks on IPC.

**Consequence:** the renderer cannot use arbitrary filesystem or shell APIs. File destinations, device keys, clipboard prompts, capture prompts, and HTTP signaling are handled in the main process. The generic signaling bridge cannot accept or revoke sessions; acceptance is revalidated against the server and confirmed by a native dialog listing the exact permissions. Keep preload additions narrowly scoped and validate every IPC value at the privileged boundary.

## ADR-002: Separate signaling service

**Decision:** a Go HTTP service with an in-memory session/event broker and a persisted device registry.

**Authentication:** a short-lived, one-use challenge is signed by an Ed25519 device key. Device registration binds the key to the device ID. Signaling messages are separately signed and checked by the broker and the peer. HTTPS is required for non-loopback server URLs; the Go service itself does not terminate TLS.

**Consequence:** self-hosters must configure HTTPS termination, persistent protected registry storage, backups, and rate-limit/network policy. Presence, sessions, and event queues are process-local; service restarts require clients to reconnect and recreate requests.

## ADR-003: WebRTC for media and peer data

**Decision:** use Chromium WebRTC for screen-video transport and optional ordered data-channel transfer, with standard ICE/STUN/TURN negotiation and DTLS-SRTP. Do not implement custom media encryption or relay protocols.

**Current implementation:** screen capture uses Electron `getDisplayMedia` after session approval and local source selection. Data channels support chunked file transfer and one-time clipboard text. STUN/TURN URLs and short-lived HMAC-SHA1 TURN REST credentials can be supplied by the signaling service.

**Not implemented:** remote keyboard/mouse injection, system audio, continuous clipboard synchronization, unattended sessions, trickle ICE, and a native remote-desktop engine. One-shot ICE gathering and cross-platform capture behavior still need real-network validation.

## ADR-004: Device identity is cryptographic, not a shared secret

**Decision:** generate an Ed25519 key pair. The 128-bit device ID is derived from the public-key encoding. Store the private key encrypted with Electron `safeStorage`; refuse Linux `basic_text`/unknown storage backends. The public key and display metadata are registered with the signaling service.

A device ID alone grants no access. Trust of the remote key is explicit and should be confirmed through a separate channel on first contact. Session approval is still required on every connection.

## ADR-005: Honest capability reporting

Do not present unavailable capabilities as working. The UI and docs identify remote input, audio, unattended access, and unsupported platform paths. A successful build or unit test is not evidence of a real end-to-end desktop session.

## ADR-006: File storage is exclusive and integrity checked

**Decision:** receive into a random hidden temporary file in the user-selected destination directory, serialize IPC writes, verify byte count and SHA-256, then publish by an exclusive hard link. Existing destination files are never overwritten. Cancellation and session teardown remove temporary data and report cleanup failures.

**Consequence:** destinations must reside on a filesystem supporting same-directory hard links. A process crash or forced power loss may leave a hidden `.opendesk-*.part` file; users should inspect and remove one only after confirming OpenDesk is closed.

## ADR-007: Documentation is part of the implementation

User, developer, architecture, self-hosting, security, troubleshooting, testing, and platform-support docs are maintained with the code. There are no embedded production keys, TURN secrets, or signing certificates.
