# G1Viewer latency and responsiveness: measurements, causes, and changes

**Scope of this report.** Everything here was measured on one sandbox: two headless Chromium pages on loopback,
two vCPUs, a fake canvas as the display source, and a recording stub in place of OS input injection. These are
pipeline measurements. They are not photon-to-photon latency, not Electron screen-capture numbers, not libnut
injection numbers, and not internet or LAN results. G1Viewer does not claim zero latency, and these numbers do not
show that the desktop feels "instant."

## 1. Summary

Measured on the same loopback bench, with three full runs per configuration (medians shown, min-max in brackets):

- **Pointer:** a move is no longer delayed by a 16 ms coalescing timer. Dispatch-to-host median fell from
  16.7 ms to 0.6 ms (p95 17.3 → 0.9 ms). Every dispatched move is now sent: 300 of 300 in all three runs, where the
  baseline sent 213–223 of 300 (the timer merged the rest).
- **Keys:** input-to-visible median fell from 56.6 ms to 42.4 ms when the host is idle (p95 93.8 → 72.9 ms), and from
  55.2 ms to 38.4 ms under CPU load (p95 81 → 60 ms). The range overlaps the baseline on some metrics; read the
  per-run files before quoting a single figure.
- **Video:** the presented frame rate doubled, from about 15 fps to about 28 fps, because the capture constraint was
  raised from 15 fps to 30 fps. Frame interval fell from 66.7 ms to 33.3 ms. Capture-to-screen median fell from
  23.1 ms to 20.5 ms.
- **Not improved, or worse, and reported as such:**
  - Key viewer-to-host transit during a file transfer: median 4.8 → 6.0 ms; p95 18.5 → 12.5 ms. The ranges overlap, so
    there is no demonstrated improvement at the median.
  - File transfer throughput: 11.03 → 9.79 MiB/s (about 11% lower). This is the cost of the smaller send-queue ceiling
    (see section 6).
  - Startup resolution: during the first seconds, while the congestion controller ramps up, the viewer decoded at 400 px
    wide (600 px during the pointer sweep) where the baseline held 800 px. The encoder reduces resolution under the
    `balanced` profile's `maintain-framerate` preference. Section 6 covers this in detail.
- **Bug found and fixed in the measurement path:** the host controller's dispatch timer used `process.hrtime` in a
  browser context and threw, so every injection failed and no input was measured. It now uses `performance.now()`.
  Earlier, unrepaired runs are not valid and were deleted.

## 2. Pipeline and clocks

| Stage | What happens | Clock / source | Status in this bench |
| --- | --- | --- | --- |
| 1. Viewer input event | Pointer or key event on the video element | `performance.now()` at dispatch | Measured (dispatch timestamp) |
| 2. Viewer coalescing | Pointer moves waited for a 16 ms timer (baseline); sent immediately now | `performance.now()` | Measured (coalescing delay) |
| 3. Viewer send | `RTCDataChannel.send` on the input channel | `performance.now()` | Measured (send timestamp) |
| 4. Transport to host | SCTP over DTLS over ICE; loopback here | viewer send vs host receive | Measured (transit, matched by index) |
| 5. Host validation and dispatch | Schema validation, rate limit, `RemoteInputController.dispatch` | `performance.now()` around dispatch | Measured with a recording backend only |
| 6. OS injection (libnut) | Native call into the OS | none | **Not measured** (recording stub) |
| 7. Capture | `getDisplayMedia` on the host (fake canvas in the harness) | RTP capture time from Chromium | Measured in the harness; real capture **not** measured |
| 8. Encode | Host video encoder (software VP8 in headless Chromium) | `totalEncodeTime` deltas | Measured (in-browser stats) |
| 9. Network to viewer | Loopback; no shaping (`tc` is unavailable here) | `candidate-pair` RTT, receiver reports | Measured on loopback only |
| 10. Jitter buffer and decode | Receiver playout and decoder | `jitterBufferDelay`, `totalDecodeTime` | Measured |
| 11. Presentation | Frame shown to the page | `requestVideoFrameCallback` metadata | Measured (presented frames) |
| 12. Visible change | Marker drawn by the host page appears in the viewer | first marker sample after dispatch | Measured in the harness only |

