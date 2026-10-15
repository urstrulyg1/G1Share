# Latency benchmark summary (baseline vs candidate)

Each cell is the median of the runs, with the min-max range in brackets. Values come from the JSON files in this directory; nothing is estimated.

- **baseline**: 3 runs (baseline-run1.json, baseline-run2.json, baseline-run3.json); commit 772bb94; working tree changed: true; HeadlessChrome/153.0.8010.0; 2 vCPU; quick: false.
- **candidate**: 3 runs (candidate-run1.json, candidate-run2.json, candidate-run3.json); commit 772bb94; working tree changed: true; HeadlessChrome/153.0.8010.0; 2 vCPU; quick: false.

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

Host controller dispatch time (`hostControllerDispatchMicros`, cumulative, recording backend, µs; Chromium coarsens performance.now() to 100 µs):
- baseline: p50 0, p95 100, max 200 (n=453); p50 0, p95 100, max 300 (n=462); p50 0, p95 100, max 17200 (n=463)
- candidate: p50 0, p95 100, max 200 (n=540); p50 0, p95 100, max 300 (n=540); p50 0, p95 100, max 200 (n=540)

