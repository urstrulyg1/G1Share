import { createRequire } from 'node:module'
import type { RemoteMouseButton, RemoteInputMessage } from '../shared/remote-input'
import { normalizedToDisplayPoint, parseRemoteInputMessage, REMOTE_KEY_MAP } from '../shared/remote-input'
import { NumberRing, summarize } from '../shared/latency-stats'
import type { Percentiles } from '../shared/latency-stats'

/** Native operations needed to control a desktop. Implemented by libnut in production and by fakes in tests. */
export interface NativeInputBackend {
  readonly name: string
  moveMouse(x: number, y: number): void
  toggleMouse(button: RemoteMouseButton, down: boolean): void
  scroll(ticksX: number, ticksY: number): void
  toggleKey(nativeKey: string, down: boolean): void
}

export interface DisplayGeometry {
  /** Display bounds in Electron device-independent pixels (what screen.getAllDisplays reports). */
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export type InputSupport = { supported: true } | { supported: false; reason: string }

const MAX_INJECTIONS_PER_SECOND = 300
const MAX_WHEEL_TICKS = 10
const WHEEL_PIXELS_PER_TICK = 100

/**
 * Decides whether this desktop can receive injected input at all. Wayland sessions do not allow
 * an unprivileged process to inject input into native Wayland windows, so OpenDesk refuses rather
 * than reporting success for events that would be silently dropped. macOS needs the Accessibility
 * grant; the grant is requested by the OS prompt, never bypassed.
 */
export function remoteInputSupport(options: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  accessibilityTrusted?: boolean
  backendError?: string
}): InputSupport {
  if (options.platform === 'linux' && (options.env.XDG_SESSION_TYPE === 'wayland' || (!options.env.DISPLAY && !!options.env.WAYLAND_DISPLAY))) {
    return { supported: false, reason: 'Remote keyboard and mouse are not available on Wayland desktops. Log in to an X11 session to allow remote control.' }
  }
  if (options.platform !== 'linux' && options.platform !== 'win32' && options.platform !== 'darwin') {
    return { supported: false, reason: 'Remote keyboard and mouse are not implemented for this operating system.' }
  }
  if (options.backendError) {
    return { supported: false, reason: `The native input library could not be loaded: ${options.backendError}` }
  }
  if (options.platform === 'darwin' && options.accessibilityTrusted === false) {
    return { supported: false, reason: 'Grant OpenDesk Accessibility access in System Settings > Privacy & Security > Accessibility, then start remote control again.' }
  }
  return { supported: true }
}

/** Loads the libnut native binding for the current platform. Throws with a readable message when unavailable. */
export function loadLibnutBackend(): NativeInputBackend {
  const requireModule = createRequire(import.meta.url)
  let libnut: LibnutModule
  try {
    libnut = (requireModule('@nut-tree-fork/libnut/dist/import_libnut') as { libnut: LibnutModule }).libnut
  } catch (error) {
    throw new Error(error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'unknown loader error')
  }
  return createLibnutBackend(libnut)
}

interface LibnutModule {
  moveMouse(x: number, y: number): void
  mouseToggle(down: string, button: string): void
  scrollMouse(x: number, y: number): void
  keyToggle(key: string, down: string): void
}

export function createLibnutBackend(libnut: LibnutModule): NativeInputBackend {
  return {
    name: 'libnut',
    moveMouse: (x, y) => libnut.moveMouse(x, y),
    toggleMouse: (button, down) => libnut.mouseToggle(down ? 'down' : 'up', button),
    scroll: (ticksX, ticksY) => libnut.scrollMouse(ticksX, ticksY),
    toggleKey: (nativeKey, down) => libnut.keyToggle(nativeKey, down ? 'down' : 'up')
  }
}

/**
 * Converts a display-relative point to the coordinate space the native API expects. Windows and
 * X11 take physical pixels; macOS CoreGraphics takes points, which match Electron's DIP values.
 */
export function nativePoint(point: { x: number; y: number }, geometry: DisplayGeometry, platform: NodeJS.Platform): { x: number; y: number } {
  if (platform === 'darwin') return point
  const scale = Number.isFinite(geometry.scaleFactor) && geometry.scaleFactor > 0 ? geometry.scaleFactor : 1
  return { x: Math.round(point.x * scale), y: Math.round(point.y * scale) }
}

/**
 * Owns the single active remote-control grant. Injection is accepted only between `start` and `stop`,
 * tracks which keys and buttons are down so that they can always be released, and rate-limits
 * ordinary input. Releases bypass the limiter so that a burst can never leave a key stuck.
 */
export class RemoteInputController {
  private sessionId: string | null = null
  private geometry: DisplayGeometry | null = null
  private readonly pressedKeys = new Set<string>()
  private readonly pressedButtons = new Set<RemoteMouseButton>()
  private tokens = MAX_INJECTIONS_PER_SECOND
  private refilledAt = 0
  private lastPoint: { x: number; y: number } | null = null
  /** Native dispatch durations in microseconds. Only timings are kept, never key codes or coordinates. */
  private readonly dispatchMicros = new NumberRing(1024)