Capture-to-screen is stage 7 through 11 together. Input-to-visible is stages 1 through 12, but only in the harness.
The harness draws the marker itself, so stage 12 measures the test page, not a desktop.

## 3. Metric definitions

These definitions are used by `e2e/perf/latency.bench.mjs`. Drops are never counted as successes.

- **Pointer coalescing:** the first `input:move` send at or after the dispatch time, minus the dispatch time.
- **Pointer transit:** the injection time minus the send time, with sends and injections matched by index (the channel is
  ordered and injection is single-threaded, so the lists align when nothing is lost; the bench reports counts so a
  mismatch is visible).
- **Pointer dispatch-to-host (end-to-end):** the injection time minus the dispatch time, for the send that carried that move.
- **Pointer unsent:** dispatched moves with no later send. These are reported as a separate count.
- **Key input-to-visible:** the first marker sample at or after the dispatch time whose state matches the injected
  marker. Key taps with no send, no injection, or no visible sample count as missed.
- **Key viewer-to-host transit:** the injection time minus the send time, matched by position.
- **Presented fps:** presented frames over the last 60 frame intervals.
- **Capture-to-screen:** presentation time minus the RTP capture time that Chromium maps onto the page's timeline. The
  mapping accuracy is **unverified**.
- **Host dispatch timing:** time around `RemoteInputController.dispatch` with the recording backend. Chromium coarsens
  `performance.now()` to 100 µs in this context, so the values are quantized. Electron main may be finer; that is
  not measured here.

## 4. Method

**Benchmark:** `npm run bench:latency` (`e2e/perf/latency.bench.mjs`). It builds the Go broker, serves the harness with
Vite, and runs two isolated headless Chromium contexts (host and viewer). Each full run uses 3 s of idle video, 300
pointer moves (sweep), 40 key taps every 150 ms in each key scenario, and a 48 MiB file transfer during one scenario.
`BENCH_QUICK=1` is a shortened smoke run and is not used for any result here. Each configuration ran three times.

**Environment:** Chromium 153 (HeadlessChrome), Node v22.22.3, Intel Xeon @ 2.60 GHz, 2 vCPU, loopback.

**Baseline construction (how it was built):** the baseline is the current working tree with the candidate changes
reverted, not a `git worktree` of `772bb94`. HEAD does not contain the audit's remote-input and file-transfer work, so
a clean checkout could not run the input scenarios. The baseline keeps the audit work and all measurement
instrumentation, and reverts only these candidate changes:

1. Pointer coalescing restored to a 16 ms timer, and the send-unchanged-position skip removed.
2. Input messages share the ordered file data channel (`opendesk-data-v1`); the separate `opendesk-input-v1` channel removed.
3. Capture constraints restored to `frameRate {ideal 15, max 30}` and `width {ideal 1600}`; track `contentHint` `detail`.
4. Sender tuning removed: no `setParameters`, `maxBitrate`, `degradationPreference`, or priority; no receiver playout hints.
5. Quality protocol, automatic adaptation, and the quality selector removed.
6. File channel queue ceiling restored to 512 KiB (low-water mark 128 KiB).

Kept in the baseline, because they are measurement or correctness fixes and not optimizations: the bench, the shared
rig, `latency-stats`, `video-probe`, `webrtc-stats`, the `performance.now()` fix, the harness fake display honoring
`frameRate`, and the idempotent channel-open guard. The baseline harness's fake display therefore runs at 15 fps and the
candidate's at 30 fps, which is a direct consequence of change 3, not a separate effect.

The pointer timer in change 1 is reconstructed from the pre-change code's description (16 ms `setTimeout`, pending
move, flush), not copied from a saved file. The baseline typechecks. Its only failing unit test is the new
immediate-send test, which is the expected result for reverted code.

