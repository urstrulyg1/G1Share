// Remote keyboard and pointer protocol shared by the viewer, the host renderer, and the
// Electron main process. Every message crosses a trust boundary (WebRTC data channel,
// renderer, IPC), so both ends validate with the same strict schema before acting.

export const REMOTE_INPUT_PREFIX = 'input:'
export const MAX_REMOTE_INPUT_MESSAGE_BYTES = 512
export const MAX_WHEEL_DELTA = 10_000

export type RemoteMouseButton = 'left' | 'middle' | 'right'

/** Viewer -> host messages. Coordinates are normalized to the shared display (0 = left/top, 1 = right/bottom). */
export type RemoteInputMessage =
  | { type: 'input:move'; x: number; y: number }
  | { type: 'input:button'; button: RemoteMouseButton; down: boolean; x: number; y: number }
  | { type: 'input:wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'input:key'; code: string; down: boolean }
  | { type: 'input:release-all' }

/** Host -> viewer control messages on the same channel. */
export type RemoteInputNotice =
  | { type: 'input:ready' }
  | { type: 'input:revoked'; reason: string }
  | { type: 'input:unavailable'; reason: string }

/**
 * DOM KeyboardEvent.code -> libnut key name. Only physical keys in this table can be injected;
 * any other code is rejected. Layout-dependent characters are sent by physical key position.
 */
export const REMOTE_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`Key${String.fromCharCode(65 + index)}`, String.fromCharCode(97 + index)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`F${index + 1}`, `f${index + 1}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Numpad${index}`, `numpad_${index}`])),
  NumpadDecimal: 'numpad_decimal',
  NumpadEqual: 'numpad_equal',
  NumpadAdd: 'add',
  NumpadSubtract: 'subtract',
  NumpadMultiply: 'multiply',
  NumpadDivide: 'divide',
  NumpadEnter: 'enter',
  NumLock: 'num_lock',
  Space: 'space',
  Escape: 'escape',
  Tab: 'tab',
  Enter: 'return',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: 'meta',
  MetaRight: 'right_meta',
  ContextMenu: 'menu',
  CapsLock: 'caps_lock',
  ScrollLock: 'scroll_lock',
  PrintScreen: 'printscreen',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
})

const MOUSE_BUTTONS: ReadonlySet<string> = new Set(['left', 'middle', 'right'])

function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function finiteDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_WHEEL_DELTA
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/**
 * Returns a normalized copy of a remote input message, or null when the message is not a
 * well-formed input message. Unknown fields, out-of-range numbers, and unmapped key codes
 * are rejected rather than coerced.
 */
export function parseRemoteInputMessage(value: unknown): RemoteInputMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  const type = message.type
  if (typeof type !== 'string' || !type.startsWith(REMOTE_INPUT_PREFIX)) return null
  switch (type) {
    case 'input:move':
      if (!onlyKeys(message, ['type', 'x', 'y']) || !finiteUnit(message.x) || !finiteUnit(message.y)) return null
      return { type, x: message.x, y: message.y }
    case 'input:button':
      if (!onlyKeys(message, ['type', 'button', 'down', 'x', 'y']) || typeof message.button !== 'string' || !MOUSE_BUTTONS.has(message.button)
        || typeof message.down !== 'boolean' || !finiteUnit(message.x) || !finiteUnit(message.y)) return null
      return { type, button: message.button as RemoteMouseButton, down: message.down, x: message.x, y: message.y }
    case 'input:wheel':
      if (!onlyKeys(message, ['type', 'x', 'y', 'deltaX', 'deltaY']) || !finiteUnit(message.x) || !finiteUnit(message.y)
        || !finiteDelta(message.deltaX) || !finiteDelta(message.deltaY)) return null
      return { type, x: message.x, y: message.y, deltaX: message.deltaX, deltaY: message.deltaY }
    case 'input:key':
      if (!onlyKeys(message, ['type', 'code', 'down']) || typeof message.code !== 'string' || !Object.prototype.hasOwnProperty.call(REMOTE_KEY_MAP, message.code)
        || typeof message.down !== 'boolean') return null
      return { type, code: message.code, down: message.down }
    case 'input:release-all':
      if (!onlyKeys(message, ['type'])) return null
      return { type }
    default:
      return null
  }
}

/** Parses a data-channel payload. Returns null for any non-input or malformed payload. */
export function parseRemoteInputPayload(payload: unknown): RemoteInputMessage | null {
  if (typeof payload !== 'string' || payload.length > MAX_REMOTE_INPUT_MESSAGE_BYTES) return null
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { return null }
  return parseRemoteInputMessage(parsed)
}

/** Host -> viewer notices. Used to tell the viewer when control is ready, revoked, or unavailable. */
export function parseRemoteInputNotice(value: unknown): RemoteInputNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.type === 'input:ready' && onlyKeys(message, ['type'])) return { type: 'input:ready' }
  if ((message.type === 'input:revoked' || message.type === 'input:unavailable') && onlyKeys(message, ['type', 'reason'])
    && typeof message.reason === 'string' && message.reason.length <= 200) {
    return { type: message.type, reason: message.reason }
  }
  return null
}

/** Maps a DOM button index to a supported mouse button, or null for unsupported buttons. */
export function mouseButtonFromDOM(button: number): RemoteMouseButton | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

/**
 * Converts a normalized point to display coordinates. The result is clamped to the display
 * bounds so that a malformed or boundary value can never leave the captured screen.
 */
export function normalizedToDisplayPoint(x: number, y: number, bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const clampUnit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const width = Math.max(1, bounds.width)
  const height = Math.max(1, bounds.height)
  const px = bounds.x + Math.min(width - 1, Math.round(clampUnit(x) * (width - 1)))
  const py = bounds.y + Math.min(height - 1, Math.round(clampUnit(y) * (height - 1)))
  return { x: px, y: py }
}
