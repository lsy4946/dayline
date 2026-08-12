const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { autoUpdater } = require('electron-updater')
const { createDaylineDatabase } = require('./database.cjs')
const {
  configureAutoUpdater,
  createUpdaterController,
  getUpdateSupport,
} = require('./updater.cjs')

let mainWindow = null
let widgetWindow = null
let taskDatabase = null
let windowStatePath = ''
let persistBoundsTimer = null
let updaterController = null
let databaseWritesBlocked = false

const isDev = !app.isPackaged
const isDatabaseQa = process.env.DAYLINE_DATABASE_QA === '1'

if (isDatabaseQa) {
  if (!process.env.DAYLINE_DATABASE_QA_USER_DATA) {
    throw new Error('DAYLINE_DATABASE_QA_USER_DATA is required in database QA mode')
  }
  app.setPath('userData', path.resolve(process.env.DAYLINE_DATABASE_QA_USER_DATA))
} else if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Dayline Dev'))
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`
  const payload = JSON.stringify(value, null, 2)
  fs.writeFileSync(tempPath, payload, 'utf8')
  try {
    fs.renameSync(tempPath, filePath)
  } catch {
    fs.copyFileSync(tempPath, filePath)
    fs.unlinkSync(tempPath)
  }
}

function defaultWindowState() {
  return {
    widget: {
      bounds: { width: 390, height: 620 },
      pinned: true,
      locked: false,
    },
  }
}

function readWindowState() {
  if (!fs.existsSync(windowStatePath)) return defaultWindowState()
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'))
    return {
      widget: {
        bounds: parsed?.widget?.bounds || { width: 390, height: 620 },
        pinned: parsed?.widget?.pinned !== false,
        locked: parsed?.widget?.locked === true,
      },
    }
  } catch {
    return defaultWindowState()
  }
}

function writeWindowState(nextState) {
  atomicWriteJson(windowStatePath, nextState)
}

function clampWidgetBounds(rawBounds) {
  const fallback = { width: 390, height: 620 }
  const desired = {
    x: Number.isFinite(rawBounds?.x) ? Math.round(rawBounds.x) : undefined,
    y: Number.isFinite(rawBounds?.y) ? Math.round(rawBounds.y) : undefined,
    width: Math.max(320, Math.min(760, Math.round(rawBounds?.width || fallback.width))),
    height: Math.max(420, Math.min(920, Math.round(rawBounds?.height || fallback.height))),
  }
  const display = screen.getDisplayMatching({
    x: desired.x ?? 0,
    y: desired.y ?? 0,
    width: desired.width,
    height: desired.height,
  })
  const area = display.workArea
  const width = Math.min(desired.width, area.width)
  const height = Math.min(desired.height, area.height)
  const defaultX = area.x + area.width - width - 24
  const defaultY = area.y + 24
  const x = Math.min(Math.max(desired.x ?? defaultX, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(desired.y ?? defaultY, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function loadRenderer(window, mode = 'main') {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    url.searchParams.set('mode', mode)
    return window.loadURL(url.toString())
  }
  return window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode },
  })
}

function isAllowedRendererUrl(targetUrl) {
  try {
    const target = new URL(targetUrl)
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
    }
    return target.protocol === 'file:'
      && path.resolve(fileURLToPath(target)) === path.resolve(__dirname, '..', 'dist', 'index.html')
  } catch {
    return false
  }
}

function hardenRendererWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl)) event.preventDefault()
  })
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f6f1',
    autoHideMenuBar: true,
    title: 'Dayline',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f6f1',
      symbolColor: '#27322d',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  hardenRendererWindow(mainWindow)
  loadRenderer(mainWindow, 'main')
  mainWindow.once('ready-to-show', () => {
    if (!isDatabaseQa) mainWindow?.show()
    void updaterController?.startupCheck()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

function persistWidgetBoundsNow() {
  clearTimeout(persistBoundsTimer)
  persistBoundsTimer = null
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const state = readWindowState()
  state.widget.bounds = widgetWindow.getBounds()
  state.widget.pinned = widgetWindow.isAlwaysOnTop()
  state.widget.locked = !widgetWindow.isResizable()
  writeWindowState(state)
}

function persistWidgetBoundsSoon() {
  clearTimeout(persistBoundsTimer)
  persistBoundsTimer = setTimeout(persistWidgetBoundsNow, 180)
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.show()
    widgetWindow.focus()
    return widgetWindow
  }

  const state = readWindowState()
  const bounds = clampWidgetBounds(state.widget.bounds)
  widgetWindow = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 420,
    maxWidth: 760,
    maxHeight: 920,
    show: false,
    frame: false,
    transparent: true,
    resizable: !state.widget.locked,
    movable: !state.widget.locked,
    alwaysOnTop: state.widget.pinned,
    skipTaskbar: false,
    hasShadow: true,
    title: 'Dayline Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  hardenRendererWindow(widgetWindow)
  widgetWindow.setAlwaysOnTop(state.widget.pinned, 'floating')
  widgetWindow.setVisibleOnAllWorkspaces(true)
  loadRenderer(widgetWindow, 'widget')
  widgetWindow.once('ready-to-show', () => {
    if (!isDatabaseQa) widgetWindow?.show()
  })
  widgetWindow.on('move', persistWidgetBoundsSoon)
  widgetWindow.on('resize', persistWidgetBoundsSoon)
  widgetWindow.on('closed', () => {
    clearTimeout(persistBoundsTimer)
    widgetWindow = null
  })
  return widgetWindow
}

function broadcastData(store, senderId) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents.id !== senderId) {
      try {
        window.webContents.send('dayline:data-changed', store)
      } catch {
        // A window can be destroyed between enumeration and delivery.
      }
    }
  }
}

function broadcastUpdateState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send('dayline:update-state', state)
  } catch {
    // The main window can be destroyed between the guard and delivery.
  }
}

function closeTaskDatabase() {
  const database = taskDatabase
  taskDatabase = null
  database?.close()
}

function openTaskDatabase() {
  if (taskDatabase) return
  const userDataPath = app.getPath('userData')
  taskDatabase = createDaylineDatabase({
    databasePath: path.join(userDataPath, 'dayline.db'),
    legacyJsonPath: path.join(userDataPath, 'dayline-data.json'),
  })
}

function prepareForUpdateInstall() {
  databaseWritesBlocked = true
  persistWidgetBoundsNow()
}

function recoverFromFailedUpdateInstall() {
  databaseWritesBlocked = false
}

function createAppUpdater() {
  const support = getUpdateSupport({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    isQa: isDatabaseQa,
    fileExists: fs.existsSync,
  })
  return createUpdaterController({
    adapter: configureAutoUpdater(autoUpdater),
    currentVersion: app.getVersion(),
    support,
    broadcast: broadcastUpdateState,
    beforeInstall: prepareForUpdateInstall,
    afterInstallFailure: recoverFromFailedUpdateInstall,
  })
}

function registerIpc() {
  const trustedDataWindow = (sender) => {
    const owner = BrowserWindow.fromWebContents(sender)
    return owner && (owner === mainWindow || owner === widgetWindow) ? owner : null
  }
  ipcMain.handle('dayline:data-load', (event) => {
    if (!trustedDataWindow(event.sender)) throw new Error('Untrusted Dayline data sender')
    if (databaseWritesBlocked || !taskDatabase) {
      throw new Error('Dayline database is unavailable while updating')
    }
    return taskDatabase.readStore()
  })
  const applyStoreMutations = (event, mutations) => {
    try {
      if (!trustedDataWindow(event.sender)) throw new Error('Untrusted Dayline data sender')
      if (databaseWritesBlocked || !taskDatabase) {
        throw new Error('Dayline database writes are blocked while updating')
      }
      if (!Array.isArray(mutations) || mutations.length > 1000) {
        throw new Error('Invalid Dayline mutation batch')
      }
      const store = taskDatabase.applyStoreMutations(mutations)
      broadcastData(store, event.sender.id)
      event.returnValue = { ok: true, store }
    } catch {
      event.returnValue = { ok: false, code: 'DAYLINE_DATABASE_WRITE_FAILED' }
    }
  }
  ipcMain.on('dayline:store-apply-sync', applyStoreMutations)
  ipcMain.handle('dayline:widget-open', () => {
    createWidgetWindow()
    return readWindowState().widget
  })
  ipcMain.handle('dayline:widget-close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === widgetWindow) widgetWindow.close()
    return true
  })
  ipcMain.handle('dayline:widget-toggle-pin', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return null
    const next = !widgetWindow.isAlwaysOnTop()
    widgetWindow.setAlwaysOnTop(next, 'floating')
    const state = readWindowState()
    state.widget.pinned = next
    writeWindowState(state)
    return { pinned: next }
  })
  ipcMain.handle('dayline:widget-toggle-lock', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return null
    const nextLocked = widgetWindow.isResizable()
    widgetWindow.setResizable(!nextLocked)
    widgetWindow.setMovable(!nextLocked)
    const state = readWindowState()
    state.widget.locked = nextLocked
    writeWindowState(state)
    return { locked: nextLocked }
  })
  ipcMain.handle('dayline:widget-reset-bounds', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return null
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = 390
    const height = 620
    const bounds = {
      width,
      height,
      x: display.workArea.x + display.workArea.width - width - 24,
      y: display.workArea.y + 24,
    }
    widgetWindow.setBounds(bounds, true)
    return bounds
  })
  ipcMain.handle('dayline:window-open-main', () => {
    createMainWindow()
    return true
  })
  ipcMain.handle('dayline:widget-state', () => readWindowState().widget)

  const trustedMainWindow = (sender) => {
    const owner = BrowserWindow.fromWebContents(sender)
    return owner && owner === mainWindow ? owner : null
  }
  const invokeUpdater = (event, action) => {
    if (!trustedMainWindow(event.sender)) throw new Error('Untrusted Dayline updater sender')
    return updaterController[action]()
  }
  ipcMain.handle('dayline:update-get-state', (event) => {
    if (!trustedMainWindow(event.sender)) throw new Error('Untrusted Dayline updater sender')
    return updaterController.getState()
  })
  ipcMain.handle('dayline:update-check', (event) => invokeUpdater(event, 'check'))
  ipcMain.handle('dayline:update-download', (event) => invokeUpdater(event, 'download'))
  ipcMain.handle('dayline:update-install', (event) => invokeUpdater(event, 'install'))
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => createMainWindow())
  app.whenReady().then(() => {
    const userDataPath = app.getPath('userData')
    fs.mkdirSync(userDataPath, { recursive: true })
    openTaskDatabase()
    databaseWritesBlocked = false
    windowStatePath = path.join(userDataPath, 'dayline-window-state.json')
    updaterController = createAppUpdater()
    registerIpc()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  databaseWritesBlocked = true
  persistWidgetBoundsNow()
  closeTaskDatabase()
})