**Summaries:** `e2e/perf/summarize.mjs baseline candidate` writes
`docs/performance/results/summary-baseline-vs-candidate.md` from the per-run JSON files.

## 5. Results

Medians of three runs, with min-max range in brackets. Generated from the JSON in `docs/performance/results/`.

| Metric | baseline | candidate |
| --- | --- | --- |
| Pointer dispatch-to-host p50 (ms) | 16.7 [16.7–16.8] | 0.6 [0.5–0.6] |
| Pointer dispatch-to-host p95 (ms) | 17.3 [17.3–18.6] | 0.9 [0.8–1] |
| Pointer coalescing p50 (ms) | 16.2 [16.2–16.3] | 0.1 [0.1–0.1] |
| Pointer transit viewer-to-host p50 (ms) | 0.5 [0.5–0.6] | 0.5 [0.4–0.5] |
| Pointer moves dispatched / sent / injected | 300 / 213 / 213 ; 300 / 222 / 222 ; 300 / 223 / 223 | 300 / 300 / 300 ; 300 / 300 / 300 ; 300 / 300 / 300 |
| Key input-to-visible p50 (ms), idle host | 56.6 [53.7–57.4] | 42.4 [42.3–43.6] |
| Key input-to-visible p95 (ms), idle host | 93.8 [82.8–94.3] | 72.9 [59.3–73.2] |
| Key input-to-visible p50 (ms), CPU load | 55.2 [49–57.7] | 38.4 [37.8–39.5] |
| Key input-to-visible p95 (ms), CPU load | 81 [79.3–84.4] | 60.2 [59.3–60.4] |
| Key input-to-visible p50 (ms), during file transfer | 61.3 [56.8–62.9] | 44.7 [40.9–52.9] |
| Key input-to-visible p95 (ms), during file transfer | 92.6 [84.7–100] | 75.6 [70.8–90] |
| Key viewer-to-host transit p50 (ms), during file transfer | 4.8 [2.6–5.6] | 6 [4.9–6.1] |
| Key viewer-to-host transit p95 (ms), during file transfer | 18.5 [12.4–24.4] | 12.5 [11.5–15.3] |
| Key taps dispatched / injected / missed (idle host) | 40 / 40 / 0 ; 40 / 40 / 0 ; 40 / 40 / 0 | 40 / 40 / 0 ; 40 / 40 / 0 ; 40 / 40 / 0 |
| Presented frame rate (fps), idle | 15.19 [15.13–15.19] | 28.35 [27.27–28.57] |
| Capture-to-screen p50 (ms), idle | 23.1 [23.1–24.5] | 20.5 [19.5–20.8] |
| Capture-to-screen p95 (ms), idle | 34.4 [33.2–35.6] | 29.9 [29.6–30.9] |
| Frame interval p50 (ms), idle | 66.7 [66.7–66.7] | 33.3 [33.3–33.3] |
| Viewer decoded width (px), idle | 800 [800–800] | 400 [400–400] |
| Viewer jitter buffer (ms), idle | 7.97 [7.58–8.55] | 7.48 [7.31–7.95] |
| Viewer decode time per frame (ms), idle | 1.55 [1.54–1.58] | 0.37 [0.37–0.4] |
| Host encode time per frame (ms), idle | 3.13 [2.81–3.55] | 1.88 [1.4–1.88] |
| File transfer rate (MiB/s), during key taps | 11.03 [10.92–11.19] | 9.79 [9.59–10.13] |

Host dispatch timing (recording backend, µs, quantized to 100 µs by the browser clock):

- baseline: p50 0, p95 100, max 200 (n=453); p50 0, p95 100, max 300 (n=462); p50 0, p95 100, max 17200 (n=463)
- candidate: p50 0, p95 100, max 200 (n=540); p50 0, p95 100, max 300 (n=540); p50 0, p95 100, max 200 (n=540)

