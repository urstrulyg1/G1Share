# OpenDesk architecture decisions

Status: initial foundation. Decisions remain revisable until the remote-session prototype is validated.

## ADR-001: Desktop shell and renderer isolation

Decision: Electron, React, TypeScript, and electron-vite.

Rationale: enables cross-platform UI iteration while privileged operations remain in the main process. The renderer uses a narrow preload bridge with context isolation, sandboxing, and Node integration disabled.

Consequence: native capture and input must be implemented behind a dedicated native-engine boundary.

## ADR-002: Separate signaling service

Decision: start with a small Go service.

Current scope: health and readiness endpoints only. It does not perform signaling, pairing, NAT traversal, relay, authentication, or remote sessions.

## ADR-003: Evaluate established transport first

Evaluate WebRTC/ICE/STUN/TURN and existing remote-desktop engines before selecting transport. Compare against custom TCP/QUIC and mature open-source engine integration using security, NAT behavior, platform support, latency, licensing, maintenance, and operating cost.

No transport has been selected or integrated yet.

## ADR-004: Device ID is not a credential

Generate a random local identifier and store it in app user data. The ID identifies a device but must never authorize access. Device authentication and session authorization remain future work.

## ADR-005: No misleading capabilities

Remote control, file transfer, and session history must explicitly state when their underlying subsystem is not implemented. Do not show fake sessions, latency, transfer progress, or connection success.

## ADR-006: Avoid overwriting README

Implementation notes live under docs until an explicit README change is requested.
