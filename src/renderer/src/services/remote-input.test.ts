import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteInputMessage } from '../../../shared/remote-input'
import { normalizePointer, videoContentRect, ViewerInputForwarder } from './remote-input'

class FakeVideo extends EventTarget {
  videoWidth = 1600
  videoHeight = 900
  tabIndex = -1
  box = { left: 0, top: 0, width: 800, height: 600 }
  focus(): void { /* focus has no effect in the fake */ }
  getBoundingClientRect() {
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height }
  }
}

function pointerEvent(type: string, clientX: number, clientY: number, button = 0): Event {
  return Object.assign(new Event(type, { cancelable: true }), { clientX, clientY, button })
}

function keyEvent(type: 'keydown' | 'keyup', code: string, repeat = false): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code, repeat })
}

function stubFit(objectFit: string): void {
  vi.stubGlobal('getComputedStyle', () => ({ objectFit }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('viewer coordinate mapping', () => {
  it('maps pointers through the letterboxed frame when object-fit is contain', () => {
    stubFit('contain')
    const element = new FakeVideo()
    // 1600x900 frame in an 800x600 box: scaled to 800x450 and centred vertically at top 75.
    expect(videoContentRect(element as unknown as HTMLVideoElement)).toEqual({ left: 0, top: 75, width: 800, height: 450 })
    expect(normalizePointer(400, 300, element as unknown as HTMLVideoElement)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizePointer(0, 75, element as unknown as HTMLVideoElement)).toEqual({ x: 0, y: 0 })
    // Points in the letterbox bars clamp to the nearest frame edge instead of leaving the display.
    expect(normalizePointer(400, 10, element as unknown as HTMLVideoElement)).toEqual({ x: 0.5, y: 0 })
  })

  it('maps pointers through the cropped frame when object-fit is cover (actual-size mode)', () => {
    stubFit('cover')
    const element = new FakeVideo()
    const rect = videoContentRect(element as unknown as HTMLVideoElement)!
    expect(rect.height).toBeCloseTo(600)
    expect(rect.width).toBeCloseTo(1066.67, 1)
    expect(rect.left).toBeCloseTo(-133.33, 1)
    expect(normalizePointer(0, 300, element as unknown as HTMLVideoElement)!.x).toBeCloseTo(0.125, 3)
  })

  it('returns no mapping before the first frame has a size', () => {
    stubFit('contain')
    const element = new FakeVideo()
    element.videoWidth = 0
    expect(normalizePointer(10, 10, element as unknown as HTMLVideoElement)).toBeNull()
  })
})

describe('ViewerInputForwarder', () => {
  function setup() {
    const element = new FakeVideo()
    const sent: RemoteInputMessage[] = []
    stubFit('contain')
    const forwarder = new ViewerInputForwarder({ element: element as unknown as HTMLVideoElement, send: message => { sent.push(message); return true } })
    forwarder.attach()
    return { element, sent, forwarder }
  }

  it('sends one key-down per press, suppresses auto-repeat, and sends the key-up', () => {
    const { element, sent } = setup()
    element.dispatchEvent(keyEvent('keydown', 'KeyA'))
    element.dispatchEvent(keyEvent('keydown', 'KeyA', true))
    element.dispatchEvent(keyEvent('keyup', 'KeyA'))
    expect(sent).toEqual([
      { type: 'input:key', code: 'KeyA', down: true },
      { type: 'input:key', code: 'KeyA', down: false }
    ])
  })

  it('does not forward keys outside the reviewed map and lets the browser keep them', () => {
    const { element, sent } = setup()
    const event = keyEvent('keydown', 'OSLeft')
    element.dispatchEvent(event)
    expect(sent).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('releases held keys when the video loses focus', () => {
    const { element, sent, forwarder } = setup()
    element.dispatchEvent(keyEvent('keydown', 'ShiftLeft'))
    element.dispatchEvent(new Event('blur'))
    expect(sent).toContainEqual({ type: 'input:key', code: 'ShiftLeft', down: false })
    expect(forwarder.heldKeys).toBe(0)
  })

  it('sends each pointer move immediately, without a coalescing delay, and skips unchanged positions', () => {
    const { element, sent } = setup()
    const moves = () => sent.filter(message => message.type === 'input:move')
    element.dispatchEvent(pointerEvent('pointermove', 100, 100))
    expect(moves()).toHaveLength(1)
    element.dispatchEvent(pointerEvent('pointermove', 200, 200))
    element.dispatchEvent(pointerEvent('pointermove', 200, 200))
    expect(moves()).toHaveLength(2)
    element.dispatchEvent(pointerEvent('pointermove', 400, 300))
    expect(moves()).toHaveLength(3)
    expect(moves()[2]).toEqual({ type: 'input:move', x: 0.5, y: 0.5 })
  })

  it('releases buttons and keys when detached', () => {
    const { element, sent, forwarder } = setup()
    element.dispatchEvent(pointerEvent('pointerdown', 400, 300, 0))
    element.dispatchEvent(keyEvent('keydown', 'KeyQ'))
    sent.length = 0
    forwarder.detach()
    expect(sent).toEqual([
      { type: 'input:button', button: 'left', down: false, x: 0.5, y: 0.5 },
      { type: 'input:key', code: 'KeyQ', down: false },
      { type: 'input:release-all' }
    ])
  })

  it('sends wheel input with normalized position and suppresses page scrolling', () => {
    const { element, sent } = setup()
    const wheel = Object.assign(new Event('wheel', { cancelable: true }), { clientX: 400, clientY: 300, deltaX: 0, deltaY: 40, deltaMode: 0 })
    element.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(sent).toEqual([{ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 40 }])
  })
})