Notes on the table:

- Pointer counts are per run: `dispatched / sent / injected`. The baseline's lower `sent` count is the coalescing
  timer merging moves. Nothing was dropped in either configuration.
- Key taps: 40 dispatched and injected in every run, none missed.
- Each key scenario has 40 samples per run, 120 pooled. Ranges overlap for several metrics, so differences smaller
  than the ranges should not be quoted as improvements.

## 6. Bottleneck root causes

Labels: **Measured** means the value came from this bench. **Estimated** means it follows from measurements plus a
stated assumption. **Unverified** means it was not tested here.

| # | Cause | Evidence | Effect | Change |
| --- | --- | --- | --- | --- |
| B1 | Pointer moves wait for a 16 ms coalescing timer | Measured: coalescing p50 16.2–16.3 ms in all baseline runs | Adds about 16 ms to every move, and drops moves that merge | Send immediately; skip only unchanged positions (`remote-input.ts`) |
| B2 | Capture requested at 15 fps (`ideal 15, max 30`) | Measured: 66.7 ms frame interval and 15.2 fps presented in the harness | Frame sampling adds up to one frame interval to every visible change | Request 30 fps for `balanced` |
| B3 | Estimated: frame sampling adds about half a frame interval on average | Estimated: half-interval falls from 33.3 ms to 16.7 ms, a 16.7 ms saving, close to the measured 14–17 ms drop in key median | Explains most of the key-visible improvement when the host is idle | Follows from B2 |
| B4 | Input shares one ordered channel with file chunks | Estimated mechanism (SCTP and send-buffer queueing). Measured here: no clear transit change under file transfer on loopback (section 5) | Could add delay behind file data under loss or a bottleneck | Separate `opendesk-input-v1` channel with `priority: high`; file queue ceiling lowered to 128 KiB. **Not shown to help on loopback. Under loss and rate limits: unverified** |
| B5 | Encoder has no bitrate cap, degradation policy, or hint | Not measured separately: confounded by the frame-rate change | Unknown | `maxBitrate`, `maintain-framerate` or `maintain-resolution`, `contentHint` per profile. **Effect not isolated: unverified** |
| B6 | Receiver jitter buffer is small on loopback | Measured: 7–8 ms default. Pre-fix candidate runs on the `low` profile (100 ms playout target): jitter 80 ms, key visible 128–134 ms against 55 ms baseline (B6 and B7 together) | The 100 ms target adds directly to every visible change | `low` profile playout hint returned to the browser default |
| B7 | Automatic adaptation treated the congestion controller's ramp-up as congestion | Measured: first candidate runs stepped `balanced` → `low` in all three runs | Lowered resolution and fps and added B6's delay | Congestion now means loss, RTT above 300 ms, or queueing 50 ms above the session minimum RTT. Bandwidth limitation alone is not congestion. Regression test added |
| B8 | Startup resolution drops during the bandwidth ramp-up | Measured: viewer width 400 px (idle), 600 px (sweep) in candidate runs vs 800 px baseline | Visible loss of sharpness for the first seconds | **Open.** Possible fix: `balanced` on `maintain-resolution` during ramp-up. Not tested |
| B9 | Host dispatch cost | Measured: p50 0 µs, p95 100 µs (quantized); one 17 ms outlier in one baseline run | Negligible for the stub; libnut cost **unverified** | None |

## 7. Changes made

- `src/renderer/src/services/remote-input.ts`: pointer moves are sent immediately, skipping only unchanged positions.
- `src/renderer/src/services/remote-session.ts`: separate input channel (`opendesk-input-v1`) with a single open-guard,
  capture constraints from the profile, sender parameters applied serially, receiver playout hints, a rate-limited
  host-side `session:quality` handler, and automatic adaptation on the host metrics cadence.
- `src/shared/quality-profile.ts` and tests: profile table, protocol parsers (strict, size-limited), and the pure adaptation
  policy (two congested samples to step down, three healthy to step up, 10 s dwell, RTT-queueing rule).
