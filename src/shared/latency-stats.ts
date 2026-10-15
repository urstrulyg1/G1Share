// Bounded, allocation-light statistics for latency samples. Shared by the renderer probes and the main-process
// input timing so that both report percentiles the same way.

export interface Percentiles {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** Nearest-rank percentile of a finite sample set. Returns NaN for an empty set. */
export function percentile(values: ArrayLike<number>, fraction: number): number {
  const count = values.length
  if (count === 0) return Number.NaN
  const sorted = Float64Array.from(values as ArrayLike<number>).sort()
  const rank = Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1))
  return sorted[rank]
}

/** Summarizes finite samples as p50/p95/p99/max, or null when there are none. */
export function summarize(values: ArrayLike<number>): Percentiles | null {
  const finite = Array.from(values).filter(value => Number.isFinite(value))
  if (finite.length === 0) return null
  const sorted = Float64Array.from(finite).sort()
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]
  }
}

/** Fixed-capacity ring of numbers. Writes never allocate after construction. */
export class NumberRing {
  private readonly values: Float64Array
  private next = 0
  private filled = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Ring capacity must be a positive integer.')
    this.values = new Float64Array(capacity)
  }

  push(value: number): void {
    this.values[this.next] = value
    this.next = (this.next + 1) % this.capacity
    if (this.filled < this.capacity) this.filled += 1
  }

  /** Copy of the stored values, oldest first. */
  toArray(): number[] {
    if (this.filled < this.capacity) return Array.from(this.values.subarray(0, this.filled))
    return Array.from(this.values.subarray(this.next)).concat(Array.from(this.values.subarray(0, this.next)))
  }

  clear(): void {
    this.next = 0
    this.filled = 0
  }

  get length(): number {
    return this.filled
  }
}

