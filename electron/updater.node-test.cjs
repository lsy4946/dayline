const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const {
  configureAutoUpdater,
  createUpdaterController,
  getUpdateSupport,
  normalizeReleaseNotes,
  sanitizeUpdaterError,
} = require('./updater.cjs')

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.checkCalls = 0
    this.downloadCalls = 0
    this.installCalls = 0
    this.checkImplementation = async () => {}
    this.downloadImplementation = async () => {}
  }

  checkForUpdates() {
    this.checkCalls += 1
    return this.checkImplementation()
  }

  downloadUpdate() {
    this.downloadCalls += 1
    return this.downloadImplementation()
  }

  quitAndInstall(isSilent, forceRunAfter) {
    this.installCalls += 1
    this.installArguments = [isSilent, forceRunAfter]
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createSupportedController(options = {}) {
  const adapter = options.adapter || new FakeUpdater()
  const states = []
  const controller = createUpdaterController({
    adapter,
    currentVersion: '1.2.3',
    support: { supported: true, reason: null },
    broadcast: (state) => states.push(state),
    beforeInstall: options.beforeInstall,
  })
  return { adapter, controller, states }
}

test('supports only installed packaged Windows builds', () => {
  const supported = getUpdateSupport({
    isPackaged: true,
    platform: 'win32',
    resourcesPath: 'C:\\Program Files\\Dayline\\resources',
    portableExecutableFile: '',
    portableExecutableDir: '',
    isQa: false,
    fileExists: (candidate) => candidate.endsWith('app-update.yml'),
  })
  assert.deepEqual(supported, { supported: true, reason: null })

  const common = { ...supported, resourcesPath: 'resources', fileExists: () => true }
  assert.equal(getUpdateSupport({ ...common, isPackaged: false, platform: 'win32', isQa: false }).reason, 'development')
  assert.equal(getUpdateSupport({ ...common, isPackaged: true, platform: 'darwin', isQa: false }).reason, 'platform')
  assert.equal(getUpdateSupport({ ...common, isPackaged: true, platform: 'win32', isQa: true }).reason, 'qa')
  assert.equal(getUpdateSupport({
    ...common,
    isPackaged: true,
    platform: 'win32',
    isQa: false,
    portableExecutableFile: 'Dayline.exe',
  }).reason, 'portable')
  assert.equal(getUpdateSupport({
    ...common,
    isPackaged: true,
    platform: 'win32',
    isQa: false,
    fileExists: () => false,
  }).reason, 'not-installed')
})

test('configures updater for explicit stable upgrades without implicit install', () => {
  const adapter = {}
  configureAutoUpdater(adapter)
  assert.deepEqual(adapter, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    fullChangelog: true,
    disableWebInstaller: true,
  })
})

test('keeps manual Setup assisted while updater-owned launches become silent', () => {
  const projectDir = path.join(__dirname, '..')
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const includePath = packageJson.build?.nsis?.include
  const include = fs.readFileSync(path.join(projectDir, includePath), 'utf8')

  assert.equal(packageJson.build.nsis.oneClick, false)
  assert.equal(includePath, 'build/installer.nsh')
  assert.match(include, /!macro\s+customInit/)
  assert.match(include, /\$\{if}\s+\$\{isUpdated}/)
  assert.match(include, /SetSilent\s+silent/)
  assert.doesNotMatch(include, /SilentInstall\s+silent/)
})

test('unsupported controller never invokes provider operations', async () => {
  const adapter = new FakeUpdater()
  const controller = createUpdaterController({
    adapter,
    currentVersion: '1.0.0',
    support: { supported: false, reason: 'portable' },
  })
  assert.deepEqual(controller.getState(), {
    status: 'unsupported',
    currentVersion: '1.0.0',
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    progress: null,
    error: null,
    unsupportedReason: 'portable',
    canCheck: false,
    canDownload: false,
    canInstall: false,
  })
  await controller.startupCheck()
  await controller.check()
  await controller.download()
  await controller.install()
  assert.deepEqual([adapter.checkCalls, adapter.downloadCalls, adapter.installCalls], [0, 0, 0])
})

test('startup check runs once and duplicate manual checks share one provider request', async () => {
  const pending = deferred()
  const { adapter, controller } = createSupportedController()
  adapter.checkImplementation = () => pending.promise

  const first = controller.startupCheck()
  const second = controller.startupCheck()
  const manual = controller.check()
  assert.equal(adapter.checkCalls, 0)
  await Promise.resolve()
  assert.equal(adapter.checkCalls, 1)
  assert.equal(controller.getState().status, 'checking')
  pending.resolve()
  await Promise.all([first, second, manual])
  assert.equal(adapter.checkCalls, 1)
})

