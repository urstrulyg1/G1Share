# OpenDesk

OpenDesk is a consent-first desktop remote-viewing prototype built with Electron, React, TypeScript, and a self-hostable Go signaling service. It uses Ed25519 device identities, short-lived signed signaling requests, pinned peer fingerprints, explicit session approval, WebRTC DTLS-SRTP, and a user-selected screen source. Optional WebRTC data-channel features include file transfer and one-time clipboard text.

**This is not yet a complete remote desktop product.** It does not send remote keyboard or mouse input, stream system audio, or support unattended access. The current source has not been verified in a real two-computer desktop session. Do not treat a successful build or a simulated data-channel test as proof of working end-to-end remote access.

## Capability status

| Feature | Status |
|---|---|
| Device identity and authenticated signaling | Implemented; Ed25519 key is encrypted with Electron safeStorage and Linux basic-text storage is refused |
| Consent and peer identity | Implemented; remote user approves each session, optional permissions are separately granted, first-use fingerprints should be checked out of band |
| Screen sharing | Electron `getDisplayMedia` + WebRTC video path implemented; OS permission/source selection applies; real cross-device streaming is not verified |
| Remote keyboard and mouse | **Unavailable**; no input injection is implemented |
| Audio | **Unavailable**; no system-audio capture or playback is implemented |
| Unattended access | **Unavailable**; no background access or hidden persistence is implemented |
| File transfer | WebRTC data-channel protocol and main-process storage are implemented with bounded chunks, explicit destination choice, SHA-256 checks, and no-overwrite publication; tested with simulated channels, not real clients |
| Clipboard | One-time text only; sender and receiver each confirm locally; continuous synchronization is unavailable |
| Signaling | Go HTTP service with authenticated requests, pairing/session approval, signed WebRTC setup messages, event polling, and optional ephemeral TURN credentials |
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

The local signaling service binds to `127.0.0.1:8787` by default, and the desktop app uses that origin for development. The same loopback address on two different computers refers to two different services; use a reachable HTTPS signaling deployment for multi-computer tests. See [local development](docs/development/local-development.md) and [the two-client checklist](docs/user/getting-started.md).

## Self-hosting

For a TLS-terminated signaling deployment and optional Coturn TURN relay, start with [the self-hosting guide](docs/self-hosting/signaling-and-turn.md). The repository includes a Go service Dockerfile, a Caddy reverse-proxy Compose configuration, and a separate optional Coturn Compose overlay. Generate unique TURN credentials on the server; do not commit `.env` files or signing keys. Public deployment requires HTTPS and an operator-managed firewall, DNS, storage, and TURN configuration.

The Go service is plain HTTP and defaults to loopback. Do not expose it directly to the public internet. The sample Compose stack sets the service behind Caddy and restricts forwarded-client-IP trust to Caddy's fixed container address.

## Build, test, and package

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
(cd services/signaling && go test -race -cover ./... && go vet ./...)
```

Package configuration is available through `npm run package:dir` (unpacked build for the current OS) and `npm run dist` (platform targets configured in `package.json`). Native package generation needs the Electron binary and platform packaging tools; installers are unsigned unless an operator configures signing outside this repository. Current verification results and blockers are recorded in [the feature matrix](docs/testing/feature-matrix.md).

## Security model and limitations

- Device IDs locate devices; they are not passwords. Session requests are authenticated by a one-use challenge signed with the local Ed25519 key.
- A first-time peer key must be verified out of band. The app pins trusted peer fingerprints and blocks a changed key until the old pin is deliberately removed.
- A session request is not access. The receiving user approves it in the app and a main-process native confirmation lists the exact grants; screen capture then needs a separate local source selection. Files and clipboard require separately granted session permissions.
- Media and data channels use Chromium WebRTC (DTLS-SRTP). The signaling server carries setup metadata, not screen video. TURN relays encrypted WebRTC traffic but can observe connection metadata.
- The signaling registry stores device public keys and display metadata. Session and event queues are in memory; presence is not persisted. No user-account system or administrator enrollment flow is included.
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
