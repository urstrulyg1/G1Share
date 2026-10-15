import { mouseButtonFromDOM, REMOTE_KEY_MAP } from '../../../shared/remote-input'
import type { RemoteInputMessage, RemoteMouseButton } from '../../../shared/remote-input'

export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Returns where the decoded video frame is drawn inside the element, honoring object-fit.
 * Pointer positions are measured against this rectangle, not the element box, so letterboxing
 * and cropping do not shift the remote pointer.
 */
export function videoContentRect(element: HTMLVideoElement): ContentRect | null {
  const box = element.getBoundingClientRect()
  const frameWidth = element.videoWidth
  const frameHeight = element.videoHeight
  if (!frameWidth || !frameHeight || box.width <= 0 || box.height <= 0) return null
  const fit = getComputedStyle(element).objectFit
  const scale = fit === 'cover'
    ? Math.max(box.width / frameWidth, box.height / frameHeight)
    : fit === 'fill' ? null
      : Math.min(box.width / frameWidth, box.height / frameHeight)
  const width = scale === null ? box.width : frameWidth * scale
  const height = scale === null ? box.height : frameHeight * scale
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
}

/** Converts a client-space point to normalized frame coordinates, or null when outside the frame. */
export function normalizePointer(clientX: number, clientY: number, element: HTMLVideoElement): { x: number; y: number } | null {
  const rect = videoContentRect(element)
  if (!rect) return null
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  // Points inside the element but outside the drawn frame (letterbox bars or cropped cover area) are clamped to the edge.
  return { x: clamp(x), y: clamp(y) }
}

export interface ViewerInputOptions {
  element: HTMLVideoElement
  send: (message: RemoteInputMessage) => boolean
}

/**
 * Captures keyboard and pointer input over the remote display and sends it as normalized messages.
 * Everything that is pressed is tracked so that it is released when focus leaves the video, when
 * the forwarder is detached, or when the host revokes control. A stuck remote key is never left behind.
 */
export class ViewerInputForwarder {
  private attached = false
  private readonly pressedKeys = new Set<string>()
  private readonly pressedButtons = new Set<RemoteMouseButton>()
  private lastPoint: { x: number; y: number } = { x: 0.5, y: 0.5 }
  private lastSentMove: { x: number; y: number } | null = null

  constructor(private readonly options: ViewerInputOptions) {}

  attach(): void {
    if (this.attached) return
    this.attached = true
    const element = this.options.element
    element.tabIndex = 0
    element.addEventListener('pointermove', this.onPointerMove)
    element.addEventListener('pointerdown', this.onPointerDown)
    element.addEventListener('wheel', this.onWheel, { passive: false })
    element.addEventListener('contextmenu', this.onContextMenu)
    element.addEventListener('keydown', this.onKeyDown)
    element.addEventListener('keyup', this.onKeyUp)
    element.addEventListener('blur', this.onBlur)
    window.addEventListener('pointerup', this.onPointerUp)
  }

  detach(): void {
    if (!this.attached) return
    this.releaseAll()
    this.attached = false
    const element = this.options.element
    element.removeEventListener('pointermove', this.onPointerMove)
    element.removeEventListener('pointerdown', this.onPointerDown)
    element.removeEventListener('wheel', this.onWheel)
    element.removeEventListener('contextmenu', this.onContextMenu)
    element.removeEventListener('keydown', this.onKeyDown)
    element.removeEventListener('keyup', this.onKeyUp)
    element.removeEventListener('blur', this.onBlur)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.lastSentMove = null
  }

  /** Sends releases for every key and button currently held by the viewer. */
  releaseAll(): void {
    for (const button of this.pressedButtons) this.options.send({ type: 'input:button', button, down: false, x: this.lastPoint.x, y: this.lastPoint.y })
    this.pressedButtons.clear()
    for (const code of this.pressedKeys) this.options.send({ type: 'input:key', code, down: false })
    this.pressedKeys.clear()
    this.options.send({ type: 'input:release-all' })
  }

  get heldKeys(): number {
    return this.pressedKeys.size
  }

  /**
   * Pointer motion is sent as soon as the browser delivers it. Chromium already aligns pointermove to animation
   * frames, so this is at most one message per frame, without the extra wait a coalescing timer would add.
   * A move to the position that was just sent is skipped, because it carries no new information.
   */
  private readonly onPointerMove = (event: PointerEvent) => {
    const point = normalizePointer(event.clientX, event.clientY, this.options.element)
    if (!point) return
    this.lastPoint = point
    if (this.lastSentMove && this.lastSentMove.x === point.x && this.lastSentMove.y === point.y) return
    this.lastSentMove = point
    this.options.send({ type: 'input:move', x: point.x, y: point.y })
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    const button = mouseButtonFromDOM(event.button)
    if (!button) return
    event.preventDefault()
    this.options.element.focus({ preventScroll: true })
    const point = normalizePointer(event.clientX, event.clientY, this.options.element)
    if (!point) return
    this.lastPoint = point
    this.lastSentMove = point
    this.pressedButtons.add(button)
    this.options.send({ type: 'input:button', button, down: true, x: point.x, y: point.y })
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const button = mouseButtonFromDOM(event.button)
    if (!button || !this.pressedButtons.has(button)) return
    this.pressedButtons.delete(button)
    this.options.send({ type: 'input:button', button, down: false, x: this.lastPoint.x, y: this.lastPoint.y })
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const point = normalizePointer(event.clientX, event.clientY, this.options.element)
    if (!point) return
    // DOM_DELTA_LINE = 1 and DOM_DELTA_PAGE = 2 per the UI Events specification.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1
    const deltaX = Math.max(-10_000, Math.min(10_000, Math.round(event.deltaX * scale)))
    const deltaY = Math.max(-10_000, Math.min(10_000, Math.round(event.deltaY * scale)))
    if (deltaX === 0 && deltaY === 0) return
    this.options.send({ type: 'input:wheel', x: point.x, y: point.y, deltaX, deltaY })
  }

  private readonly onContextMenu = (event: Event) => event.preventDefault()

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!Object.prototype.hasOwnProperty.call(REMOTE_KEY_MAP, event.code)) return
    event.preventDefault()
    if (event.repeat || this.pressedKeys.has(event.code)) return
    this.pressedKeys.add(event.code)
    this.options.send({ type: 'input:key', code: event.code, down: true })
  }

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (!this.pressedKeys.has(event.code)) return
    event.preventDefault()
    this.pressedKeys.delete(event.code)
    this.options.send({ type: 'input:key', code: event.code, down: false })
  }

  private readonly onBlur = () => this.releaseAll()
}
