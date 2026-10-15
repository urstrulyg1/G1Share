# Getting started and two-client test procedure

## What this build can do

OpenDesk can authenticate to a signaling service, locate a device by ID, request a consent-based session, and negotiate a WebRTC screen-viewing connection. The host must approve the request and separately select a display before capture. Optional file transfer and one-time clipboard text require explicit session permissions. The UI identifies remote input, audio, and unattended access as unavailable.

The screen-capture and peer-connection implementation has not yet been verified between two independently installed desktop clients. Use the procedure below as a test plan, not a promise that every network/platform combination works.

## First run

1. Install OpenDesk on two separate desktop devices. A release installer is not yet validated; for development use `npm ci` followed by `npm run dev` on each device.
2. Confirm both devices have an unlocked OS credential store. Linux must use GNOME Keyring/libsecret or KWallet; basic-text fallback is intentionally refused.
3. Configure both apps to use the same reachable **HTTPS** signaling origin. `http://127.0.0.1:8787` is for same-computer development only.
4. Wait for **Signaling connected** on both clients. Copy the host's device ID to the requester over a trusted channel.
5. In the requester, enter the host ID. On first contact, compare the displayed public-key fingerprint with the host using a separate trusted channel, then explicitly trust it.
6. Leave optional file/clipboard requests off unless needed. Select **Request access**.
7. On the host, inspect the peer and requested permissions. Reject, approve screen view only, or explicitly grant the requested optional file/clipboard permissions. The main process then displays a native confirmation listing the exact permissions; canceling it denies access. Approval does not start capture.
8. On the host, choose **Choose screen & share**, choose a source in the native picker, and approve any OS capture permission. The remote viewer should then show the live WebRTC stream if ICE connectivity succeeds.
9. For file transfer, grant file permission, choose files on the sender, and accept the native destination prompt on the receiver. The app writes a private temporary file and only publishes it after size/hash verification.
10. For clipboard text, both devices must grant clipboard permission; the sender confirms before the local clipboard is read, and the receiver confirms before replacement.
11. Disconnect from either side and verify the peer view closes. Confirm no incomplete `.opendesk-*.part` files remain in the chosen destination directory.

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

For local same-computer development, run `(cd services/signaling && go run .)` in one terminal and `npm run dev` in another. Two clients on different computers need an HTTPS signaling deployment and appropriate ICE/STUN/TURN reachability. Two app processes that share one user-data directory share one device identity and cannot authenticate as independent devices.

## Identity recovery and revocation

From Settings, choose **Revoke & reset** to display a native confirmation. If the current ID is registered, OpenDesk requests server-side revocation, closes its server-known sessions, deletes the old local key, and creates a new identity. The app requires the signaling service to be reachable for registered devices. Share the new ID and verify the new fingerprint; old peer trust pins do not automatically trust the new key.

If the OS credential store is locked/unavailable or the local key is corrupt, identity reset is blocked rather than silently generating a mismatched identity. Restore/unlock the system keyring and restart first. Keep the old data directory intact until recovery is understood.
