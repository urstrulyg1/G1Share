// Summarizes repeated latency-benchmark runs into a markdown table: median of the runs, with the min-max range.
// Usage: node e2e/perf/summarize.mjs <label-prefix> <label-prefix> ...   (e.g. baseline candidate)
// Reads docs/performance/results/<prefix>-run<N>.json and writes docs/performance/results/summary-<prefixes>.md.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const resultsDir = join(repoRoot, 'docs/performance/results')
const prefixes = process.argv.slice(2)
if (prefixes.length === 0) throw new Error('Pass at least one label prefix, e.g. baseline candidate.')

const metrics = [
  ['Pointer dispatch-to-host p50 (ms)', 'pointer-sweep', s => s.pointer.dispatchToHostMs?.p50],
  ['Pointer dispatch-to-host p95 (ms)', 'pointer-sweep', s => s.pointer.dispatchToHostMs?.p95],
  ['Pointer coalescing p50 (ms)', 'pointer-sweep', s => s.pointer.coalesceMs?.p50],
  ['Pointer transit viewer-to-host p50 (ms)', 'pointer-sweep', s => s.pointer.viewerToHostMs?.p50],
  ['Pointer moves dispatched / sent / injected', 'pointer-sweep', s => `${s.pointer.dispatched} / ${s.pointer.sent} / ${s.pointer.injected}`, 'text'],
  ['Key input-to-visible p50 (ms), idle host', 'key-taps', s => s.keys.inputToVisibleMs?.p50],
  ['Key input-to-visible p95 (ms), idle host', 'key-taps', s => s.keys.inputToVisibleMs?.p95],
  ['Key input-to-visible p50 (ms), CPU load', 'key-taps-cpu-load', s => s.keys.inputToVisibleMs?.p50],
  ['Key input-to-visible p95 (ms), CPU load', 'key-taps-cpu-load', s => s.keys.inputToVisibleMs?.p95],
  ['Key input-to-visible p50 (ms), during file transfer', 'key-taps-during-file-transfer', s => s.keys.inputToVisibleMs?.p50],
  ['Key input-to-visible p95 (ms), during file transfer', 'key-taps-during-file-transfer', s => s.keys.inputToVisibleMs?.p95],
  ['Key viewer-to-host transit p50 (ms), during file transfer', 'key-taps-during-file-transfer', s => s.keys.viewerToHostMs?.p50],
  ['Key viewer-to-host transit p95 (ms), during file transfer', 'key-taps-during-file-transfer', s => s.keys.viewerToHostMs?.p95],
  ['Key taps dispatched / injected / missed (idle host)', 'key-taps', s => `${s.keys.keyDownsDispatched} / ${s.keys.keyDownsInjected} / ${s.keys.missed}`, 'text'],
  ['Presented frame rate (fps), idle', 'idle-video', s => s.presentation.presentedFps],
  ['Capture-to-screen p50 (ms), idle', 'idle-video', s => s.presentation.captureToScreenMs?.p50],
  ['Capture-to-screen p95 (ms), idle', 'idle-video', s => s.presentation.captureToScreenMs?.p95],
  ['Frame interval p50 (ms), idle', 'idle-video', s => s.presentation.frameIntervalMs?.p50],
  ['Viewer decoded width (px), idle', 'idle-video', s => s.viewerMetrics.width],
  ['Viewer jitter buffer (ms), idle', 'idle-video', s => s.viewerMetrics.jitterBufferMs],
  ['Viewer decode time per frame (ms), idle', 'idle-video', s => s.viewerMetrics.decodeMs],
  ['Host encode time per frame (ms), idle', 'idle-video', s => s.hostMetrics.encodeMs],
  ['File transfer rate (MiB/s), during key taps', 'key-taps-during-file-transfer', s => s.transfer?.mebibytesPerSecond]
]

function median(values) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function format(value) {
  return value === null || value === undefined ? 'n/a' : (Math.round(value * 100) / 100).toString()
}

async function loadRuns(prefix) {
  const names = (await readdir(resultsDir)).filter(name => new RegExp(`^${prefix}-run\\d+\\.json$`).test(name)).sort()
  const runs = []
  for (const name of names) runs.push({ name, data: JSON.parse(await readFile(join(resultsDir, name), 'utf8')) })
  if (runs.length === 0) throw new Error(`No ${prefix}-run<N>.json files in ${resultsDir}`)
  return runs
}

const loaded = {}
for (const prefix of prefixes) loaded[prefix] = await loadRuns(prefix)

const lines = []
lines.push(`# Latency benchmark summary (${prefixes.join(' vs ')})`)
lines.push('')
lines.push('Each cell is the median of the runs, with the min-max range in brackets. Values come from the JSON files in this directory; nothing is estimated.')
lines.push('')
for (const prefix of prefixes) {
  const first = loaded[prefix][0].data.environment
  lines.push(`- **${prefix}**: ${loaded[prefix].length} runs (${loaded[prefix].map(run => run.name).join(', ')}); commit ${first.commit}; working tree changed: ${first.workingTreeChanged}; ${first.chrome}; ${first.cpuCount} vCPU; quick: ${first.quick}.`)
}
lines.push('')
lines.push(`| Metric | ${prefixes.join(' | ')} |`)
lines.push(`| --- | ${prefixes.map(() => '---').join(' | ')} |`)
for (const [label, scenario, pick, kind] of metrics) {
  const cells = prefixes.map(prefix => {
    const values = loaded[prefix].map(run => {
      const sc = run.data.scenarios[scenario]
      if (!sc) return null
      try { return pick(sc) } catch { return null }
    })
    if (kind === 'text') return values.map(value => value ?? 'n/a').join(' ; ')
    const numbers = values.filter(value => typeof value === 'number')
    if (numbers.length === 0) return 'n/a'
    const range = numbers.length > 1 ? ` [${format(Math.min(...numbers))}–${format(Math.max(...numbers))}]` : ''
    return `${format(median(numbers))}${range}`
  })
  lines.push(`| ${label} | ${cells.join(' | ')} |`)
}
lines.push('')
lines.push('Host controller dispatch time (`hostControllerDispatchMicros`, cumulative, recording backend, µs; Chromium coarsens performance.now() to 100 µs):')
for (const prefix of prefixes) {
  const values = loaded[prefix].map(run => run.data.hostControllerDispatchMicros)
  lines.push(`- ${prefix}: ${values.map(value => value ? `p50 ${value.p50}, p95 ${value.p95}, max ${value.max} (n=${value.count})` : 'n/a').join('; ')}`)
}
lines.push('')
const output = join(resultsDir, `summary-${prefixes.join('-vs-')}.md`)
await writeFile(output, lines.join('\n') + '\n')
console.log(lines.join('\n'))
console.log(`\nwrote ${output}`)
