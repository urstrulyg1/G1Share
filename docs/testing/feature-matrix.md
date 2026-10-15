# Feature and platform verification matrix

This matrix separates implemented source from exercised end-to-end behavior. **No real two-computer desktop session has been demonstrated yet.** Do not interpret a configured API, test fake, or successful build as an end-to-end pass.

## Capabilities

| Capability | Source status | Evidence / remaining validation |
|---|---|---|
| Electron + React desktop shell | Implemented | Typecheck and Vite/Electron bundle build; running packaged Electron app still needs platform validation |
| Isolated renderer and narrow preload | Implemented | Static configuration and IPC validation paths reviewed; generic signaling cannot approve/revoke; session approval re-fetches and prompts natively; no dedicated Electron security integration test |
| Ed25519 local device identity | Implemented | `safeStorage`, key-derived ID, Linux basic-text refusal, main-process identity reset/revocation; no OS keyring matrix test |
| Authenticated signaling requests | Implemented | Go integration tests exercise registration, pairing, consent, signed WebRTC setup, replay/tampering, and close with independent Ed25519 test identities; TypeScript SignalingClient unit tests cover route/permission validation |
| Peer fingerprint trust | Implemented | Main-process fingerprint pinning/changed-key dialogs; requires real UI/keyring validation |
| Go signaling broker | Implemented prototype | HTTP health/API, bounded requests, auth challenges, permission approval, long-poll events, rate limits, persistent device registry; current PR CI passed Go race tests/coverage and `go vet`. Go is not installed locally. |
| STUN/TURN configuration | Implemented as operator-provided ICE settings | Go emits configured STUN endpoints and expiring TURN REST credentials; Coturn/reverse-proxy/firewall interoperability not tested here |
| Screen capture and WebRTC video | Implemented source path | Native source picker, `getDisplayMedia`, signed SDP, DTLS-SRTP; **no actual cross-device stream verified** |
| Remote keyboard/mouse | Not implemented | UI, README, and capability API explicitly identify unavailable behavior |
| Audio capture/playback | Not implemented | Explicitly reported unavailable |
| Unattended access | Not implemented | No hidden persistence or background capture |
| File-transfer protocol | Implemented | Vitest uses paired simulated data channels to transfer >300 KiB, sequence/ack handling, permission check, refusal, cancellation, and SHA-256 mismatch cleanup |
| Main-process file storage | Implemented | Node filesystem tests exercise temp writes, serial concurrent IPC writes, hash verification, cancellation, existing-destination rejection, and destination-creation race |
| Clipboard | Implemented, one-time text only | Native confirm-before-read/replace code; no real cross-device clipboard test |
| Local device/history UI | Implemented | UI source; no visual/browser/electron interaction test |
| Diagnostics | Implemented | Shows actual app/signaling/session capabilities; no fabricated WebRTC metrics |
| Self-host deployment | Configured | Go Dockerfile, Caddy Compose, optional Coturn overlay and docs; Docker deployment not run in this sandbox |
| Linux/Windows/macOS installers | Unsigned builds passed in CI; runtime unverified | GitHub Actions built Linux AppImage/DEB, Windows NSIS, and macOS DMG targets and uploaded `opendesk-ubuntu-latest`, `opendesk-windows-latest`, and `opendesk-macos-latest` artifacts (14-day retention). No install/launch test or signed release was produced. Local `npm run package:dir` could not fetch Electron in this sandbox. |
| CI | Passed for this PR | Node/Go verification plus unsigned Linux/Windows/macOS package jobs all passed; installers were uploaded as workflow artifacts |

## Platform support statement

| Platform | Electron shell/build | Screen capture path | Credential storage | Remote input/audio |
|---|---|---|---|---|
| Windows | Unsigned NSIS target built in CI; install/launch not tested | Electron display capture path is implemented; OS-specific verification pending | Electron safeStorage/DPAPI path is implemented; not tested on Windows here | Unavailable |
| macOS | Unsigned DMG target built in CI; install/launch not tested | Screen Recording permission and native picker path is present; actual permission flow not tested here | Electron safeStorage/Keychain path is implemented; not tested on macOS here | Unavailable |
| Linux X11 | Unsigned AppImage/DEB targets built in CI; install/launch not tested | Electron capture path is present; X11 session required; actual stream not tested | Requires a real GNOME Keyring/libsecret or KWallet backend; `basic_text` is blocked | Unavailable |
| Linux Wayland | Unsigned Linux targets built in CI; install/launch not tested | Requires a working desktop portal/PipeWire source picker; distro/compositor combinations vary and remain unverified | Same OS keyring requirement as Linux X11 | Unavailable |
| iOS / Android | Not supported | Not supported | Not supported | Not supported |

The matrix does not certify a platform merely because source code compiles. Screen capture, credential storage, packaging, code signing, accessibility/input permissions, and real peer connectivity must be tested on each OS/compositor combination.

## Test commands and evidence

Run from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test -race -cover ./...)
(cd services/signaling && go vet ./...)
```

The latest local desktop validation passed `npm run typecheck`, `npm test` (**5 files, 26 tests**), `npm run build`, and both full and production-only npm audits (zero reported vulnerabilities). For PR #2, GitHub Actions also passed Go race tests/coverage, `go vet`, and unsigned Linux AppImage/DEB, Windows NSIS, and macOS DMG builds. The local sandbox has no Go or Docker executable; Compose files parse as YAML, but an actual Compose deployment was not run. A local `npm run package:dir` attempt could not fetch Electron under the sandbox's outbound-host restrictions; no local package artifact was produced.

The automated tests use unit-level Node/Vitest and Go `httptest` integration; the Go test creates two independent cryptographic identities and exercises authenticated HTTP signaling, but does **not** start Electron, WebRTC, OS screen capture, or a real TURN relay. File-transfer channel tests use an in-memory linked `RTCDataChannel` stand-in. Main-process filesystem tests use actual temporary files on the current host.

## Required next verification

1. Build and install unsigned/signature-configured packages on Windows, macOS, Linux X11, and representative Wayland desktops.
2. With two independent user-data profiles/devices and a production-like HTTPS signaling+TURN deployment, verify first-contact fingerprint checks, session approval/rejection, screen streaming, reconnect/disconnect, file transfer and partial cleanup, and one-time clipboard consent.
3. Verify firewalls and TURN relay behavior from at least two different NATs, including restrictive TCP/TLS-only networks if those are claimed as supported.
4. Review release signing/notarization, updater design, backup/restore, incident handling, and the threat model before calling the product production-ready.
