import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidDeviceId } from '../shared/device-id'

const currentDir = dirname(fileURLToPath(import.meta.url))
const PROJECT_URL = 'https://github.com/urstrulyg1/G1Share'
let mainWindow: BrowserWindow | null = null
let identityPromise: Promise<string> | null = null

async function createOrReadDeviceId(): Promise<string> {
  const dir = join(app.getPath('userData'), 'identity')
  const file = join(dir, 'device-id')
  try {
    const stored = (await readFile(file, 'utf8')).trim()
    if (isValidDeviceId(stored)) return stored
  } catch { /* First launch: create a new local identity. */ }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const hex = randomBytes(6).toString('hex').toUpperCase()
  const id = hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12)
  await writeFile(file, id + '\n', { encoding: 'utf8', mode: 0o600 })
  return id
}

function loadOrCreateDeviceId(): Promise<string> {
  if (!identityPromise) identityPromise = createOrReadDeviceId()
  return identityPromise
}

function registerIpcHandlers(): void {
  ipcMain.handle('device:get-info', async () => ({
    deviceId: await loadOrCreateDeviceId(),
    appVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch
  }))
  ipcMain.handle('system:copy-text', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 10000) throw new TypeError('Clipboard text must be a string of at most 10,000 characters.')
    clipboard.writeText(value)
  })
  ipcMain.handle('project:open', async () => shell.openExternal(PROJECT_URL))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 640, show: false,
    backgroundColor: '#0b1020', title: 'OpenDesk',
    webPreferences: {
      preload: join(currentDir, '../preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file://')) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(currentDir, '../renderer/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
