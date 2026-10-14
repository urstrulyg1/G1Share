# Feature matrix — foundation release

| Capability | Status | Evidence / limitation |
|---|---|---|
| Electron + React desktop shell | Implemented | Source and build configuration added; CI must validate |
| Context-isolated preload bridge | Implemented | Device info, clipboard write, fixed project link |
| Local device identifier | Implemented | Random identifier stored in app user data |
| Copy local device ID | Implemented | Main-process clipboard integration |
| Home, devices, sessions, transfer, diagnostics, settings screens | UI implemented | Unavailable features are identified honestly |
| Local health service | Implemented | Go /healthz and /readyz |
| Health service unit tests | Implemented | go test ./... |
| Signaling / pairing | Not implemented | Health-only service is not a signaling server |
| Peer authentication / consent flow | Not implemented | Required before remote control |
| Screen capture / video encoding | Not implemented | OS-specific adapters required |
| Keyboard / mouse forwarding | Not implemented | OS-specific adapters required |
| Direct peer-to-peer transport | Not implemented | Transport decision pending |
| Relay / STUN / TURN | Not implemented | Infrastructure and protocol not integrated |
| File transfer | Not implemented | Secure resumable subsystem required |
| Clipboard synchronization | Not implemented | UI preference is not active synchronization |
| Multi-monitor streaming | Not implemented | Depends on capture engine |
| Unattended access | Not implemented | Requires identity and authorization design |
| Audio | Not implemented | Advanced milestone |
| Self-hosted production deployment | Not implemented | Service is health-only |
| Cross-platform installers | Not implemented | Packaging and verification required |
