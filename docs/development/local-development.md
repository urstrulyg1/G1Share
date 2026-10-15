# Local development

## Prerequisites

- Node.js 22.12 or later and npm.
- Go 1.22 or newer for the signaling service.
- A desktop environment supported by Electron.
- An unlocked OS credential store for device authentication. Linux `basic_text` safeStorage is intentionally blocked; install/unlock GNOME Keyring/libsecret or KWallet.

## Run the desktop app and local signaling service

From the repository root:

```sh
npm ci
(cd services/signaling && go run .)
```

In a second terminal:

```sh
npm run dev
```

The Go service listens on `127.0.0.1:8787` by default and persists its device registry under `services/signaling/data` when launched from that directory. Check `/healthz` and `/readyz` with `curl`. This loopback setup is for development on one computer. Two devices on different computers need the same reachable HTTPS signaling origin.

Set `OPENDESK_SIGNALING_ADDR` to a valid host/port to change the Go listener. The app accepts plain HTTP only for loopback origins; non-loopback signaling URLs must use HTTPS. A production server should run behind a TLS reverse proxy. See [self-hosting](../self-hosting/signaling-and-turn.md).

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e   # two-client test: real Go signaling broker + two headless Chromium pages
npm run bench:latency   # loopback latency benchmark (needs CHROME_PATH); results go to docs/performance/results
npm audit --audit-level=high
(cd services/signaling && go test -race -cover ./... && go vet ./...)
```

The two-client test (`npm run test:e2e`) needs Go on `PATH` (or `GO_BIN`) and a Chrome or Chromium executable in `CHROME_PATH`. It builds `services/signaling`, starts it on `127.0.0.1:18787`, serves `e2e/harness` with Vite, and runs two isolated browser contexts. The pages execute the real `SignalingClient`, `RemoteSessionController`, `ViewerInputForwarder`, and host `RemoteInputController`. Three things are substituted: Electron's preload bridge (requests are signed with WebCrypto in the same canonical format as the main process), display capture (an animated canvas), and the native input library (a recording backend). The test does not exercise Electron, real screen capture, libnut injection, or TURN relay.

`npm run package:dir` builds an unpacked package for the current OS; `npm run dist` invokes configured electron-builder targets. The CI workflow successfully built unsigned Linux AppImage/DEB, Windows NSIS, and macOS DMG artifacts, but none has been install/launch-tested. Local package generation needs the Electron binary and platform tools; distribution still requires operator signing/notarization. Do not infer runtime support merely from a successful package build.

## Architecture during development

- `src/main`: identity, signing, trusted-key storage, OS prompts, signaling HTTP, and incoming file storage.
- `src/preload`: method-only IPC bridge.
- `src/renderer`: UI, signaling client state, WebRTC, and permission-gated file/clipboard protocols.
- `src/shared`: IPC/domain types and device-ID helpers.
- `services/signaling`: authenticated Go API, device registry, pairing/approval, event broker, WebRTC signal forwarding, and optional TURN credentials.

Use a separate user-data directory or genuinely separate OS user/installations for independent test identities. Two Electron processes sharing one user-data path are one device by design.

## Important limitations

- Unattended access, continuous clipboard sync, and trickle ICE are not implemented. Remote keyboard/mouse (libnut) and Windows loopback audio are implemented but unverified on real desktops.
- Screen capture is permission/source-picker based and has not been verified in a two-computer session. Linux Wayland depends on the desktop portal/PipeWire environment.
- File transfer tests use a simulated RTC data channel; they do not demonstrate browser-to-browser/WebRTC connectivity.
- Session/event queues and presence are in memory and are lost on signaling service restart. The public-key registry persists.
- A crash or forced power loss can leave a hidden `.opendesk-*.part` file in the chosen destination directory. Only remove such files after OpenDesk is closed.
- No signed updater/release, independent security audit, or production SLO is provided.
