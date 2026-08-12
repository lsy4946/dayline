const path = require('node:path')

const MAX_RELEASE_NOTES_LENGTH = 128 * 1024
const MAX_RELEASE_NOTE_SOURCE_LENGTH = 64 * 1024
const MAX_RELEASE_NOTE_ENTRIES = 100

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

function truncateTextSafely(value, maxLength) {
  if (value.length <= maxLength) return value
  let truncated = value.slice(0, maxLength)
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1)
  return truncated.trimEnd()
}

function sanitizeReleaseNoteText(value) {
  if (typeof value !== 'string') return ''
  const text = truncateTextSafely(value, MAX_RELEASE_NOTE_SOURCE_LENGTH)
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
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
}

function parseReleaseVersion(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > 128) return null
  const normalized = trimmed.replace(/^v/i, '')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(normalized)
  if (!match) return null
  return {
    key: normalized,
    display: `v${normalized}`,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] ? match[4].split('.') : null,
  }
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1
    if (left.core[index] > right.core[index]) return 1
  }
  if (left.prerelease === null && right.prerelease !== null) return 1
  if (left.prerelease !== null && right.prerelease === null) return -1
  if (left.prerelease !== null && right.prerelease !== null) {
    const length = Math.max(left.prerelease.length, right.prerelease.length)
    for (let index = 0; index < length; index += 1) {
      const leftPart = left.prerelease[index]
      const rightPart = right.prerelease[index]
      if (leftPart === undefined) return -1
      if (rightPart === undefined) return 1
      if (leftPart === rightPart) continue
      const leftNumeric = /^\d+$/.test(leftPart)
      const rightNumeric = /^\d+$/.test(rightPart)
      if (leftNumeric && rightNumeric) {
        const leftNumber = BigInt(leftPart)
        const rightNumber = BigInt(rightPart)
        if (leftNumber < rightNumber) return -1
        if (leftNumber > rightNumber) return 1
      } else if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1
      } else {
        const comparison = leftPart.localeCompare(rightPart, 'en')
        if (comparison !== 0) return comparison
      }
    }
  }
  return left.key.localeCompare(right.key, 'en')
}

function releaseVersionKey(value) {
  return parseReleaseVersion(value)?.key ?? null
}

function joinReleaseNoteSectionsPrioritizingLatest(versionedSections, unversionedSections) {
  const selectedNewestFirst = []
  let usedLength = 0

  for (let index = versionedSections.length - 1; index >= 0; index -= 1) {
    const separatorLength = selectedNewestFirst.length > 0 ? 2 : 0
    const remaining = MAX_RELEASE_NOTES_LENGTH - usedLength - separatorLength
    if (remaining <= 0) break
    const section = truncateTextSafely(versionedSections[index], remaining)
    if (!section) continue
    selectedNewestFirst.push(section)
    usedLength += separatorLength + section.length
  }

  const selected = selectedNewestFirst.reverse()
  for (const section of unversionedSections) {
    const separatorLength = selected.length > 0 ? 2 : 0
    const remaining = MAX_RELEASE_NOTES_LENGTH - usedLength - separatorLength
    if (remaining <= 0) break
    const truncated = truncateTextSafely(section, remaining)
    if (!truncated) continue
    selected.push(truncated)
    usedLength += separatorLength + truncated.length
  }
  return selected.join('\n\n') || null
}

function normalizeReleaseNotes(value) {
  if (typeof value === 'string') {
    const text = sanitizeReleaseNoteText(value)
    return truncateTextSafely(text, MAX_RELEASE_NOTES_LENGTH) || null
  }
  if (!Array.isArray(value)) return null

  const versioned = new Map()
  const unversioned = []
  for (const entry of value.slice(0, MAX_RELEASE_NOTE_ENTRIES)) {
    const noteValue = typeof entry === 'string' ? entry : entry?.note
    const note = sanitizeReleaseNoteText(noteValue)
    const version = parseReleaseVersion(entry?.version)
    if (!version) {
      if (note && !unversioned.includes(note)) unversioned.push(note)
      continue
    }

    const existing = versioned.get(version.key)
    if (existing) {
      if (note && !existing.notes.includes(note)) existing.notes.push(note)
    } else {
      versioned.set(version.key, { version, notes: note ? [note] : [] })
    }
  }

  const sections = [...versioned.values()]
    .sort((left, right) => compareReleaseVersions(left.version, right.version))
    .map(({ version, notes }) => {
      const body = truncateTextSafely(notes.join('\n\n'), MAX_RELEASE_NOTE_SOURCE_LENGTH)
      return body ? `## ${version.display}\n\n${body}` : `## ${version.display}`
    })
  return joinReleaseNoteSectionsPrioritizingLatest(sections, unversioned)
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
  let downloadAttemptSequence = 0
  let explicitDownloadConsent = null

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
    if (state.status === 'installing') return
    const downloadedVersion = releaseVersionKey(info?.version)
    const availableVersion = releaseVersionKey(state.availableVersion)
    if (availableVersion && (
      !downloadedVersion
      || downloadedVersion !== availableVersion
    )) return
    if (explicitDownloadConsent && (
      !downloadedVersion
      || downloadedVersion !== explicitDownloadConsent.version
    )) return
    updateInfoState('downloaded', info, { progress: 100 })
    if (explicitDownloadConsent) {
      explicitDownloadConsent = null
      void install()
    }
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
    if (operation === 'download') explicitDownloadConsent = null
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

    const consentedVersion = releaseVersionKey(state.availableVersion)
    const attempt = ++downloadAttemptSequence
    explicitDownloadConsent = consentedVersion ? { attempt, version: consentedVersion } : null
    publish({ status: 'downloading', progress: 0, error: null })
    downloadPromise = Promise.resolve()
      .then(() => adapter.downloadUpdate())
      .then(() => installPromise || getState())
      .catch((error) => {
        if (explicitDownloadConsent?.attempt === attempt) explicitDownloadConsent = null
        if (['downloaded', 'installing'].includes(state.status)) return getState()
        return publish({
          status: 'available',
          progress: null,
          error: sanitizeUpdaterError(error, 'download'),
        })
      })
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
        adapter.quitAndInstall(true, true)
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
  adapter.fullChangelog = true
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
