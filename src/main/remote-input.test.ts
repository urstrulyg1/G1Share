import { describe, expect, it } from 'vitest'
import { createLibnutBackend, nativePoint, RemoteInputController, remoteInputSupport } from './remote-input'
import type { DisplayGeometry, NativeInputBackend } from './remote-input'

const SESSION = 'a'.repeat(32)
const GEOMETRY: DisplayGeometry = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }

function fakeBackend() {
  const calls: Array<[string, ...unknown[]]> = []
  const backend: NativeInputBackend = {
    name: 'fake',
    moveMouse: (x, y) => calls.push(['move', x, y]),
    toggleMouse: (button, down) => calls.push(['mouse', button, down]),
    scroll: (x, y) => calls.push(['scroll', x, y]),
    toggleKey: (key, down) => calls.push(['key', key, down])
  }
  return { backend, calls }
}

describe('remoteInputSupport', () => {
  it('refuses Wayland sessions because injected input would be silently dropped', () => {
    const result = remoteInputSupport({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' } })
    expect(result).toMatchObject({ supported: false })
    expect(remoteInputSupport({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toMatchObject({ supported: false })
  })

  it('reports native library load failures as the reason', () => {
    const result = remoteInputSupport({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, backendError: 'libXtst.so.6: cannot open shared object file' })
    expect(result).toEqual({ supported: false, reason: expect.stringContaining('libXtst.so.6') })
  })

  it('requires the macOS Accessibility grant and leaves other operating systems unsupported', () => {
    expect(remoteInputSupport({ platform: 'darwin', env: {}, accessibilityTrusted: false })).toMatchObject({ supported: false })
    expect(remoteInputSupport({ platform: 'darwin', env: {}, accessibilityTrusted: true })).toEqual({ supported: true })
    expect(remoteInputSupport({ platform: 'win32', env: {} })).toEqual({ supported: true })
    expect(remoteInputSupport({ platform: 'freebsd', env: {} })).toMatchObject({ supported: false })
  })
})

describe('createLibnutBackend', () => {
  it('translates controller operations into the libnut call conventions', () => {
    const calls: unknown[][] = []
    const backend = createLibnutBackend({
      moveMouse: (x, y) => calls.push(['moveMouse', x, y]),
      mouseToggle: (down, button) => calls.push(['mouseToggle', down, button]),
      scrollMouse: (x, y) => calls.push(['scrollMouse', x, y]),
      keyToggle: (key, down) => calls.push(['keyToggle', key, down])
    })
    backend.moveMouse(10, 20)
    backend.toggleMouse('right', true)
    backend.toggleMouse('right', false)
    backend.scroll(0, -3)
    backend.toggleKey('a', true)
    backend.toggleKey('a', false)
    expect(calls).toEqual([
      ['moveMouse', 10, 20],
      ['mouseToggle', 'down', 'right'],
      ['mouseToggle', 'up', 'right'],
      ['scrollMouse', 0, -3],
      ['keyToggle', 'a', 'down'],
      ['keyToggle', 'a', 'up']
    ])
  })
})

describe('nativePoint', () => {
  it('uses physical pixels on Windows and X11 and points on macOS', () => {
    const scaled = { ...GEOMETRY, scaleFactor: 1.5 }
    expect(nativePoint({ x: 100, y: 50 }, scaled, 'win32')).toEqual({ x: 150, y: 75 })
    expect(nativePoint({ x: 100, y: 50 }, scaled, 'linux')).toEqual({ x: 150, y: 75 })
    expect(nativePoint({ x: 100, y: 50 }, scaled, 'darwin')).toEqual({ x: 100, y: 50 })
    expect(nativePoint({ x: 100, y: 50 }, { ...GEOMETRY, scaleFactor: Number.NaN }, 'win32')).toEqual({ x: 100, y: 50 })
  })
})

describe('RemoteInputController', () => {
  it('rejects injection until a session is started and rejects malformed sessions', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    expect(() => controller.inject({ type: 'input:move', x: 0.5, y: 0.5 })).toThrow('not active')
    expect(() => controller.start('not-a-session', GEOMETRY)).toThrow(TypeError)
    expect(() => controller.start(SESSION, { ...GEOMETRY, bounds: { x: 0, y: 0, width: 0, height: 10 } })).toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it('maps normalized pointer positions through the captured display bounds', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    controller.start(SESSION, { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 })
    controller.inject({ type: 'input:move', x: 0, y: 0 })
    controller.inject({ type: 'input:move', x: 1, y: 1 })
    expect(calls).toEqual([['move', 1920, 0], ['move', 3839, 1079]])
  })

  it('tracks held buttons and keys and releases every one of them on stop', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:button', button: 'left', down: true, x: 0.1, y: 0.1 })
    controller.inject({ type: 'input:key', code: 'ShiftLeft', down: true })
    controller.inject({ type: 'input:key', code: 'KeyA', down: true })
    controller.inject({ type: 'input:key', code: 'KeyA', down: true })
    expect(controller.heldKeyCount).toBe(2)
    expect(controller.heldButtonCount).toBe(1)
    calls.length = 0
    controller.stop()
    expect(calls).toEqual(expect.arrayContaining([
      ['mouse', 'left', false],
      ['key', 'shift', false],
      ['key', 'a', false]
    ]))
    expect(calls.filter(call => call[0] === 'key' && call[1] === 'a')).toHaveLength(1)
    expect(controller.active).toBe(false)
    expect(controller.heldKeyCount).toBe(0)
  })

  it('ignores duplicate key-down and key-up events for keys it does not hold', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:key', code: 'KeyB', down: false })
    controller.inject({ type: 'input:key', code: 'KeyB', down: true })
    controller.inject({ type: 'input:key', code: 'KeyB', down: true })
    controller.inject({ type: 'input:key', code: 'KeyB', down: false })
    expect(calls).toEqual([['key', 'b', true], ['key', 'b', false]])
  })

  it('converts wheel deltas to bounded scroll ticks', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 250 })
    controller.inject({ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: -1, deltaY: 0 })
    controller.inject({ type: 'input:wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 9_000 })
    expect(calls.filter(call => call[0] === 'scroll')).toEqual([['scroll', 0, 3], ['scroll', -1, 0], ['scroll', 0, 10]])
  })

  it('rate-limits ordinary input but never drops releases', () => {
    let now = 0
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32', () => now)
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:key', code: 'KeyC', down: true })
    for (let index = 0; index < 299; index += 1) {
      controller.inject({ type: 'input:move', x: index / 1000, y: 0.5 })
    }
    expect(() => controller.inject({ type: 'input:move', x: 0.9, y: 0.9 })).toThrow('rate limit')
    controller.inject({ type: 'input:key', code: 'KeyC', down: false })
    expect(calls.at(-1)).toEqual(['key', 'c', false])
    now += 1000
    controller.inject({ type: 'input:move', x: 0.2, y: 0.2 })
    expect(calls.at(-1)?.[0]).toBe('move')
  })

  it('releases all held state when a new session starts and when release-all arrives', () => {
    const { backend, calls } = fakeBackend()
    const controller = new RemoteInputController(backend, 'win32')
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:key', code: 'KeyD', down: true })
    controller.inject({ type: 'input:release-all' })
    expect(calls.at(-1)).toEqual(['key', 'd', false])
    controller.inject({ type: 'input:key', code: 'KeyE', down: true })
    controller.start('b'.repeat(32), GEOMETRY)
    expect(calls.at(-1)).toEqual(['key', 'e', false])
    expect(controller.activeSessionId).toBe('b'.repeat(32))
  })

  it('keeps going when the native layer fails during release', () => {
    const { backend } = fakeBackend()
    let failures = 0
    const flaky: NativeInputBackend = {
      ...backend,
      toggleKey: (key, down) => {
        if (!down) { failures += 1; throw new Error('native failure') }
        backend.toggleKey(key, down)
      }
    }
    const controller = new RemoteInputController(flaky, 'win32')
    controller.start(SESSION, GEOMETRY)
    controller.inject({ type: 'input:key', code: 'KeyF', down: true })
    expect(() => controller.stop()).not.toThrow()
    expect(failures).toBe(1)
    expect(controller.heldKeyCount).toBe(0)
  })
})
