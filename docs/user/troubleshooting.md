# Troubleshooting

## Identity says unavailable or key storage is blocked

- Linux: unlock GNOME Keyring/libsecret or KWallet before starting OpenDesk. `safeStorage` using the `basic_text` backend is refused.
- Restart after unlocking the credential store. OpenDesk will not authenticate with the display-only fallback ID.
- If an encrypted key cannot be decrypted, restore access to the original OS credential store. Do not delete the identity file as a first step; losing it changes the device identity and can strand its server registration.

## Signaling says offline

- Confirm both devices use the exact same HTTPS origin and that its certificate is valid in the OS trust store.
- On one computer, the development service defaults to `http://127.0.0.1:8787`; that loopback address is not reachable as the same server from another computer.
- Check `/healthz` and `/readyz` from the client network. Check Caddy/service logs and host firewall rules.
- Device presence uses heartbeats; a device with OpenDesk closed or disconnected becomes offline.
- The service stores device registrations on disk but sessions/events/presence are in memory. After a service restart, wait for both clients to register and send a new request.

## Peer is offline or the session request disappears

- Verify both IDs and that both clients use the same signaling service.
- Incoming requests expire after 90 seconds. The receiver must leave OpenDesk open and approve promptly.
- If the receiver is already in a session, disconnect it before approving another request.
- A device ID is not a password. The target user must approve each request.

## First-contact fingerprint warning or key changed

- Verify the full public-key fingerprint through a separate trusted channel (for example, a voice call with the intended user).
- Do not accept a changed key based only on the device ID or a message in the signaling app.
- If the peer intentionally revoked/reset its identity, remove the old local pin only after confirming the new fingerprint, then repeat first-contact trust.

## WebRTC stays negotiating or shows no remote display

- Confirm the host approved view and clicked **Choose screen & share**.
- Grant OS capture permission. On macOS, enable OpenDesk under Screen Recording and restart/retry as directed by macOS. On Linux Wayland, verify the desktop portal and PipeWire picker; X11 uses the active display session.
- Test whether both peers can establish direct ICE on their actual networks. The signaling API can return an empty ICE list if STUN/TURN was not configured; same-LAN connections may still work, while NAT/firewall traversal can fail.
- Configure a compatible STUN server and preferably authenticated TURN relay for restrictive networks. TURN URLs, shared secret, advertised public IP, relay ports, and firewall must all agree.
- The implementation currently waits for gathered ICE candidates rather than trickling them. Slow candidate gathering or restrictive networks can cause failure.
- Compare sanitized diagnostics on both peers. The interface only shows metrics after WebRTC reports actual stats; absent measurements are not synthetic values.

## File transfer stalls, fails, or destination exists

- Confirm file permission was requested and approved and that the peer data channel is open.
- The receiver must approve every file and choose a destination. Existing destinations are never overwritten; choose a different filename and retry.
- Maximum file size is 1 GiB; maximum batch is 16 files. Files publish only after byte-count and SHA-256 checks.
- If disconnected/cancelled, incomplete bytes are deleted when possible. A forced crash/power loss can leave a hidden `.opendesk-*.part` file in the destination directory. Verify OpenDesk is closed, inspect it, and delete only that temporary file.
- Some filesystems do not support same-directory hard links. In that case final publication fails safely rather than overwriting; choose a destination on a filesystem that supports hard links.

## Clipboard transfer does nothing

- Clipboard permission must be approved by the host. The sender explicitly confirms the clipboard read, and the receiver separately confirms replacement.
- Only one-time plain text is supported (32 KiB peer-transfer maximum). No continuous synchronization or files/images in the clipboard are sent.

## Unsupported controls

Remote keyboard/mouse, remote input, audio, unattended access, and mobile clients are not implemented in this build. No setting or permission checkbox can enable them.
