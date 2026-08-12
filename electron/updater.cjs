const path = require('node:path')

const UPDATE_STATUSES = new Set([
  'unsupported',
  'idle',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'installing',
  'error',
])

function getUpdateSupport({
  isPackaged,
  platform,
  resourcesPath,
  portableExecutableFile,
  portableExecutableDir,
  isQa,
  fileExists,
}) {
  if (isQa) return { supported: false, reason: 'qa' }
  if (!isPackaged) return { supported: false, reason: 'development' }
  if (platform !== 'win32') return { supported: false, reason: 'platform' }
  if (portableExecutableFile || portableExecutableDir) {
    return { supported: false, reason: 'portable' }
  }
  if (!resourcesPath || !fileExists(path.join(resourcesPath, 'app-update.yml'))) {
    return { supported: false, reason: 'not-installed' }
  }
  return { supported: true, reason: null }
}

function normalizeReleaseNotes(value) {
  const text = Array.isArray(value)
    ? value.map((entry) => entry?.note).filter(Boolean).join('\n\n')
    : typeof value === 'string' ? value : ''
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level) => `${'#'.repeat(Math.min(Number(level), 3))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\/(p|div|ul|ol|section)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000) || null
}

function normalizeUpdateInfo(info) {
  if (!info || typeof info !== 'object') {
    return { availableVersion: null, releaseName: null, releaseNotes: null }
  }
  return {
    availableVersion: typeof info.version === 'string' ? info.version : null,
    releaseName: typeof info.releaseName === 'string'
      ? info.releaseName.replace(/\s+/g, ' ').trim().slice(0, 200) || null
      : null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

function sanitizeUpdaterError(error, operation = 'unknown') {
  const normalizedOperation = ['check', 'download', 'install'].includes(operation)
    ? operation.toUpperCase()
    : 'UNKNOWN'
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (message.includes('net::err_internet_disconnected') || message.includes('enotfound')) {
    return 'UPDATE_NETWORK_UNAVAILABLE'
  }
  if (message.includes('403') || message.includes('401')) return 'UPDATE_ACCESS_DENIED'
  if (message.includes('sha512') || message.includes('checksum')) return 'UPDATE_INTEGRITY_FAILED'
  return `UPDATE_${normalizedOperation}_FAILED`
}

function createUpdaterController({
  adapter,
  currentVersion,
  support,
  broadcast = () => {},
  beforeInstall = async () => {},
  afterInstallFailure = async () => {},
}) {
  if (!adapter || typeof adapter.on !== 'function') {
    throw new TypeError('An updater adapter with event support is required')
  }

  let state = {
    status: support.supported ? 'idle' : 'unsupported',
    currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    progress: null,
    error: null,
    unsupportedReason: support.reason,
    canCheck: support.supported,
    canDownload: false,
    canInstall: false,
  }
  let checkPromise = null
  let downloadPromise = null
  let installPromise = null
  let startupCheckStarted = false
  let quitAndInstallTriggered = false
  let installRecoveryPromise = null

  function publish(patch) {
    const nextStatus = patch.status || state.status
    if (!UPDATE_STATUSES.has(nextStatus)) throw new Error('Invalid updater status')
    state = {
      ...state,
      ...patch,
      status: nextStatus,
      canCheck: support.supported && !['checking', 'downloading', 'downloaded', 'installing'].includes(nextStatus),
      canDownload: support.supported && nextStatus === 'available',
      canInstall: support.supported && nextStatus === 'downloaded',
    }
    broadcast({ ...state })
    return { ...state }
  }

  function getState() {
    return { ...state }
  }

  function updateInfoState(status, info, extra = {}) {
    return publish({
      status,
      ...normalizeUpdateInfo(info),
      progress: null,
      error: null,
      ...extra,
    })
  }

  adapter.on('checking-for-update', () => {
    if (!support.supported) return
    publish({ status: 'checking', progress: null, error: null })
  })
  adapter.on('update-available', (info) => {
    if (!support.supported) return
    updateInfoState('available', info)
  })
  adapter.on('update-not-available', (info) => {
    if (!support.supported) return
    updateInfoState('not-available', info, { availableVersion: null })
  })
  adapter.on('download-progress', (progress) => {
    if (!support.supported) return
    const rawPercent = Number(progress?.percent)
    publish({
      status: 'downloading',
      progress: Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : 0,
      error: null,
    })
  })
  adapter.on('update-downloaded', (info) => {
    if (!support.supported) return
    updateInfoState('downloaded', info, { progress: 100 })
  })
  async function recoverFailedInstall(error) {
    if (installRecoveryPromise) return installRecoveryPromise
    installRecoveryPromise = Promise.resolve()
      .then(() => afterInstallFailure())
      .catch(() => {})
      .then(() => {
        quitAndInstallTriggered = false
        installPromise = null
        installRecoveryPromise = null
        return publish({
          status: 'downloaded',
          progress: 100,
          error: sanitizeUpdaterError(error, 'install'),
        })
      })
    return installRecoveryPromise
  }

  adapter.on('error', (error) => {
    if (!support.supported) return
    if (state.status === 'installing') {
      void recoverFailedInstall(error)
      return
    }
    const operation = state.status === 'downloading'
      ? 'download'
      : state.status === 'checking' ? 'check' : 'unknown'
    publish({
      status: operation === 'download' && state.availableVersion ? 'available' : 'error',
      progress: null,
      error: sanitizeUpdaterError(error, operation),
    })
  })

  async function check() {
    if (!support.supported || ['downloading', 'downloaded', 'installing'].includes(state.status)) return getState()
    if (checkPromise) return checkPromise
    if (downloadPromise) return getState()

    publish({ status: 'checking', progress: null, error: null })
    checkPromise = Promise.resolve()
      .then(() => adapter.checkForUpdates())
      .then(() => getState())
      .catch((error) => publish({
        status: 'error',
        progress: null,
        error: sanitizeUpdaterError(error, 'check'),
      }))
      .finally(() => {
        checkPromise = null
      })
    return checkPromise
  }

  function startupCheck() {
    if (startupCheckStarted) return checkPromise || Promise.resolve(getState())
    startupCheckStarted = true
    return check()
  }

  async function download() {
    if (!support.supported || state.status !== 'available') return getState()
    if (downloadPromise) return downloadPromise

    publish({ status: 'downloading', progress: 0, error: null })
    downloadPromise = Promise.resolve()
      .then(() => adapter.downloadUpdate())
      .then(() => getState())
      .catch((error) => publish({
        status: 'available',
        progress: null,
        error: sanitizeUpdaterError(error, 'download'),
      }))
      .finally(() => {
        downloadPromise = null
      })
    return downloadPromise
  }

  async function install() {
    if (!support.supported || state.status !== 'downloaded') return getState()
    if (installPromise || quitAndInstallTriggered) return installPromise || getState()

    quitAndInstallTriggered = true
    publish({ status: 'installing', progress: 100, error: null })
    installPromise = Promise.resolve()
      .then(() => beforeInstall())
      .then(() => {
        if (installRecoveryPromise || state.status !== 'installing') {
          return installRecoveryPromise || getState()
        }
        adapter.quitAndInstall(false, true)
        return installRecoveryPromise || getState()
      })
      .catch(recoverFailedInstall)
    return installPromise
  }

  return { getState, check, startupCheck, download, install }
}

function configureAutoUpdater(adapter) {
  adapter.autoDownload = false
  adapter.autoInstallOnAppQuit = false
  adapter.allowPrerelease = false
  adapter.allowDowngrade = false
  adapter.disableWebInstaller = true
  return adapter
}

module.exports = {
  configureAutoUpdater,
  createUpdaterController,
  getUpdateSupport,
  normalizeReleaseNotes,
  normalizeUpdateInfo,
  sanitizeUpdaterError,
}
