# Feature and platform verification matrix

This matrix separates implemented source from exercised end-to-end behavior. **No real two-computer desktop session has been demonstrated yet.** A configured API, test fake, or successful build does not establish an end-to-end pass.

## Capabilities

| Capability | Source status | Evidence / remaining validation |
|---|---|---|
| Account-free dashboard | Implemented | Starts on Home without login/signup; no server configured by default. UI tests cover honest unconfigured, unavailable-identity, empty/error, and session-consent states. |
| Isolated renderer and narrow preload | Implemented | Static configuration and IPC validation paths reviewed; generic signaling cannot approve/revoke; session approval re-fetches and prompts natively; no dedicated Electron security integration test. |
| Ed25519 local device identity | Implemented | OS `safeStorage`, key-derived ID, Linux basic-text refusal, main-process identity reset/revocation. Unavailable key means unavailable ID, not a dummy ID. No OS keyring matrix test. |
| Authenticated signaling | Implemented | Go integration tests cover registration without accounts, pairing, per-session consent, signed WebRTC setup, replay/tampering, and close with independent keys; TypeScript client unit tests cover route/permission validation. |
| Peer fingerprint trust | Implemented | Explicit local fingerprint pinning, changed-key refusal, revocation, malformed trust-store fail-closed behavior. Requires real UI/keyring validation. |
| Go signaling broker | Implemented prototype | HTTP health/API, bounded requests, auth challenges, permission approval, long-poll events, rate limits, persistent public-key registry; Go tests/race and vet must be checked in CI if Go is not available locally. |
| STUN/TURN configuration | Operator-provided ICE settings | Go emits configured STUN endpoints and expiring TURN REST credentials; Coturn/reverse-proxy/firewall interoperability not tested here. |
| Screen capture and WebRTC video | Implemented source path | Native source picker, `getDisplayMedia`, signed SDP, DTLS-SRTP; **no actual cross-device stream verified**. |
| Remote keyboard/mouse | Implemented; hardware unverified | Shared protocol with strict validation and key allowlist; host-side controller tested with a fake native backend. Two-client browser E2E covers move/click/key delivery, revocation and disconnect releases, rejection while disabled. Native libnut injection and OS permission flows need real desktop testing. |
| Audio capture/playback | Implemented for Windows hosts; hardware unverified | Loopback capture requested only when approved on a Windows host; missing OS audio tracks are reported. No real audio path tested. Viewer playback uses a real remote audio track. |
| Unattended access | Not implemented | No hidden persistence or background capture. |
| File-transfer protocol | Implemented | Vitest tests linked simulated data channels for >300 KiB transfer, sequence/ack, permission, refusal, cancellation, and SHA-256 mismatch cleanup. |
| Main-process file storage | Implemented | Node filesystem tests cover temp writes, concurrent IPC, hashes, cancellation, collision rejection, and destination-creation race. |
| Clipboard | Implemented, one-time text only | Native confirm-before-read/replace code; no real cross-device clipboard test. |
| Local devices and history | Implemented | Device rows come from this run's actual lookups; presence expires and server gaps show unknown. History records real requests, with connected time only after WebRTC connects; legacy unverified cache is discarded. Unit and UI tests cover both. |
| Diagnostics | Implemented | Actual app/signaling/session capabilities and browser statistics; missing counters or inactive streams show unavailable rather than a made-up number or live state. |
| Self-host deployment | Configured | Go Dockerfile, Caddy Compose, optional Coturn overlay and docs; Docker deployment not run in this sandbox. |
| Linux/Windows/macOS installers | Previously built unsigned in CI; runtime unverified | Previous workflow built Linux AppImage/DEB, Windows NSIS, and macOS DMG targets. Current changes need fresh CI and platform runtime validation. No signed release. |

## Platform support statement

| Platform | Electron shell/build | Screen capture path | Credential storage | Remote input/audio |
|---|---|---|---|---|
| Windows | Unsigned NSIS target built previously; install/launch not tested | Electron display capture path; OS-specific verification pending | safeStorage/DPAPI path; not tested on Windows here | libnut input and loopback audio implemented; not tested on Windows here |
| macOS | Unsigned DMG target built previously; install/launch not tested | Screen Recording permission and native picker path present; flow untested | safeStorage/Keychain path; not tested on macOS here | input requires Accessibility access (implemented, untested); audio unavailable |
| Linux X11 | Unsigned AppImage/DEB targets built previously; install/launch not tested | Electron capture path; X11 session required; actual stream untested | Requires GNOME Keyring/libsecret or KWallet; `basic_text` blocked | libnut input needs `libXtst` at runtime; untested; audio unavailable |
| Linux Wayland | Unsigned Linux targets built previously; install/launch not tested | Requires desktop portal/PipeWire source picker; unverified across compositors | Same keyring requirement | Input refused; audio unavailable |
| iOS / Android | Not supported | Not supported | Not supported | Not supported |

Compilation does not certify screen capture, credential storage, packaging, code signing, accessibility permissions, or peer connectivity on any platform.

## Test commands and evidence

Run from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test ./... && go test -race -cover ./... && go vet ./...)
CHROME_PATH=/path/to/chrome npm run test:e2e  # also requires Go
```

For this change, local `npm run typecheck`, `npm test` (16 files, 120 tests), `npm run build`, and `npm audit --audit-level=high` passed, with zero vulnerabilities reported. Go and Chrome/Chromium were not available in the initial local environment; Go race and two-client E2E results should be recorded after CI rather than assumed. The two-client suite drives separate browser clients against a real Go broker but uses simulated screen capture and native-input hooks: it cannot certify real OS capture or injection. The linked data-channel tests use stand-ins. Main-process storage tests use real temporary files.

## Required next verification

1. Build and install packages on Windows, macOS, Linux X11, and representative Wayland desktops; test actual OS keyrings and permission prompts.
2. Use two independent profiles/devices and a production-like HTTPS signaling+TURN deployment to verify fingerprint checks, consent/rejection, screen streaming, reconnect/disconnect, files/cleanup, and one-time clipboard consent.
3. Verify TURN relay from distinct NATs and restrictive networks before claiming Internet interoperability.
4. Review release signing/notarization, updater design, backup/restore, incident handling, and the threat model before calling the product production-ready.
