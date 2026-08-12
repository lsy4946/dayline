const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
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
    disableWebInstaller: true,
  })
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

test('publishes update availability, safe release metadata, download progress, and completion', async () => {
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
  assert.equal(controller.getState().status, 'downloaded')
  assert.equal(controller.getState().progress, 100)
  assert.equal(controller.getState().canCheck, false)
  const checksBeforeDownloadedRetry = adapter.checkCalls
  assert.equal((await controller.check()).status, 'downloaded')
  assert.equal(adapter.checkCalls, checksBeforeDownloadedRetry)
  assert.ok(states.some((state) => state.status === 'downloading' && state.progress === 41.25))
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

test('install flushes persistence before invoking quitAndInstall and is idempotent', async () => {
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
  assert.deepEqual(adapter.installArguments, [false, true])
  assert.equal(controller.getState().status, 'installing')
})

test('failed downloads and installs remain actionable for retry', async () => {
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
  adapter.downloadImplementation = async () => {
    throw new Error('temporary download failure')
  }
  let state = await controller.download()
  assert.equal(state.status, 'available')
  assert.equal(state.canDownload, true)
  assert.equal(state.error, 'UPDATE_DOWNLOAD_FAILED')

  adapter.downloadImplementation = async () => adapter.emit('update-downloaded', { version: '1.3.0' })
  await controller.download()
  adapter.quitAndInstall = () => {
    adapter.installCalls += 1
    throw new Error('installer launch failed')
  }
  state = await controller.install()
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