test('startup discovery alone never downloads or installs an available update', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.checkImplementation = async () => {
    adapter.emit('update-available', { version: '1.3.0' })
  }

  const state = await controller.startupCheck()
  assert.equal(state.status, 'available')
  assert.equal(adapter.checkCalls, 1)
  assert.equal(adapter.downloadCalls, 0)
  assert.equal(adapter.installCalls, 0)
})

test('publishes update availability, safe release metadata, download progress, and auto-installs', async () => {
  const { adapter, controller, states } = createSupportedController()
  adapter.checkImplementation = async () => {
    adapter.emit('update-available', {
      version: '1.3.0',
      releaseName: ' Dayline   1.3.0 ',
      releaseNotes: '<b>새 기능</b>  추가',
    })
  }
  await controller.check()
  assert.deepEqual(controller.getState(), {
    status: 'available',
    currentVersion: '1.2.3',
    availableVersion: '1.3.0',
    releaseName: 'Dayline 1.3.0',
    releaseNotes: '새 기능 추가',
    progress: null,
    error: null,
    unsupportedReason: null,
    canCheck: true,
    canDownload: true,
    canInstall: false,
  })

  adapter.downloadImplementation = async () => {
    adapter.emit('download-progress', { percent: 41.25 })
    adapter.emit('update-downloaded', { version: '1.3.0' })
  }
  await Promise.all([controller.download(), controller.download()])
  assert.equal(adapter.downloadCalls, 1)
  assert.equal(adapter.installCalls, 1)
  assert.deepEqual(adapter.installArguments, [true, true])
  assert.equal(controller.getState().status, 'installing')
  assert.equal(controller.getState().progress, 100)
  assert.equal(controller.getState().canCheck, false)
  const checksBeforeDownloadedRetry = adapter.checkCalls
  assert.equal((await controller.check()).status, 'installing')
  assert.equal(adapter.checkCalls, checksBeforeDownloadedRetry)
  assert.ok(states.some((state) => state.status === 'downloading' && state.progress === 41.25))
  assert.ok(states.some((state) => state.status === 'downloaded' && state.progress === 100))
})

test('reports no update and clears stale available version', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.checkImplementation = async () => {
    adapter.emit('update-available', { version: '2.0.0' })
  }
  await controller.check()
  adapter.checkImplementation = async () => {
    adapter.emit('update-not-available', { version: '1.2.3' })
  }
  await controller.check()
  assert.equal(controller.getState().status, 'not-available')
  assert.equal(controller.getState().availableVersion, null)
})

test('install flushes persistence before invoking a silent forced-relaunch install and is idempotent', async () => {
  const sequence = []
  const { adapter, controller } = createSupportedController({
    beforeInstall: async () => sequence.push('prepare'),
  })
  adapter.quitAndInstall = (isSilent, forceRunAfter) => {
    adapter.installCalls += 1
    sequence.push('quit')
    adapter.installArguments = [isSilent, forceRunAfter]
  }
  adapter.emit('update-downloaded', { version: '1.3.0' })
  await Promise.all([controller.install(), controller.install(), controller.install()])
  assert.deepEqual(sequence, ['prepare', 'quit'])
  assert.equal(adapter.installCalls, 1)
  assert.deepEqual(adapter.installArguments, [true, true])
  assert.equal(controller.getState().status, 'installing')
})

test('a failed explicit download never starts the installer', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-available', { version: '1.3.0' })
  adapter.downloadImplementation = async () => {
    throw new Error('temporary download failure')
  }

  const state = await controller.download()
  assert.equal(adapter.downloadCalls, 1)
  assert.equal(adapter.installCalls, 0)
  assert.equal(state.status, 'available')
  assert.equal(state.canDownload, true)
  assert.equal(state.error, 'UPDATE_DOWNLOAD_FAILED')
})

test('a late update-downloaded event consumes explicit consent and installs exactly once', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-available', { version: '1.3.0' })
  adapter.downloadImplementation = async () => ['C:\\cache\\Dayline-Setup.exe']

  const afterDownload = await controller.download()
  assert.equal(afterDownload.status, 'downloading')
  assert.equal(adapter.installCalls, 0)

  adapter.emit('update-downloaded', { version: '1.3.0' })
  adapter.emit('update-downloaded', { version: '1.3.0' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.installCalls, 1)
  assert.deepEqual(adapter.installArguments, [true, true])
  assert.equal(controller.getState().status, 'installing')
})