  constructor(
    private readonly backend: NativeInputBackend,
    private readonly platform: NodeJS.Platform,
    private readonly now: () => number = () => Date.now()
  ) {}

  get active(): boolean {
    return this.sessionId !== null
  }

  get activeSessionId(): string | null {
    return this.sessionId
  }

  start(sessionId: string, geometry: DisplayGeometry): void {
    if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new TypeError('Remote input session ID is invalid.')
    if (!Number.isFinite(geometry.bounds.width) || !Number.isFinite(geometry.bounds.height) || geometry.bounds.width < 1 || geometry.bounds.height < 1) {
      throw new TypeError('The shared display geometry is invalid.')
    }
    this.releaseAll()
    this.sessionId = sessionId
    this.geometry = geometry
    this.tokens = MAX_INJECTIONS_PER_SECOND
    this.refilledAt = this.now()
  }

  stop(): void {
    this.releaseAll()
    this.sessionId = null
    this.geometry = null
    this.lastPoint = null
  }

  /** Releases every key and mouse button that OpenDesk currently holds down on this machine. */
  releaseAll(): void {
    for (const button of this.pressedButtons) this.safely(() => this.backend.toggleMouse(button, false))
    this.pressedButtons.clear()
    for (const key of this.pressedKeys) this.safely(() => this.backend.toggleKey(key, false))
    this.pressedKeys.clear()
  }

  get heldKeyCount(): number {
    return this.pressedKeys.size
  }

  get heldButtonCount(): number {
    return this.pressedButtons.size
  }

  inject(payload: unknown): void {
    if (!this.sessionId || !this.geometry) throw new Error('Remote control is not active for this session.')
    const message = parseRemoteInputMessage(payload)
    if (!message) throw new TypeError('Remote input message is invalid.')
    if (message.type === 'input:release-all') {
      this.releaseAll()
      return
    }
    const isRelease = (message.type === 'input:key' || message.type === 'input:button') && !message.down
    if (!isRelease) this.consumeToken()
    // performance.now() is monotonic in Node (Electron main) and in browsers, so the same code runs in the harness.
    const started = performance.now()
    this.dispatch(message)
    this.dispatchMicros.push((performance.now() - started) * 1000)
  }

  /** Percentiles of native dispatch time for recent injections, or null before the first one. */
  dispatchTiming(): Percentiles | null {
    return summarize(this.dispatchMicros.toArray())
  }

  private dispatch(message: RemoteInputMessage): void {
    switch (message.type) {
      case 'input:release-all':
        this.releaseAll()
        return
      case 'input:move':
        this.moveTo(message.x, message.y)
        return
      case 'input:button':
        this.moveTo(message.x, message.y)
        this.toggleButton(message.button, message.down)
        return
      case 'input:wheel':
        this.moveTo(message.x, message.y)
        this.wheel(message.deltaX, message.deltaY)
        return
      case 'input:key':
        this.toggleKey(message.code, message.down)
        return
    }
  }

  private moveTo(x: number, y: number): void {
    const geometry = this.geometry!
    const point = normalizedToDisplayPoint(x, y, geometry.bounds)
    if (this.lastPoint && this.lastPoint.x === point.x && this.lastPoint.y === point.y) return
    this.lastPoint = point
    const native = nativePoint(point, geometry, this.platform)
    this.backend.moveMouse(native.x, native.y)
  }

  private toggleButton(button: RemoteMouseButton, down: boolean): void {
    if (down === this.pressedButtons.has(button)) return
    this.backend.toggleMouse(button, down)
    if (down) this.pressedButtons.add(button)
    else this.pressedButtons.delete(button)
  }

  private toggleKey(code: string, down: boolean): void {
    const nativeKey = REMOTE_KEY_MAP[code]
    if (!nativeKey) throw new TypeError('Remote key is not supported.')
    if (down === this.pressedKeys.has(nativeKey)) return
    this.backend.toggleKey(nativeKey, down)
    if (down) this.pressedKeys.add(nativeKey)
    else this.pressedKeys.delete(nativeKey)
  }

  private wheel(deltaX: number, deltaY: number): void {
    const ticks = (delta: number) => {
      if (delta === 0) return 0
      const magnitude = Math.min(MAX_WHEEL_TICKS, Math.max(1, Math.ceil(Math.abs(delta) / WHEEL_PIXELS_PER_TICK)))
      return delta < 0 ? -magnitude : magnitude
    }
    const x = ticks(deltaX)
    const y = ticks(deltaY)
    if (x !== 0 || y !== 0) this.backend.scroll(x, y)
  }

  private consumeToken(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.refilledAt)
    this.tokens = Math.min(MAX_INJECTIONS_PER_SECOND, this.tokens + elapsed * MAX_INJECTIONS_PER_SECOND / 1000)
    this.refilledAt = now
    if (this.tokens < 1) throw new Error('Remote input rate limit exceeded; excess events were dropped.')
    this.tokens -= 1
  }

  private safely(operation: () => void): void {
    try { operation() } catch (error) {
      console.error('A native input release failed.', error instanceof Error ? error.message : error)
    }
  }
}

export type { RemoteInputMessage }
