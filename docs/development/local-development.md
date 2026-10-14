# Local development

## Prerequisites

- Node.js 22 or a supported LTS compatible with the desktop toolchain.
- npm.
- Go 1.22 or newer for the health service.
- A supported desktop development environment for Electron.

## Desktop shell

Run npm install, then npm run dev.

Validate with npm run typecheck, npm run build, and npm test.

The shell creates a local device identifier and supports copy-ID and local diagnostics. Remote desktop connections are intentionally not implemented in this milestone.

## Signaling health service

From services/signaling, run go test ./... and go run .

By default the service binds to 127.0.0.1:8787. Check /healthz and /readyz with curl. Set OPENDESK_SIGNALING_ADDR to override the local listen address. Do not expose this health-only service publicly.

## Current limitations

- The Go service provides health endpoints only; it is not a signaling broker.
- No real remote session can be established.
- Screen capture, remote input, file transfer, clipboard synchronization, multi-monitor streaming, NAT traversal, TURN, unattended access, and audio are not implemented.
- Theme and settings toggles are transient and are not persisted.
