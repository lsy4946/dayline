const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { autoUpdater } = require('electron-updater')
const { createDaylineDatabase } = require('./database.cjs')
const {
  configureAutoUpdater,
  createUpdaterController,
  fetchGitHubReleaseHistory,
  getUpdateSupport,
} = require('./updater.cjs')

let mainWindow = null
let widgetWindow = null
let taskDatabase = null
let windowStatePath = ''
let persistBoundsTimer = null
let updaterController = null
let databaseWritesBlocked = false
let updateSessionActive = false
let updateUiReadyPromise = null
let updateUiReadyResolve = null
let updateUiReadyTimer = null
let widgetWasVisibleBeforeUpdate = false

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

function settleUpdateUiReady() {
  if (updateUiReadyTimer) clearTimeout(updateUiReadyTimer)
  updateUiReadyTimer = null
  const resolve = updateUiReadyResolve
  updateUiReadyResolve = null
  updateUiReadyPromise = null
  resolve?.()
}

function beginUpdateSession() {
  if (updateSessionActive) return updateUiReadyPromise || Promise.resolve()
  updateSessionActive = true
  databaseWritesBlocked = true
  persistWidgetBoundsNow()
  widgetWasVisibleBeforeUpdate = Boolean(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible())
  if (widgetWasVisibleBeforeUpdate) widgetWindow.hide()

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.setClosable(false)
    mainWindow.setMinimizable(false)
    mainWindow.show()
    mainWindow.focus()
  }

  updateUiReadyPromise = new Promise((resolve) => {
    updateUiReadyResolve = resolve
    updateUiReadyTimer = setTimeout(settleUpdateUiReady, 1_500)
  })
  return updateUiReadyPromise
}

function prepareForUpdateInstall() {
  databaseWritesBlocked = true
  persistWidgetBoundsNow()
}

function holdFailedUpdateSession() {
  databaseWritesBlocked = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function cancelUpdateSession() {
  settleUpdateUiReady()
  updateSessionActive = false
  databaseWritesBlocked = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setClosable(true)
    mainWindow.setMinimizable(true)
  }
  if (widgetWasVisibleBeforeUpdate && widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show()
  widgetWasVisibleBeforeUpdate = false
}

function launchUpdateHelper({ currentVersion, availableVersion }) {
  const installerPath = autoUpdater.installerPath
  const helperPath = path.join(process.resourcesPath, 'update-helper.exe')
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('Downloaded Dayline installer is unavailable')
  }
  if (!fs.existsSync(helperPath)) {
    throw new Error('Dayline update helper is unavailable')
  }

  const readyFile = path.join(
    app.getPath('temp'),
    `dayline-update-ready-${randomUUID()}.tmp`,
  )
  try {
    fs.unlinkSync(readyFile)
  } catch {
    // A unique ready marker normally does not exist yet.
  }

  const child = spawn(helperPath, [
    '--installer', installerPath,
    '--parent-pid', String(process.pid),
    '--app', process.execPath,
    '--ready-file', readyFile,
    '--from-version', currentVersion,
    '--to-version', availableVersion || '',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let pollTimer = null
    const startedAt = Date.now()
    const cleanupReadyFile = () => {
      try {
        fs.unlinkSync(readyFile)
      } catch {
        // The helper or a failed launch may already have removed the marker.
      }
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      cleanupReadyFile()
      try {
        child.kill()
      } catch {
        // Best-effort cleanup of an unresponsive helper process.
      }
      reject(error)
    }
    pollTimer = setInterval(() => {
      if (fs.existsSync(readyFile) && child.exitCode === null) {
        settled = true
        clearInterval(pollTimer)
        cleanupReadyFile()
        child.removeListener('error', fail)
        child.unref()
        setImmediate(() => app.quit())
        resolve()
        return
      }
      if (child.exitCode !== null) {
        fail(new Error(`Dayline update helper exited with code ${child.exitCode}`))
        return
      }
      if (Date.now() - startedAt >= 4_000) {
        fail(new Error('Dayline update helper did not become ready'))
      }
    }, 35)
    child.once('error', fail)
  })
}

function createAppUpdater() {
  const currentVersion = app.getVersion()
  const support = getUpdateSupport({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    isQa: isDatabaseQa,
    fileExists: fs.existsSync,
  })
  let initialInstalledReleaseHistory = null
  if (taskDatabase) {
    try {
      initialInstalledReleaseHistory = taskDatabase.reconcileUpdateHistory(
        currentVersion,
        new Date().toISOString(),
      ) || taskDatabase.readInstalledReleaseHistory()
    } catch {
      initialInstalledReleaseHistory = null
    }
  }
  return createUpdaterController({
    adapter: configureAutoUpdater(autoUpdater),
    currentVersion,
    support,
    broadcast: broadcastUpdateState,
    beginUpdate: beginUpdateSession,
    beforeInstall: prepareForUpdateInstall,
    installUpdate: (_isSilent, _forceRunAfter, versions) => launchUpdateHelper(versions),
    afterInstallFailure: holdFailedUpdateSession,
    cancelUpdate: cancelUpdateSession,
    initialInstalledReleaseHistory,
    recordUpdateConsent: (fromVersion, targetVersion, recordedAt, releaseName, releaseNotes) => {
      if (databaseWritesBlocked || !taskDatabase) throw new Error('Dayline database is unavailable while updating')
      return taskDatabase.recordUpdateConsent(
        fromVersion,
        targetVersion,
        recordedAt,
        releaseName,
        releaseNotes,
      )
    },
    fetchReleaseHistory: ({ fromVersion, toVersion }) => fetchGitHubReleaseHistory({
      owner: 'lsy4946',
      repo: 'dayline',
      fromVersion,
      toVersion,
    }),
    saveInstalledReleaseNotes: (history) => {
      if (databaseWritesBlocked || !taskDatabase) throw new Error('Dayline database is unavailable while updating')
      return taskDatabase.saveInstalledReleaseNotes(history)
    },
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
    if (updateSessionActive) return readWindowState().widget
    createWidgetWindow()
    return readWindowState().widget
  })
  ipcMain.handle('dayline:widget-close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === widgetWindow) widgetWindow.close()
    return true
  })
  ipcMain.handle('dayline:widget-toggle-pin', () => {
    if (updateSessionActive) return null
    if (!widgetWindow || widgetWindow.isDestroyed()) return null
    const next = !widgetWindow.isAlwaysOnTop()
    widgetWindow.setAlwaysOnTop(next, 'floating')
    const state = readWindowState()
    state.widget.pinned = next
    writeWindowState(state)
    return { pinned: next }
  })
  ipcMain.handle('dayline:widget-toggle-lock', () => {
    if (updateSessionActive) return null
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
    if (updateSessionActive) return null
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
  ipcMain.handle('dayline:update-cancel', (event) => invokeUpdater(event, 'cancel'))
  ipcMain.handle('dayline:update-ui-ready', (event) => {
    if (!trustedMainWindow(event.sender)) throw new Error('Untrusted Dayline updater sender')
    if (!updateSessionActive) return false
    settleUpdateUiReady()
    return true
  })
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
  settleUpdateUiReady()
  databaseWritesBlocked = true
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setClosable(true)
  persistWidgetBoundsNow()
  closeTaskDatabase()
})
