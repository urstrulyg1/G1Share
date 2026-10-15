# Getting started and two-client test procedure

## What this build can do

G1Viewer opens directly to Home without login or signup. It generates a local device key/ID, authenticates device-to-device signaling, locates peers by ID, and requests consent before attempting WebRTC screen viewing. The host must approve the request and separately select a display before capture. File transfer, one-time clipboard text, remote input, and Windows-only system audio each require independent host approval; keyboard/mouse input additionally requires the host to enable it after sharing starts. Unattended access is unavailable.

The screen-capture and peer-connection implementation has not yet been verified between two independently installed desktop clients. Use the procedure below as a test plan, not a promise that every network/platform combination works.

## First run

1. Install G1Viewer on two separate desktop devices. Unsigned installer targets are available as GitHub Actions artifacts, but install/launch behavior is not yet validated; for development use `npm ci` followed by `npm run dev` on each device.
2. Confirm both devices have an unlocked OS credential store. Linux must use GNOME Keyring/libsecret or KWallet; basic-text fallback is intentionally refused.
3. Open **Settings → Signaling service** on both apps and set the same reachable **HTTPS** origin. No server is configured by default and no cloud account is needed. `http://127.0.0.1:8787` is an opt-in for same-computer development only. A LAN still needs a shared TLS-protected signaling endpoint; G1Viewer does not discover peers or pair without signaling.
4. Wait for **Signaling connected** on both clients. If the OS credential store is unavailable, the device ID shows **Unavailable** and signing is blocked; unlock the store and restart. Copy the host's actual device ID to the requester over a trusted channel.
5. In the requester, enter the host ID. On first contact, compare the displayed public-key fingerprint with the host using a separate trusted channel, then explicitly trust it.
6. Leave optional file/clipboard requests off unless needed. Select **Request access**.
7. On the host, inspect the peer and requested permissions. Reject or approve required screen view, selecting **each** requested file, clipboard, input, or Windows-audio extra separately (all off by default). Unsupported host input/audio options are disabled with an explanation. The main process revalidates the session and displays a native confirmation listing the exact grants; canceling it denies access. Approval does not start capture.
8. On the host, choose **Choose screen & share**, choose a source in the native picker, and approve any OS capture permission. The remote viewer should then show the live WebRTC stream if ICE connectivity succeeds.
9. For file transfer, grant file permission, choose files on the sender, and accept the native destination prompt on the receiver. The app writes a private temporary file and only publishes it after size/hash verification.
10. For clipboard text, both devices must grant clipboard permission; the sender confirms before the local clipboard is read, and the receiver confirms before replacement.
11. If remote control was requested and approved on an X11 Linux, Windows, or accessible macOS host, the host must also click **Enable remote control** after sharing; it can stop input at any time. Wayland input and non-Windows system audio are unavailable. Disconnect from either side and verify the peer view closes. Confirm no incomplete `.opendesk-*.part` files remain in the chosen destination directory. Recent sessions show **WebRTC connected** only if the transport actually reached that state.

If the remote stream does not connect, collect **sanitized diagnostics** from both sides and follow [troubleshooting](troubleshooting.md). Do not send screen contents, clipboard data, private keys, authentication headers, or `.env` secrets in bug reports.

## Build and test from source

From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
(cd services/signaling && go test -race -cover ./... && go vet ./...)
```

For local same-computer development, run `(cd services/signaling && go run .)` in one terminal and `npm run dev` in another. In Settings, configure `http://127.0.0.1:8787` on each client (or set `G1VIEWER_SIGNALING_URL` for the desktop process). Two clients on different computers need a shared reachable HTTPS signaling deployment and appropriate ICE/STUN/TURN reachability, even on a LAN. Two app processes that share one user-data directory share one device identity and cannot authenticate as independent devices.

## Identity recovery and revocation

From Settings, choose **Revoke & reset** to display a native confirmation. If the current ID is registered, G1Viewer requests server-side revocation, closes its server-known sessions, deletes the old local key, and creates a new identity. The app requires the signaling service to be reachable for registered devices. Share the new ID and verify the new fingerprint; old peer trust pins do not automatically trust the new key.

If the OS credential store is locked/unavailable or the local key is corrupt, identity reset is blocked rather than silently generating a mismatched identity. Restore/unlock the system keyring and restart first. Keep the old data directory intact until recovery is understood.
