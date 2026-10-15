import { describe, expect, it } from 'vitest'
import { NumberRing, percentile, summarize } from './latency-stats'

describe('percentile (nearest rank)', () => {
  it('returns the value at ceil(fraction * n) - 1 of the sorted samples', () => {
    const values = [5, 1, 4, 2, 3]
    expect(percentile(values, 0.5)).toBe(3)
    expect(percentile(values, 0.95)).toBe(5)
    expect(percentile(values, 0.2)).toBe(1)
  })

  it('does not reorder the caller\'s array', () => {
    const values = [3, 1, 2]
    percentile(values, 0.5)
    expect(values).toEqual([3, 1, 2])
  })

  it('returns NaN for an empty set and clamps out-of-range fractions', () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true)
    expect(percentile([7, 8], -1)).toBe(7)
    expect(percentile([7, 8], 2)).toBe(8)
  })
})

describe('summarize', () => {
  it('reports count, p50, p95, p99 and max of finite samples only', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1)
    const result = summarize([...samples, Number.NaN, Number.POSITIVE_INFINITY])
    expect(result).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 })
  })

  it('returns null when no finite sample exists', () => {
    expect(summarize([])).toBeNull()
    expect(summarize([Number.NaN, Number.NaN])).toBeNull()
  })
})

describe('NumberRing', () => {
  it('keeps the newest values in arrival order once full', () => {
    const ring = new NumberRing(3)
    for (const value of [1, 2, 3, 4, 5]) ring.push(value)
    expect(ring.toArray()).toEqual([3, 4, 5])
  })

  it('returns only the values written so far before it fills', () => {
    const ring = new NumberRing(4)
    ring.push(9)
    ring.push(8)
    expect(ring.toArray()).toEqual([9, 8])
  })

  it('clears without reallocating', () => {
    const ring = new NumberRing(2)
    ring.push(1)
    ring.clear()
    expect(ring.toArray()).toEqual([])
    ring.push(2)
    expect(ring.toArray()).toEqual([2])
  })

  it('rejects capacities that cannot hold a sample', () => {
    expect(() => new NumberRing(0)).toThrow(RangeError)
    expect(() => new NumberRing(1.5)).toThrow(RangeError)
  })
})
