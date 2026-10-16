# G1Viewer connectivity tests

## Local CI test

The regular `Two-client end-to-end` job starts the real Go signaling broker and two isolated headless Chromium clients. It verifies device registration, a live WebRTC video stream, selected ICE candidate-pair diagnostics, the secure data channel, a 256 KiB file transfer with receiver-side hash verification, a browser-offline interruption followed by ICE restart and resumed video, and remote-input/file-permission enforcement.

This is a real browser WebRTC test, but both clients run on the same GitHub-hosted runner. It does not by itself prove connectivity between physical devices on unrelated networks.

## Optional deployed-service smoke test

To exercise a deployed signaling service on every push to `main` (or a manual workflow run):

1. Open **Settings → Secrets and variables → Actions → Variables** in the repository.
2. Add `G1VIEWER_WAN_SIGNALING_URL` with the base HTTPS URL of the deployed G1Viewer signaling service (for example, `https://signal.example.com`).
3. The `Deployed WAN signaling and WebRTC smoke` job will run the same two-client browser test against that service, including video and file transfer.

The endpoint must be a test/staging deployment or otherwise approved for automated test registrations and sessions. The test creates temporary device identities and sessions; clients close their sessions at the end, but the service may retain device records until its normal expiry/cleanup.

## Optional TURN relay-only test

To require the test connection to use TURN instead of direct ICE candidates, add the repository Actions variable:

- `G1VIEWER_WAN_TURN_TEST=true`

This enables the `Deployed TURN relay-only connection smoke` job. It sets `iceTransportPolicy: relay` in the E2E harness and fails unless both peers report a selected successful candidate pair with relay candidates on both sides. The deployed service must return valid, reachable TURN server configuration and credentials from its ICE-configuration endpoint. If TURN is not configured, leave this variable unset; the ordinary connectivity smoke test still runs.

## What this does not prove

GitHub-hosted clients share one runner/network environment. The deployed-service smoke test checks the real service and actual WebRTC/media/data path from that environment, and the relay-only job verifies TURN when enabled. To claim end-to-end reliability between devices behind genuinely different NATs/firewalls, add a second independently hosted test agent (for example, a controlled self-hosted runner in another network) and have the two agents join the same test session. That requires separate runner/network infrastructure; it is not simulated by two browser tabs on one runner.
