const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 30 * DAY_MS

let mainWindow = null
let widgetWindow = null
let storePath = ''
let windowStatePath = ''
let persistBoundsTimer = null

const isDev = !app.isPackaged

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateOffset(offset) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return localDateKey(date)
}

function createSeedStore() {
  const now = new Date()
  const nowIso = now.toISOString()
  const completedAt = new Date(now.getTime() - 52 * 60 * 1000).toISOString()
  const deletedAt = new Date(now.getTime() - 2 * DAY_MS).toISOString()

  return {
    version: 1,
    tasks: [
      {
        id: crypto.randomUUID(),
        title: 'Dayline 프로토타입 살펴보기',
        note: '일정을 한 번 누르면 완료, 완료된 일정을 다시 누르면 최근 삭제로 이동해요.',
        dueDate: dateOffset(0),
        dueTime: null,
        color: 'coral',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: crypto.randomUUID(),
        title: '오늘의 우선순위 정리',
        note: '',
        dueDate: dateOffset(0),
        dueTime: '10:30',
        color: 'violet',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: crypto.randomUUID(),
        title: '오프라인 저장 동작 확인',
        note: '완료 상태도 앱을 다시 열었을 때 그대로 유지됩니다.',
        dueDate: dateOffset(0),
        dueTime: null,
        color: 'sage',
        completed: true,
        completedAt,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: completedAt,
      },
      {
        id: crypto.randomUUID(),
        title: '주간 계획 초안',
        note: '',
        dueDate: dateOffset(1),
        dueTime: null,
        color: 'blue',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: crypto.randomUUID(),
        title: '프로젝트 회고',
        note: '잘된 점과 다음 개선점을 기록하기',
        dueDate: dateOffset(3),
        dueTime: '15:00',
        color: 'amber',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: crypto.randomUUID(),
        title: '복구 기능 예시 일정',
        note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        dueDate: dateOffset(-3),
        dueTime: null,
        color: 'blue',
        completed: true,
        completedAt: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
        deletedAt,
        previousCompleted: true,
        createdAt: new Date(now.getTime() - 6 * DAY_MS).toISOString(),
        updatedAt: deletedAt,
      },
    ],
  }
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

function purgeExpiredTasks(tasks, now = Date.now()) {
  return tasks.filter((task) => {
    if (!task.deletedAt) return true
    const deletedAt = new Date(task.deletedAt).getTime()
    return Number.isFinite(deletedAt) && now - deletedAt <= RETENTION_MS
  })
}

function sanitizeTask(task) {
  if (!task || typeof task !== 'object') return null
  if (typeof task.id !== 'string' || typeof task.title !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || '')) return null

  const colors = new Set(['coral', 'violet', 'sage', 'blue', 'amber'])
  return {
    id: task.id,
    title: task.title.slice(0, 240),
    note: typeof task.note === 'string' ? task.note.slice(0, 2000) : '',
    dueDate: task.dueDate,
    dueTime: /^\d{2}:\d{2}$/.test(task.dueTime || '') ? task.dueTime : null,
    color: colors.has(task.color) ? task.color : 'coral',
    completed: Boolean(task.completed),
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : null,
    deletedAt: typeof task.deletedAt === 'string' ? task.deletedAt : null,
    previousCompleted:
      typeof task.previousCompleted === 'boolean' ? task.previousCompleted : null,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : new Date().toISOString(),
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
  }
}

function readStore() {
  if (!fs.existsSync(storePath)) {
    const seed = createSeedStore()
    atomicWriteJson(storePath, seed)
    return seed
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(sanitizeTask).filter(Boolean)
      : []
    const purged = purgeExpiredTasks(tasks)
    const store = { version: 1, tasks: purged }
    if (purged.length !== tasks.length) atomicWriteJson(storePath, store)
    return store
  } catch (error) {
    const backupPath = `${storePath}.corrupt-${Date.now()}`
    try {
      fs.copyFileSync(storePath, backupPath)
    } catch {
      // If backup also fails, continue with a fresh safe store.
    }
    const fresh = createSeedStore()
    atomicWriteJson(storePath, fresh)
    return fresh
  }
}

function saveTasks(rawTasks) {
  const tasks = Array.isArray(rawTasks)
    ? rawTasks.map(sanitizeTask).filter(Boolean)
    : []
  const store = { version: 1, tasks: purgeExpiredTasks(tasks) }
  atomicWriteJson(storePath, store)
  return store
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
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  loadRenderer(mainWindow, 'main')
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

function persistWidgetBoundsSoon() {
  clearTimeout(persistBoundsTimer)
  persistBoundsTimer = setTimeout(() => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    const state = readWindowState()
    state.widget.bounds = widgetWindow.getBounds()
    state.widget.pinned = widgetWindow.isAlwaysOnTop()
    state.widget.locked = !widgetWindow.isResizable()
    writeWindowState(state)
  }, 180)
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

  widgetWindow.setAlwaysOnTop(state.widget.pinned, 'floating')
  widgetWindow.setVisibleOnAllWorkspaces(true)
  loadRenderer(widgetWindow, 'widget')
  widgetWindow.once('ready-to-show', () => widgetWindow?.show())
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
      window.webContents.send('dayline:data-changed', store)
    }
  }
}

function registerIpc() {
  ipcMain.handle('dayline:data-load', () => readStore())
  ipcMain.handle('dayline:data-save', (event, tasks) => {
    const store = saveTasks(tasks)
    broadcastData(store, event.sender.id)
    return store
  })
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
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => createMainWindow())
  app.whenReady().then(() => {
    if (isDev) {
      app.setPath('userData', path.join(app.getPath('appData'), 'Dayline Dev'))
    }
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    storePath = path.join(app.getPath('userData'), 'dayline-data.json')
    windowStatePath = path.join(app.getPath('userData'), 'dayline-window-state.json')
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
