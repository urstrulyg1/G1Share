# Architecture and data flow

## Components

```text
React renderer (untrusted UI)
  └── narrow contextBridge preload (validated IPC calls)
        └── Electron main process
              ├── safeStorage-backed Ed25519 identity and peer trust store
              ├── authenticated HTTPS/loopback signaling client
              ├── native display, clipboard, and save-destination prompts
              └── exclusive temporary-file store and verification

Go signaling service (self-hosted)
  ├── device registry (public keys and display metadata; persisted JSON)
  ├── one-use challenge and request-signature verification
  ├── session approval/permission state and bounded event queues (memory)
  ├── signed WebRTC setup-message forwarding
  └── optional expiring Coturn REST credentials

Peer A  ═════ WebRTC DTLS-SRTP media/data ═════  Peer B
                 direct ICE or TURN relay
```

## Device identity and trust

The app opens directly to the dashboard with no user-account gate. On first use, the Electron main process asks `safeStorage` to protect an Ed25519 private key. The public key is encoded as base64url; the device ID is a formatted 128-bit prefix of SHA-256 over that encoding. Linux refuses `basic_text` or unknown storage backends and blocks signaling if no usable OS credential store is available. No display-only device ID is generated when the key is unavailable; the dashboard instead shows **Unavailable**.

For each signaling API call, the client requests a 32-byte random challenge with a 30-second lifetime, signs a canonical request containing method, exact request URI, SHA-256 of the exact body bytes, and nonce, and sends the signature in headers. The service consumes the nonce once and verifies with the registered public key. New registration is tied to the ID/key; the service will not silently replace an existing key.

A first-time remote device is shown to the user with a SHA-256 fingerprint. The user should compare this fingerprint through a separate trusted channel before accepting the pin. Subsequent key changes are blocked pending deliberate removal of the old pin. Authentication of a signaling request is distinct from consent to a remote session.

## Consent and session sequence

1. The requester looks up a device ID and checks presence.
2. On first contact, the requester verifies and pins the peer fingerprint.
3. The requester sends a signed session-creation request for screen view and only explicitly selected optional permissions.
4. The receiving desktop displays the incoming request with each optional file, clipboard, input, and audio grant off by default and independently selectable when supported. Its main process re-fetches the pending session and peer key, checks the exact subset, and requires a native OS confirmation that lists the selected grants before the server can accept it. The receiver may reject or approve required view with any explicitly selected extras.
5. Only after approval does the host create a peer connection. It arms a short-lived capture request and waits for a separate user click.
6. Electron displays a native screen-source picker and OS permissions apply. No display capture begins before local source selection.
7. The host creates a WebRTC offer; the other device verifies the peer signal signature and pinned public key before processing the SDP. WebRTC negotiates DTLS-SRTP for media and data channels.
8. The receiving desktop chooses a destination for each incoming file. The sender and receiver have separate explicit clipboard confirmations for one-time text.
9. Either user can disconnect. Channel close stops tracks, closes peer connections, clears timers, and removes incomplete incoming temporary files where possible.

Session requests expire after 90 seconds. Accepted server sessions have a 24-hour ceiling and should still be closed promptly on disconnect. Events are delivered through bounded long polling. ICE credentials are short-lived when the TURN shared-secret mode is configured.

## Data channels

Two ordered data channels are used. `opendesk-input-v1` (high priority) carries remote keyboard, pointer, quality, and notice messages; they are small, validated on both ends, and never queue behind file data. `opendesk-data-v1` carries file and clipboard chunks. Input messages are rejected above 512 bytes or with unknown fields. Viewer quality requests are accepted by the host at most once per 500 ms.

File protocol metadata and binary chunks are validated in the renderer service. Files are limited to 1 GiB each, 16 files per batch, 16 KiB WebRTC chunks, and a 128 KiB send-queue ceiling (the sender waits above it). The latency benchmark measured the effect of the lower ceiling: see `docs/performance/README.md`. The main process independently limits IPC chunks, serializes writes per destination, verifies size and SHA-256, and exclusively publishes into the selected path without replacing an existing destination. Interrupted transfers use hidden `.opendesk-*.part` files until final verification.

Clipboard transfer is a one-time text message limited to 32 KiB for peer transport. The sender sees a native confirmation before clipboard read; the receiver sees a native confirmation before local clipboard replacement. No content is logged by the app.

## Trust boundaries and data held

- Renderer: account-free app UI, local preferences, verified-at-lookup device rows, and request/connection history; must be treated as untrusted for OS capabilities. Legacy local device/presence and session caches are discarded rather than presented as live data.
- Preload: narrow method-only bridge; no arbitrary filesystem, process, or shell method is exposed.
- Main process: private identity, local trust pins, native OS prompts, and selected file writes.
- Signaling service: public identity keys, names/platform/version, online timestamps in memory, pending sessions, and bounded event queues. It does not receive screen video or file contents.
- Peers and TURN: peers receive approved WebRTC media/data; TURN sees connection metadata and relays encrypted packets. It is not an application-level file or video decryptor.

## Current architectural gaps

Unattended access, an account/enrollment layer, push signaling, trickle ICE, session persistence across service restart, signed release/update infrastructure, and an independently reviewed native capture/input engine are not implemented. The Electron signaling protocol, screen capture, and WebRTC session path have not yet been validated between independently installed desktop clients.
