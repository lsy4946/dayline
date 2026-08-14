const path = require('node:path')

const MAX_RELEASE_NOTES_LENGTH = 128 * 1024
const MAX_RELEASE_NOTE_SOURCE_LENGTH = 64 * 1024
const MAX_RELEASE_NOTE_ENTRIES = 1000
const MAX_RELEASE_FEED_LENGTH = 2 * 1024 * 1024
const RELEASE_FEED_TIMEOUT_MS = 12_000
const GITHUB_RELEASE_PAGE_SIZE = 100
const MAX_GITHUB_RELEASE_PAGES = 10

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

function sanitizeReleaseNoteText(value, maxSourceLength = MAX_RELEASE_NOTE_SOURCE_LENGTH) {
  if (typeof value !== 'string') return ''
  const text = truncateTextSafely(value, maxSourceLength)
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

function normalizeCumulativeReleaseNotes(value) {
  if (typeof value !== 'string') return null
  const text = sanitizeReleaseNoteText(value, MAX_RELEASE_NOTES_LENGTH)
  return truncateTextSafely(text, MAX_RELEASE_NOTES_LENGTH) || null
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

function compareReleasePrecedence(left, right) {
  const leftVersion = typeof left === 'string' ? parseReleaseVersion(left) : left
  const rightVersion = typeof right === 'string' ? parseReleaseVersion(right) : right
  if (!leftVersion || !rightVersion) return null
  const leftWithoutBuild = { ...leftVersion, key: '' }
  const rightWithoutBuild = { ...rightVersion, key: '' }
  return compareReleaseVersions(leftWithoutBuild, rightWithoutBuild)
}

function noInstalledReleaseHistory(currentVersion) {
  return {
    state: 'no-baseline',
    fromVersion: null,
    toVersion: releaseVersionKey(currentVersion) || String(currentVersion || ''),
    releaseName: null,
    releaseNotes: null,
    recordedAt: null,
  }
}

function normalizeInstalledReleaseHistory(value, currentVersion) {
  const fallback = noInstalledReleaseHistory(currentVersion)
  if (!value || typeof value !== 'object') return fallback
  const toVersion = releaseVersionKey(value.toVersion)
  const fromVersion = value.fromVersion == null ? null : releaseVersionKey(value.fromVersion)
  if (!toVersion || (value.fromVersion != null && !fromVersion)) return fallback
  const releaseNotes = normalizeCumulativeReleaseNotes(value.releaseNotes)
  const requestedState = value.state === 'ready' && releaseNotes
    ? 'ready'
    : value.state === 'notes-unavailable' || value.state === 'ready'
      ? 'notes-unavailable'
      : 'no-baseline'
  if (requestedState === 'no-baseline') return { ...fallback, toVersion }
  return {
    state: requestedState,
    fromVersion,
    toVersion,
    releaseName: typeof value.releaseName === 'string'
      ? value.releaseName.replace(/\s+/g, ' ').trim().slice(0, 200) || null
      : null,
    releaseNotes: requestedState === 'ready' ? releaseNotes : null,
    recordedAt: typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))
      ? new Date(value.recordedAt).toISOString()
      : null,
  }
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

function stripMatchingReleaseHeading(note, version) {
  if (!note) return note
  const lines = note.split('\n')
  const firstContentIndex = lines.findIndex((line) => line.trim())
  if (firstContentIndex < 0) return ''
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[firstContentIndex].trim())
  const headingVersion = parseReleaseVersion(heading?.[1] || '')
  if (!headingVersion || headingVersion.key !== version.key) return note
  lines.splice(firstContentIndex, 1)
  while (lines[firstContentIndex]?.trim() === '') lines.splice(firstContentIndex, 1)
  return lines.join('\n').trim()
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
    const version = parseReleaseVersion(entry?.version)
    const noteValue = typeof entry === 'string' ? entry : entry?.note
    let note = sanitizeReleaseNoteText(noteValue)
    if (!version) {
      if (note && !unversioned.includes(note)) unversioned.push(note)
      continue
    }
    note = stripMatchingReleaseHeading(note, version)

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

async function fetchGitHubReleaseHistory({
  owner,
  repo,
  fromVersion = null,
  toVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = RELEASE_FEED_TIMEOUT_MS,
}) {
  if (!/^[0-9A-Za-z_.-]{1,100}$/.test(owner) || !/^[0-9A-Za-z_.-]{1,100}$/.test(repo)) {
    throw new Error('Invalid GitHub repository')
  }
  if (typeof fetchImpl !== 'function') throw new Error('GitHub release feed is unavailable')
  const to = parseReleaseVersion(toVersion)
  const from = fromVersion == null ? null : parseReleaseVersion(fromVersion)
  if (!to || to.prerelease !== null || (fromVersion != null && !from)) {
    throw new Error('Invalid release history range')
  }

  const releases = new Map()
  let releaseName = null
  let targetFound = false
  let rangeComplete = false

  for (let page = 1; page <= MAX_GITHUB_RELEASE_PAGES; page += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()
    let values
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${GITHUB_RELEASE_PAGE_SIZE}&page=${page}`
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Dayline-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!response?.ok) throw new Error('GitHub release history request failed')
      const contentLength = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_FEED_LENGTH) {
        throw new Error('GitHub release history response is too large')
      }
      const responseText = await response.text()
      if (Buffer.byteLength(responseText, 'utf8') > MAX_RELEASE_FEED_LENGTH) {
        throw new Error('GitHub release history response is too large')
      }
      values = JSON.parse(responseText)
      if (!Array.isArray(values)) throw new Error('Invalid GitHub release history response')
    } finally {
      clearTimeout(timeout)
    }

    if (values.length === 0) {
      rangeComplete = true
      break
    }

    for (const value of values.slice(0, GITHUB_RELEASE_PAGE_SIZE)) {
      if (!value || typeof value !== 'object' || value.draft === true || value.prerelease === true) continue
      const version = parseReleaseVersion(value.tag_name)
      if (!version || version.prerelease !== null) continue
      const throughTarget = compareReleasePrecedence(version, to) <= 0
      if (!throughTarget) continue
      if (from && compareReleasePrecedence(version, from) <= 0) {
        continue
      }
      if (!from && compareReleasePrecedence(version, to) !== 0) continue

      if (compareReleasePrecedence(version, to) === 0) {
        targetFound = true
        releaseName = sanitizeReleaseNoteText(value.name || value.tag_name)
          .replace(/\s+/g, ' ').slice(0, 200) || null
      }
      if (!releases.has(version.key) && releases.size < MAX_RELEASE_NOTE_ENTRIES) {
        releases.set(version.key, { version: version.key, note: value.body })
      }
    }

    if ((from === null && targetFound) || values.length < GITHUB_RELEASE_PAGE_SIZE) {
      rangeComplete = true
      break
    }
  }

  if (!targetFound || !rangeComplete) throw new Error('GitHub release history range is incomplete')
  const releaseNotes = normalizeReleaseNotes([...releases.values()])
  if (!releaseNotes || ![...releases.values()].some((entry) => sanitizeReleaseNoteText(entry.note))) {
    throw new Error('GitHub release notes are unavailable')
  }
  return {
    fromVersion: from?.key ?? null,
    toVersion: to.key,
    releaseName,
    releaseNotes,
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
  beginUpdate = () => {},
  beforeInstall = async () => {},
  installUpdate = (isSilent, forceRunAfter) => adapter.quitAndInstall(isSilent, forceRunAfter),
  afterInstallFailure = async () => {},
  cancelUpdate = async () => {},
  initialInstalledReleaseHistory = null,
  recordUpdateConsent = () => {},
  fetchReleaseHistory = null,
  saveInstalledReleaseNotes = async (history) => history,
  now = () => new Date(),
}) {
  if (!adapter || typeof adapter.on !== 'function') {
    throw new TypeError('An updater adapter with event support is required')
  }

  let installedReleaseHistoryRecord = initialInstalledReleaseHistory
    && typeof initialInstalledReleaseHistory === 'object'
    ? { ...initialInstalledReleaseHistory }
    : null
  let releaseHistoryNeedsRefresh = installedReleaseHistoryRecord?.verified !== true
  let state = {
    status: support.supported ? 'idle' : 'unsupported',
    currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    installedReleaseHistory: normalizeInstalledReleaseHistory(initialInstalledReleaseHistory, currentVersion),
    progress: null,
    error: null,
    sessionActive: false,
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
  let recordedConsentVersion = null
  let releaseHistoryPromise = null

  function cloneState() {
    return {
      ...state,
      installedReleaseHistory: { ...state.installedReleaseHistory },
    }
  }

  function publish(patch) {
    const nextStatus = patch.status || state.status
    const nextSessionActive = Object.prototype.hasOwnProperty.call(patch, 'sessionActive')
      ? patch.sessionActive === true
      : state.sessionActive
    if (!UPDATE_STATUSES.has(nextStatus)) throw new Error('Invalid updater status')
    state = {
      ...state,
      ...patch,
      status: nextStatus,
      sessionActive: nextSessionActive,
      canCheck: support.supported
        && !nextSessionActive
        && !['checking', 'downloading', 'downloaded', 'installing'].includes(nextStatus),
      canDownload: support.supported && nextStatus === 'available',
      canInstall: support.supported && nextStatus === 'downloaded',
    }
    const snapshot = cloneState()
    broadcast(snapshot)
    return snapshot
  }

  function getState() {
    return cloneState()
  }

  function refreshInstalledReleaseHistory() {
    if (!support.supported || typeof fetchReleaseHistory !== 'function') return Promise.resolve(getState())
    if (!releaseHistoryNeedsRefresh) return Promise.resolve(getState())
    if (releaseHistoryPromise) return releaseHistoryPromise

    const openingHistory = { ...state.installedReleaseHistory }
    const fromVersion = openingHistory.state === 'no-baseline' ? null : openingHistory.fromVersion
    const toVersion = openingHistory.state === 'no-baseline'
      ? releaseVersionKey(currentVersion)
      : openingHistory.toVersion
    if (!toVersion) return Promise.resolve(getState())

    releaseHistoryPromise = Promise.resolve()
      .then(() => fetchReleaseHistory({ fromVersion, toVersion }))
      .then((result) => {
        const releaseNotes = normalizeCumulativeReleaseNotes(result?.releaseNotes)
        if (!releaseNotes) return getState()
        const candidate = {
          state: 'ready',
          fromVersion,
          targetVersion: installedReleaseHistoryRecord?.targetVersion || toVersion,
          toVersion,
          releaseName: typeof result?.releaseName === 'string' ? result.releaseName : null,
          releaseNotes,
          recordedAt: openingHistory.recordedAt,
          completedAt: installedReleaseHistoryRecord?.completedAt ?? null,
          verified: true,
        }
        return Promise.resolve(saveInstalledReleaseNotes(candidate)).then((saved) => {
          installedReleaseHistoryRecord = saved && typeof saved === 'object'
            ? { ...saved }
            : { ...candidate }
          releaseHistoryNeedsRefresh = false
          const installedReleaseHistory = normalizeInstalledReleaseHistory(saved || candidate, currentVersion)
          return publish({ installedReleaseHistory })
        })
      })
      .catch(() => getState())
      .finally(() => {
        releaseHistoryPromise = null
      })
    return releaseHistoryPromise
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
    if (state.sessionActive && !explicitDownloadConsent) return
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
    if (!support.supported || state.sessionActive || ['downloading', 'downloaded', 'installing'].includes(state.status)) return getState()
    if (checkPromise) return checkPromise
    if (downloadPromise) return getState()

    publish({ status: 'checking', progress: null, error: null })
    checkPromise = Promise.resolve()
      .then(() => Promise.all([
        adapter.checkForUpdates(),
        refreshInstalledReleaseHistory(),
      ]))
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

  function ensureUpdateConsentRecorded() {
    const targetVersion = releaseVersionKey(state.availableVersion)
    if (!targetVersion) throw new Error('A downloaded update version is required')
    if (recordedConsentVersion === targetVersion) return
    const recordedAt = now().toISOString()
    const result = recordUpdateConsent(
      currentVersion,
      targetVersion,
      recordedAt,
      state.releaseName,
      state.releaseNotes,
    )
    if (result && typeof result.then === 'function') {
      throw new Error('Update consent persistence must be synchronous')
    }
    recordedConsentVersion = targetVersion
  }

  async function download() {
    if (!support.supported || state.status !== 'available') return getState()
    if (downloadPromise) return downloadPromise

    const consentedVersion = releaseVersionKey(state.availableVersion)
    try {
      ensureUpdateConsentRecorded()
    } catch {
      return publish({
        status: 'available',
        progress: null,
        error: 'UPDATE_DOWNLOAD_FAILED',
      })
    }
    const attempt = ++downloadAttemptSequence
    explicitDownloadConsent = consentedVersion ? { attempt, version: consentedVersion } : null
    let updateUiReady
    try {
      updateUiReady = beginUpdate()
    } catch (error) {
      explicitDownloadConsent = null
      return publish({
        status: 'available',
        progress: null,
        error: sanitizeUpdaterError(error, 'download'),
        sessionActive: false,
      })
    }
    publish({ status: 'downloading', progress: 0, error: null, sessionActive: true })
    downloadPromise = Promise.resolve(updateUiReady)
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

    try {
      ensureUpdateConsentRecorded()
    } catch {
      return publish({
        status: 'downloaded',
        progress: 100,
        error: 'UPDATE_INSTALL_FAILED',
      })
    }

    let updateUiReady
    try {
      updateUiReady = state.sessionActive ? undefined : beginUpdate()
    } catch (error) {
      return publish({
        status: 'downloaded',
        progress: 100,
        error: sanitizeUpdaterError(error, 'install'),
        sessionActive: false,
      })
    }

    quitAndInstallTriggered = true
    publish({ status: 'installing', progress: 100, error: null, sessionActive: true })
    installPromise = Promise.resolve(updateUiReady)
      .then(() => beforeInstall())
      .then(() => {
        if (installRecoveryPromise || state.status !== 'installing') {
          return installRecoveryPromise || getState()
        }
        return Promise.resolve(installUpdate(false, true, {
          currentVersion: state.currentVersion,
          availableVersion: state.availableVersion,
        })).then(() => installRecoveryPromise || getState())
      })
      .catch(recoverFailedInstall)
    return installPromise
  }

  async function cancel() {
    if (!support.supported || !state.sessionActive) return getState()
    if (state.status === 'downloading' || state.status === 'installing') return getState()
    await cancelUpdate()
    explicitDownloadConsent = null
    quitAndInstallTriggered = false
    installPromise = null
    installRecoveryPromise = null
    return publish({
      status: state.availableVersion ? 'available' : 'idle',
      progress: null,
      error: null,
      sessionActive: false,
    })
  }

  return { getState, check, startupCheck, download, install, cancel }
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
  fetchGitHubReleaseHistory,
  getUpdateSupport,
  normalizeInstalledReleaseHistory,
  normalizeReleaseNotes,
  normalizeUpdateInfo,
  sanitizeUpdaterError,
}