test('a stale downloaded event cannot consume consent for a newer retry version', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-available', { version: '1.1.0' })
  adapter.downloadImplementation = async () => {
    throw new Error('first download failed')
  }
  await controller.download()

  adapter.emit('update-available', { version: '1.2.0' })
  adapter.downloadImplementation = async () => ['C:\\cache\\Dayline-Setup-1.2.0.exe']
  await controller.download()
  assert.equal(controller.getState().status, 'downloading')

  adapter.emit('update-downloaded', { version: '1.1.0' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.installCalls, 0)
  assert.equal(controller.getState().status, 'downloading')
  assert.equal(controller.getState().availableVersion, '1.2.0')

  adapter.emit('update-downloaded', { version: '1.2.0' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.installCalls, 1)
  assert.deepEqual(adapter.installArguments, [true, true])
  assert.equal(controller.getState().status, 'installing')
})

test('a stale downloaded event cannot replace a newer available version without active consent', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-available', { version: '1.2.0', releaseNotes: 'new release' })

  adapter.emit('update-downloaded', { version: '1.1.0', releaseNotes: 'stale release' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(adapter.installCalls, 0)
  assert.deepEqual(controller.getState(), {
    status: 'available',
    currentVersion: '1.2.3',
    availableVersion: '1.2.0',
    releaseName: null,
    releaseNotes: 'new release',
    progress: null,
    error: null,
    unsupportedReason: null,
    canCheck: true,
    canDownload: true,
    canInstall: false,
  })
})

test('a downloaded event without explicit download consent remains ready for manual install', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-downloaded', { version: '1.3.0' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(adapter.installCalls, 0)
  assert.equal(controller.getState().status, 'downloaded')
  assert.equal(controller.getState().canInstall, true)
})

test('a provider download error revokes auto-install consent even if completion arrives later', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.emit('update-available', { version: '1.3.0' })
  adapter.downloadImplementation = async () => ['C:\\cache\\Dayline-Setup.exe']
  await controller.download()

  adapter.emit('error', new Error('download transport closed'))
  assert.equal(controller.getState().status, 'available')
  assert.equal(controller.getState().error, 'UPDATE_DOWNLOAD_FAILED')

  adapter.emit('update-downloaded', { version: '1.3.0' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(adapter.installCalls, 0)
  assert.equal(controller.getState().status, 'downloaded')
  assert.equal(controller.getState().canInstall, true)
})

test('failed installs remain actionable for retry', async () => {
  let recoveryCalls = 0
  const adapter = new FakeUpdater()
  const states = []
  const controller = createUpdaterController({
    adapter,
    currentVersion: '1.2.3',
    support: { supported: true, reason: null },
    broadcast: (state) => states.push(state),
    afterInstallFailure: async () => { recoveryCalls += 1 },
  })
  adapter.emit('update-available', { version: '1.3.0' })
  adapter.quitAndInstall = () => {
    adapter.installCalls += 1
    throw new Error('installer launch failed')
  }
  adapter.downloadImplementation = async () => adapter.emit('update-downloaded', { version: '1.3.0' })
  let state = await controller.download()
  assert.equal(state.status, 'downloaded')
  assert.equal(state.canInstall, true)
  assert.equal(state.error, 'UPDATE_INSTALL_FAILED')
  assert.equal(recoveryCalls, 1)

  adapter.quitAndInstall = () => {
    adapter.installCalls += 1
  }
  await controller.install()
  assert.equal(adapter.installCalls, 2)
  assert.equal(controller.getState().status, 'installing')
})

test('an asynchronous installer launch error recovers the app and permits retry', async () => {
  let recoveryCalls = 0
  const adapter = new FakeUpdater()
  const controller = createUpdaterController({
    adapter,
    currentVersion: '1.2.3',
    support: { supported: true, reason: null },
    afterInstallFailure: async () => { recoveryCalls += 1 },
  })
  adapter.emit('update-downloaded', { version: '1.3.0' })
  await controller.install()
  adapter.emit('error', new Error('installer process failed'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(recoveryCalls, 1)
  assert.equal(controller.getState().status, 'downloaded')
  assert.equal(controller.getState().canInstall, true)
  await controller.install()
  assert.equal(adapter.installCalls, 2)
})

test('a synchronous installer error returns the recovered state instead of stale installing state', async () => {
  let recoveryCalls = 0
  const adapter = new FakeUpdater()
  const controller = createUpdaterController({
    adapter,
    currentVersion: '1.2.3',
    support: { supported: true, reason: null },
    afterInstallFailure: async () => { recoveryCalls += 1 },
  })
  adapter.emit('update-downloaded', { version: '1.3.0' })
  adapter.quitAndInstall = () => {
    adapter.installCalls += 1
    adapter.emit('error', new Error('synchronous installer process failure'))
  }

  const returned = await controller.install()
  assert.equal(recoveryCalls, 1)
  assert.equal(returned.status, 'downloaded')
  assert.deepEqual(returned, controller.getState())
  assert.equal(returned.canInstall, true)
})

test('sanitizes provider errors and does not expose URLs, tokens, or local paths', async () => {
  const { adapter, controller } = createSupportedController()
  adapter.checkImplementation = async () => {
    throw new Error('GET https://token@github.com/lsy4946/dayline C:\\Users\\someone 403')
  }
  const state = await controller.check()
  assert.equal(state.error, 'UPDATE_ACCESS_DENIED')
  assert.equal(JSON.stringify(state).includes('github.com'), false)
  assert.equal(sanitizeUpdaterError(new Error('sha512 mismatch'), 'download'), 'UPDATE_INTEGRITY_FAILED')
  assert.equal(sanitizeUpdaterError(new Error('ENOTFOUND github.com'), 'check'), 'UPDATE_NETWORK_UNAVAILABLE')
  assert.equal(normalizeReleaseNotes([{ note: '<p>A</p>' }, { note: 'B' }]), 'A\n\nB')
  assert.equal(
    normalizeReleaseNotes('<h2>주요 변경</h2><ul><li>첫 항목</li><li>둘째 항목</li></ul><script>alert(1)</script>'),
    '## 주요 변경\n\n- 첫 항목\n- 둘째 항목',
  )
})

test('normalizes full changelog arrays in ascending version order and deduplicates releases', () => {
  const notes = normalizeReleaseNotes([
    { version: '0.3.2', note: '<h3>최신</h3><p>두 번째 변경</p><a href="https://example.com">안전한 링크 문구</a>' },
    { version: 'v0.3.1', note: '<p>첫 번째 변경</p>' },
    { version: '0.3.2', note: '<script>steal()</script><p>추가 변경</p>' },
    { version: 'not-a-version', note: '<b>버전 없는 보충</b>' },
    null,
  ])

  assert.equal(
    notes,
    '## v0.3.1\n\n첫 번째 변경\n\n## v0.3.2\n\n### 최신\n\n두 번째 변경\n\n안전한 링크 문구\n\n추가 변경\n\n버전 없는 보충',
  )
  assert.equal((notes.match(/## v0\.3\.2/g) || []).length, 1)
  assert.equal(notes.includes('https://example.com'), false)
  assert.equal(notes.includes('steal()'), false)
  const numericNotes = normalizeReleaseNotes([
    { version: '0.3.10', note: '열 번째' },
    { version: '0.3.2', note: '두 번째' },
  ])
  assert.ok(numericNotes.indexOf('v0.3.2') < numericNotes.indexOf('v0.3.10'))
})

test('handles string and malformed release notes and caps output without splitting a surrogate pair', () => {
  assert.equal(normalizeReleaseNotes('<p>한 줄</p>\r\n<p>두 줄</p>'), '한 줄\n\n두 줄')
  assert.equal(normalizeReleaseNotes({ note: 'ignored' }), null)
  assert.equal(normalizeReleaseNotes([undefined, 42, { version: 'bad', note: 7 }]), null)

  const capped = normalizeReleaseNotes(`${'a'.repeat(128 * 1024 - 1)}😀tail`)
  assert.ok(capped.length <= 128 * 1024)
  assert.equal(/[\uD800-\uDBFF]$/.test(capped), false)
})

test('retains multiple substantial release sections within the cumulative safety cap', () => {
  const firstBody = `첫 버전 ${'a'.repeat(32 * 1024)}`
  const secondBody = `둘째 버전 ${'b'.repeat(32 * 1024)}`
  const notes = normalizeReleaseNotes([
    { version: '0.3.2', note: secondBody },
    { version: '0.3.1', note: firstBody },
  ])

  assert.ok(notes.length > 64 * 1024)
  assert.ok(notes.length <= 128 * 1024)
  assert.ok(notes.indexOf('## v0.3.1') < notes.indexOf('## v0.3.2'))
  assert.ok(notes.includes(firstBody))
  assert.ok(notes.includes(secondBody))
})

test('preserves the complete latest release when cumulative notes exceed the cap', () => {
  const latestBody = `LATEST-START ${'c'.repeat(60 * 1024)} LATEST-END`
  const oldestBody = `OLDEST-START ${'a'.repeat(64 * 1024)} OLDEST-END`
  const notes = normalizeReleaseNotes([
    { version: '0.3.3', note: latestBody },
    { version: '0.3.2', note: `MIDDLE ${'b'.repeat(64 * 1024)}` },
    { version: '0.3.1', note: oldestBody },
  ])

  assert.ok(notes.length <= 128 * 1024)
  assert.ok(notes.includes('## v0.3.3'))
  assert.ok(notes.includes(latestBody))
  assert.ok(notes.indexOf('## v0.3.1') < notes.indexOf('## v0.3.2'))
  assert.ok(notes.indexOf('## v0.3.2') < notes.indexOf('## v0.3.3'))
  assert.equal(notes.includes('OLDEST-END'), false)
  assert.ok(notes.endsWith(latestBody))
})
