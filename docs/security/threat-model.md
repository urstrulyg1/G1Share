# OpenDesk threat model

Status: implementation prototype, not an independent security audit. This document describes controls present in source and known gaps; it does not certify production readiness.

## Scope and assets

Protected assets include device private keys, trusted peer pins, screen/audio/input data, transferred files, clipboard contents, local session metadata, the signaling registry, TURN credentials, and release integrity. Audio and remote input are not implemented. This threat model covers Electron, the signaling API, WebRTC setup, file/clipboard features, and self-hosting assumptions.

## Actors and trust boundaries

1. **Renderer UI** — treated as untrusted for privileged operations, even though it is packaged with the app.
2. **Preload bridge** — narrowly exposes methods; no arbitrary filesystem, shell, or process API.
3. **Electron main process** — holds identity signing capability, safeStorage integration, network requests, native consent dialogs, display selection, clipboard prompts, and file handles.
4. **Signaling service and reverse proxy** — routes authenticated metadata and WebRTC setup; does not receive screen media or file contents.
5. **Peer device** — may send malformed protocol messages, file frames, clipboard text, or SDP.
6. **TURN relay** — can observe IP/connection metadata and relay packets, but WebRTC DTLS-SRTP protects the media/data payload from relay inspection.
7. **Host OS, user account, and administrator** — trusted. Malware with access to the logged-in account, unlocked keyring, or process memory is outside the protection provided by the app.

## Implemented controls

- Electron context isolation, sandbox, disabled Node integration, web security, restrictive CSP, denied new windows, and main-frame/sender validation for IPC.
- Narrow typed preload API; privileged functions validate IPC values and transfer tokens. Generic signaling IPC cannot accept or revoke a session; main-process approval re-fetches the pending request, checks the peer identity, and presents an OS-native confirmation listing the exact grants.
- Ed25519 device key protected with OS `safeStorage`; Linux basic-text/unknown backend is refused. Device ID is derived from the public key and does not authorize access.
- Short-lived single-use signed API challenges; server binds registered ID to key and rejects key substitution, replay, invalid permissions, unauthorized session roles, and invalid signed WebRTC signals.
- First-use peer fingerprint warning, local key pinning, and changed-key refusal. User should compare fingerprints out of band.
- Explicit remote approval per session (with a main-process native confirmation of the exact permission set), explicit local display-source selection, optional file/clipboard permission selection, per-file destination approval, and native sender/receiver clipboard confirmations.
- WebRTC DTLS-SRTP; bounded JSON/SDP/signaling bodies, response streaming limits, data-channel buffers/chunks, sequence numbers, file sizes, clipboard text, event queues, service headers, timeouts, and rate limits.
- Incoming files use per-transfer serialization, hidden private temporary files, byte-count/SHA-256 checks, exclusive hard-link publication, and no-overwrite semantics. Disconnect/cancel cleanup reports failures where possible.
- HTTPS required for non-loopback app signaling endpoints. Go service binds to loopback by default and sample deployment places it behind Caddy. Forwarded IP headers are trusted only from explicitly configured proxy addresses.
- Identity reset uses a native confirmation, attempts server-side revocation before deleting the local key, and creates a new key/ID. If the server cannot be reached for a registered device, reset is blocked rather than silently leaving the old server registration active.

## Threats considered

- **Unauthorized access from a guessed/shared ID:** IDs are public locators; API calls require a valid signature, and the target must explicitly approve each session.
- **Signaling-server payload substitution:** API challenge signatures authenticate requests; peer SDP is separately signed and verified against a trusted peer key. HTTPS protects the client/server connection in transit.
- **Peer key substitution:** first-use fingerprints require out-of-band verification; subsequent changes are blocked pending explicit trust removal.
- **Malicious peer file/path data:** the renderer never receives an arbitrary destination path. The OS save dialog chooses a path; the main process writes only to a private temporary file and links into an absent destination after verification.
- **Oversized or malformed network input:** request/response bodies, messages, frames, queues, transfer sizes, waits, and registries are bounded; protocol violations close the data channel/session where appropriate.
- **Clipboard exfiltration:** clipboard reads/writes require explicit native confirmation; only bounded one-time text is supported; contents are not logged by app code.

## Important residual risks and gaps

- No independent penetration test, formal security review, vulnerability disclosure contact/process, signed updater, signed/notarized release, or SBOM attestation is present.
- No account system, admin enrollment policy, enterprise policy, central peer approval policy, or global abuse monitoring. Public device registration is open; knowing an ID can allow nuisance requests even though it does not grant access. The broker applies per-IP/per-device rate limits and quotas, but operators still need monitoring and network controls.
- The registry is a single JSON file protected by filesystem permissions, not encrypted at rest or replicated. Session/event state is in memory; a process restart drops it.
- The HTTP signaling service relies on correct HTTPS reverse-proxy and trusted-proxy configuration. A bad proxy/CIDR setup can break rate limits or expose HTTP; deployment must be reviewed.
- WebRTC gathers candidates in one step rather than trickling; ICE/STUN/TURN and screen capture are not verified across real networks/platforms. TURN metadata is visible to the relay; route policy and retention depend on the operator.
- Remote keyboard/mouse, audio, unattended access, mobile support, and a native input/capture engine are not implemented.
- Device identity and trust-store recovery is not resilient to OS keyring loss. Backups/export of private keys are deliberately not provided.
- A hard crash or power loss can leave a hidden `.opendesk-*.part` file in the selected directory. Startup cleanup does not scan arbitrary user directories.
- `safeStorage` protects keys at rest but does not defend against malware running as the same user while the keyring is unlocked.

## Deployment and release rules

- Do not expose the plain Go listener publicly. Use HTTPS, restrict trusted proxies exactly, keep data/private environment files private, back up the registry securely, and configure firewall/turn-server policies.
- Never commit private keys, `.env`, TURN shared secrets, signing identities, user file data, clipboard data, or real session logs.
- Do not describe remote input, audio, unattended access, signed installers, or untested platforms as working.
- A passing unit test, build, or simulated RTC data-channel test is not end-to-end evidence. Require two independently installed clients and real network/platform validation before claiming the primary remote-desktop acceptance criterion is met.
