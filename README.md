# OpenDesk

OpenDesk is an account-free, consent-first desktop remote-viewing prototype built with Electron, React, TypeScript, and a self-hostable Go signaling service. It launches directly into the dashboard—no login, signup, cloud account, or identity provider. It uses a locally generated Ed25519 device identity, short-lived signed signaling requests, pinned peer fingerprints, explicit session approval, WebRTC DTLS-SRTP, and a user-selected screen source. Optional file transfer, one-time clipboard text, remote keyboard/mouse control, and Windows-only system audio are requested and approved independently per session.

**This is not yet a complete remote desktop product.** It does not support unattended access. Remote keyboard and mouse control and Windows system-audio sharing are implemented but have not been verified on real desktops; the two-client end-to-end test uses the real signaling broker and renderer services with substituted capture and native input. Do not treat a successful build or a simulated test as proof of working remote access on your hardware.

## Capability status

| Feature | Status |
|---|---|
| Dashboard / accounts | Opens directly to Home with no user login, signup, or cloud account; no default server is configured |
| Device identity and authenticated signaling | Implemented; Ed25519 key is encrypted with Electron safeStorage and Linux basic-text storage is refused; no device ID is shown as usable when the key is unavailable |
| Consent and peer identity | Implemented; remote user approves each session, selects optional permissions independently (off by default), verifies first-use fingerprints out of band, and selects a display separately |
| Screen sharing | Electron `getDisplayMedia` + WebRTC video path implemented; OS permission/source selection applies; real cross-device streaming is not verified |
| Remote keyboard and mouse | Implemented, per session, after the host separately enables control; X11 Linux, Windows, and macOS (macOS needs Accessibility access); Wayland is refused; the Linux native library needs `libXtst`; not verified on real desktops |
| Audio | Implemented for Windows hosts only (Electron loopback capture, requires the audio permission); macOS and Linux hosts refuse it; not verified on real desktops |
| Unattended access | **Unavailable**; no background access or hidden persistence is implemented |
| File transfer | WebRTC data-channel protocol and main-process storage are implemented with bounded chunks, explicit destination choice, SHA-256 checks, and no-overwrite publication; tested with simulated channels, not real clients |
| Clipboard | One-time text only; sender and receiver each confirm locally; continuous synchronization is unavailable |
| Signaling | Configurable, self-hosted Go HTTP service with authenticated device requests, pairing/session approval, signed WebRTC setup messages, event polling, and optional ephemeral TURN credentials; no user accounts |
| Local devices / history | Devices come from real ID lookups in the current app run; presence expires rather than being persisted as online. Recent requests use real session events and show a connected time only after WebRTC actually connects. Legacy unverified browser caches are not imported. |
| Metrics | Only browser WebRTC statistics and frame callbacks; absent values show **Unavailable**, never default numbers |
| Installers | Unsigned Linux AppImage/DEB, Windows NSIS, and macOS DMG targets built in GitHub CI; installation/runtime validation and signed releases remain outstanding |

Platform-specific observations and verification status are in [the feature matrix](docs/testing/feature-matrix.md).

## Development quick start

Requirements: Node.js 22.12 or later, npm, Go 1.22 or later, and a desktop environment supported by Electron. On Linux, an unlocked GNOME Keyring/libsecret or KWallet is required for the device key.

```sh
npm ci
(cd services/signaling && go run .)
# In another terminal:
npm run dev
```

On first launch, the Home dashboard appears with **Signaling not configured**. For same-computer development, open **Settings → Signaling service** and enter `http://127.0.0.1:8787`; the local Go service listens there by default. Alternatively set `OPENDESK_SIGNALING_URL=http://127.0.0.1:8787` in the desktop process environment before first launch. You do **not** need a user account. Unlock your OS credential store so the app can generate its actual device key/ID; if it cannot, it shows **Unavailable** and blocks connections instead of displaying a fake identifier. The same loopback address on two computers refers to two different services. See [local development](docs/development/local-development.md) and [the two-client checklist](docs/user/getting-started.md).

