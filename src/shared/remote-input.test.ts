import { describe, expect, it } from 'vitest'
import {
  MAX_REMOTE_INPUT_MESSAGE_BYTES,
  mouseButtonFromDOM,
  normalizedToDisplayPoint,
  parseRemoteInputMessage,
  parseRemoteInputNotice,
  parseRemoteInputPayload,
  REMOTE_KEY_MAP
} from './remote-input'

describe('remote input protocol', () => {
  it('accepts well-formed pointer, button, wheel, key, and release messages', () => {
    expect(parseRemoteInputMessage({ type: 'input:move', x: 0.25, y: 1 })).toEqual({ type: 'input:move', x: 0.25, y: 1 })
    expect(parseRemoteInputMessage({ type: 'input:button', button: 'right', down: true, x: 0, y: 0 })).toEqual({ type: 'input:button', button: 'right', down: true, x: 0, y: 0 })
    expect(parseRemoteInputMessage({ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: -120, deltaY: 240 })).toEqual({ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: -120, deltaY: 240 })
    expect(parseRemoteInputMessage({ type: 'input:key', code: 'KeyA', down: false })).toEqual({ type: 'input:key', code: 'KeyA', down: false })
    expect(parseRemoteInputMessage({ type: 'input:release-all' })).toEqual({ type: 'input:release-all' })
  })

  it('rejects unknown fields, wrong types, out-of-range coordinates, and unknown message types', () => {
    expect(parseRemoteInputMessage({ type: 'input:move', x: 0.5, y: 0.5, extra: true })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:move', x: '0.5', y: 0.5 })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:move', x: 1.5, y: 0.5 })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:move', x: Number.NaN, y: 0.5 })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:button', button: 'back', down: true, x: 0, y: 0 })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:key', code: 'KeyA', down: 'yes' })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:wheel', x: 0, y: 0, deltaX: 0, deltaY: 20_000 })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:launch-shell' })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'clipboard:text', text: 'x' })).toBeNull()
    expect(parseRemoteInputMessage(null)).toBeNull()
    expect(parseRemoteInputMessage(['input:move'])).toBeNull()
  })

  it('accepts only physical key codes from the reviewed map', () => {
    expect(parseRemoteInputMessage({ type: 'input:key', code: 'OSLeft', down: true })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:key', code: '__proto__', down: true })).toBeNull()
    expect(parseRemoteInputMessage({ type: 'input:key', code: 'constructor', down: true })).toBeNull()
    expect(REMOTE_KEY_MAP.KeyA).toBe('a')
    expect(REMOTE_KEY_MAP.ArrowUp).toBe('up')
    expect(REMOTE_KEY_MAP.Enter).toBe('return')
    expect(Object.isFrozen(REMOTE_KEY_MAP)).toBe(true)
  })

  it('parses data-channel payloads and enforces the size limit', () => {
    expect(parseRemoteInputPayload(JSON.stringify({ type: 'input:move', x: 0, y: 1 }))).toEqual({ type: 'input:move', x: 0, y: 1 })
    expect(parseRemoteInputPayload('{not json')).toBeNull()
    expect(parseRemoteInputPayload(42)).toBeNull()
    const oversized = JSON.stringify({ type: 'input:key', code: 'KeyA', down: true, padding: 'x'.repeat(MAX_REMOTE_INPUT_MESSAGE_BYTES) })
    expect(parseRemoteInputPayload(oversized)).toBeNull()
  })

  it('parses host notices strictly', () => {
    expect(parseRemoteInputNotice({ type: 'input:ready' })).toEqual({ type: 'input:ready' })
    expect(parseRemoteInputNotice({ type: 'input:revoked', reason: 'stopped' })).toEqual({ type: 'input:revoked', reason: 'stopped' })
    expect(parseRemoteInputNotice({ type: 'input:ready', reason: 'extra' })).toBeNull()
    expect(parseRemoteInputNotice({ type: 'input:unavailable', reason: 'x'.repeat(201) })).toBeNull()
    expect(parseRemoteInputNotice({ type: 'input:move', x: 0, y: 0 })).toBeNull()
  })

  it('maps DOM mouse buttons and clamps display coordinates to the captured display', () => {
    expect(mouseButtonFromDOM(0)).toBe('left')
    expect(mouseButtonFromDOM(1)).toBe('middle')
    expect(mouseButtonFromDOM(2)).toBe('right')
    expect(mouseButtonFromDOM(3)).toBeNull()

    const bounds = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(normalizedToDisplayPoint(0, 0, bounds)).toEqual({ x: 1920, y: 0 })
    expect(normalizedToDisplayPoint(1, 1, bounds)).toEqual({ x: 3839, y: 1079 })
    expect(normalizedToDisplayPoint(0.5, 0.5, bounds)).toEqual({ x: 2880, y: 540 })
    expect(normalizedToDisplayPoint(-3, 9, bounds)).toEqual({ x: 1920, y: 1079 })
    expect(normalizedToDisplayPoint(Number.NaN, 0.5, bounds)).toEqual({ x: 1920, y: 540 })
  })
})
