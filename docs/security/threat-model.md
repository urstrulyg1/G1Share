# OpenDesk threat model — initial foundation

## Scope

This document covers the current Electron shell and health-only Go service. It is not a security review of a remote-control protocol; no such protocol exists yet.

## Assets

- Local device identifier.
- Future device credentials and session keys.
- Screen and input data when remote sessions exist.
- Clipboard contents and transferred files when those features exist.
- Application update and release integrity.

## Trust boundaries

1. Renderer UI: untrusted for privileged operations.
2. Electron preload: narrow IPC boundary.
3. Electron main process: local OS integration.
4. Signaling service: currently health endpoints only.
5. Future peer and relay services: not implemented.

## Current controls

- Context isolation, renderer sandboxing, and disabled Node integration.
- Content Security Policy in the renderer document.
- New-window navigation denied.
- IPC handlers validate input types and clipboard length.
- External URL opening is limited to a fixed project URL.
- Device ID uses cryptographically secure random bytes.
- Local identity requests restrictive POSIX file permissions.
- Go HTTP server has request timeouts and bounded headers.
- Service binds to loopback by default.

## Known gaps

- No peer authentication or session authorization.
- No screen capture or remote input engine.
- No signaling protocol, NAT traversal, relay, or end-to-end media encryption.
- No unattended access, credential rotation, or revocation.
- No secure updater or signed release artifacts.
- Settings switches are transient UI preferences, not security controls.
- Remote fonts and remote network dependencies should not be required by production builds.

## Release rule

Do not expose the current service publicly or describe this as a secure remote-control product until authentication, protocol security, authorization, abuse limits, and security testing are implemented and reviewed.