## Self-hosting

For a TLS-terminated signaling deployment and optional Coturn TURN relay, start with [the self-hosting guide](docs/self-hosting/signaling-and-turn.md). Set the **same reachable HTTPS origin** on both devices. On a LAN, peers can communicate directly via WebRTC host candidates when ICE allows it, but this build still needs a shared signaling service: it has **no automatic LAN discovery or no-server pairing**. The repository includes a Go service Dockerfile, a Caddy reverse-proxy Compose configuration, and a separate optional Coturn Compose overlay. Internet connections need appropriate STUN/TURN and firewall configuration; neither LAN nor Internet access requires a cloud account. Generate unique TURN credentials on the server; do not commit `.env` files or signing keys.

The Go service is plain HTTP and defaults to loopback. Do not expose it directly to the public internet. The sample Compose stack sets the service behind Caddy and restricts forwarded-client-IP trust to Caddy's fixed container address.

## Build, test, and package

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test ./... && go test -race -cover ./... && go vet ./...)
CHROME_PATH=/path/to/chrome npm run test:e2e  # also requires Go; two isolated clients + real broker
```

Package configuration is available through `npm run package:dir` (unpacked build for the current OS) and platform distribution scripts:
- `npm run dist:mac` — builds macOS `.dmg` installers for both **`arm64`** (Apple Silicon) and **`x64`** (Intel).
- `npm run dist:win` — builds Windows NSIS `.exe` installers for both **`x64`** and **`arm64`**.
- `npm run dist:linux` — builds Linux **`x64`** `.AppImage` and `.deb` packages.

### Automated GitHub Releases
Pushing a version tag (`git tag v0.1.0 && git push origin v0.1.0`) triggers the automated release pipeline in `.github/workflows/release.yml`. It compiles and verifies all platforms, generates SHA-256 checksums (`SHA256SUMS.txt`), auto-generates release notes, and publishes the release directly with all `.exe`, `.dmg`, `.AppImage`, and `.deb` binaries attached.

## Security model and limitations

- Device IDs locate devices; they are not passwords. Session requests are authenticated by a one-use challenge signed with the local Ed25519 key.
- A first-time peer key must be verified out of band. The app pins trusted peer fingerprints and blocks a changed key until the old pin is deliberately removed.
- A session request is not access. The receiving user approves it in the app and a main-process native confirmation lists the exact grants; screen capture then needs a separate local source selection. Files and clipboard require separately granted session permissions.
- Media and data channels use Chromium WebRTC (DTLS-SRTP). The signaling server carries setup metadata, not screen video. TURN relays encrypted WebRTC traffic but can observe connection metadata.
- The signaling registry stores device public keys and display metadata. Session and event queues are in memory; presence is not persisted. No user-account system, login route, or administrator enrollment flow is included. No server URL is silently substituted if configuration is missing or invalid.
- Resetting identity explicitly revokes the registered device (when registered) and creates a new local key/ID. Trust records for other peers remain local.
- No independent security audit, signed release, Windows/macOS package test, or real two-client desktop operation has been completed.

Read the [threat model](docs/security/threat-model.md) before deployment. Report security issues privately to the project maintainers rather than posting exploit details publicly.

## Documentation

- [Getting started and two-client test procedure](docs/user/getting-started.md)
- [Troubleshooting](docs/user/troubleshooting.md)
- [Architecture and data flow](docs/architecture/architecture.md)
- [Architecture decisions](docs/architecture/architecture-decisions.md)
- [Local development](docs/development/local-development.md)
- [Self-hosting signaling and TURN](docs/self-hosting/signaling-and-turn.md)
- [Threat model](docs/security/threat-model.md)
- [Feature / platform matrix and test evidence](docs/testing/feature-matrix.md)