- `src/renderer/src/services/file-transfer.ts`: queue ceiling 128 KiB (from 512 KiB), low-water mark at half of it.
- `src/main/remote-input.ts`: `performance.now()` for dispatch timing; the earlier `process.hrtime` path failed in the
  browser harness.
- `src/renderer/src/services/webrtc-stats.ts`, `video-probe.ts`, `src/shared/latency-stats.ts`: measurement modules.
- `src/renderer/src/components/ActiveSessionView.tsx`: quality selector (both roles) and an indicator of the profile in use.
- `e2e/lib/rig.mjs`: shared startup for the two-client test and the bench. `e2e/perf/latency.bench.mjs` and
  `e2e/perf/summarize.mjs`.

## 8. Tests

- Vitest: 103 tests in 12 files, all passing. These include the pointer tests, quality-profile policy (15), `latency-stats` (9),
  `webrtc-stats` (17), `video-probe` (6), and the earlier suites.
- Two-client e2e: 16 of 16 checks pass (`npm run test:e2e`), using the real signaling broker and two Chromium pages.
- Go: `go vet` and `go test ./...` pass with Go 1.22.10 (the `go.mod` version; CI uses `1.22.x`).
- `npm audit --audit-level=high`: 0 vulnerabilities (exit 0).
- Typecheck and production build pass.

The adaptation step's wiring in `remote-session.ts` (reading the stats and calling the policy) is not unit-tested,
because it needs a real `RTCPeerConnection`. The two-client test and the bench exercise it only indirectly. The bench's
`senderQualityNotices` field records every profile change the viewer receives.

## 9. Limitations

- **Environment:** no physical desktops, no real Electron screen capture, no libnut injection (recording backend only),
  no TURN server, no LAN or internet peers, no packet loss or rate shaping (`tc` is unavailable in this sandbox).
- **Path:** all results are loopback. The transport label is "Direct (same network)" only because the selected pair
  is two host candidates on this machine. This must not be read as internet or LAN performance.
- **Clock:** headless Chromium coarsens `performance.now()` to 100 µs in this context.
- **Sample size:** 3 runs per configuration; 40 key taps and 300 moves per run. Small differences fall within the ranges.
- **Platform:** Wayland input is refused by design; macOS needs Accessibility; Windows loopback audio is not measured.
- **Not measured:** photon-to-photon latency, display scan-out, physical input devices, GPU encode or decode, hardware
  encoders, and real capture pacing.

## 10. Parked audit items (status)

- Host close path calls `stopRemoteInput`: confirmed by reading `RemoteSessionController.close()`.
- File-transfer envelope check: `isRemoteInputEnvelope` still ignores input envelopes if they arrive on the file channel.
  The input path no longer uses that channel, so the check is defense in depth. Partly answered.
- `actual-size` uses `object-fit: cover`, which crops instead of showing 1:1. **Open.**
- Audio gating for manual device IDs: **not checked in this phase.**
- Go version: consistent at 1.22 across `go.mod`, CI (`1.22.x`), and the README.
- `npm audit --audit-level=high`: verified, 0 vulnerabilities.
- The earlier "up from 26" test count was not re-verified. The current count is 103 (section 8).

## 11. Reproduce

```sh
npm ci
export CHROME_PATH=/path/to/chrome LD_LIBRARY_PATH=...   # if needed
npm run typecheck && npm test && npm run build
npm run test:e2e
BENCH_LABEL=candidate-run1 npm run bench:latency          # repeat for run2, run3
node e2e/perf/summarize.mjs baseline candidate
```

The baseline must be rebuilt by reverting the six changes in section 4 on a copy of the tree. The bench, rig, and
test files are shared.

## 12. Files

- `docs/performance/results/baseline-run{1,2,3}.json`, `candidate-run{1,2,3}.json`: per-run results.
- `docs/performance/results/summary-baseline-vs-candidate.md`: generated summary table.
