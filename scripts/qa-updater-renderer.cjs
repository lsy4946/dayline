const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')

function waitForLoad(window) {
  return new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve)
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer failed to load (${code}): ${description}`))
    })
  })
}

function runIn(window, expression) {
  return window.webContents.executeJavaScript(expression)
}

async function waitFor(window, expression, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await runIn(window, expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

const watchdog = setTimeout(() => {
  console.error(new Error(`Updater renderer QA exceeded 30 seconds at ${qaStage}`))
  app.exit(1)
}, 30_000)

let qaStage = 'boot'

app.whenReady().then(async () => {
  qaStage = 'create-main'
  const window = new BrowserWindow({
    width: 1280,
    height: 780,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'qa-updater-preload.cjs'),
    },
  })
  const loaded = waitForLoad(window)
  await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode: 'main', qaDate: '2026-08-12' },
  })
  await loaded

  qaStage = 'idle-menu'
  await waitFor(window, `Boolean(document.querySelector('[data-qa="update-menu-button"]'))`, 'update menu')
  assert.equal(await runIn(window, `Boolean(document.querySelector('[data-qa="update-available-dialog"]'))`), false)

  await runIn(window, `document.querySelector('[data-qa="update-menu-button"]')?.click()`)
  await waitFor(window, `document.querySelector('[data-qa="update-status"]')?.classList.contains('status-idle')`, 'idle panel')
  await runIn(window, `document.querySelector('[data-qa="update-check"]')?.click()`)
  qaStage = 'manual-checking'
  await waitFor(window, `document.querySelector('[data-qa="update-status"]')?.classList.contains('status-checking')`, 'manual checking state')
  assert.equal(await runIn(window, `document.querySelector('[data-qa="update-check"]')?.disabled`), true)

  qaStage = 'available-dialog'
  const dialog = await waitFor(window, `(() => {
    const layer = document.querySelector('[data-qa="update-available-dialog"]')
    const alert = layer?.querySelector('[role="alertdialog"]')
    const primary = layer?.querySelector('[data-qa="update-dialog-primary"]')
    if (!layer || !alert || !primary || document.activeElement !== primary) return null
    return {
      role: alert.getAttribute('role'),
      modal: alert.getAttribute('aria-modal'),
      labelled: Boolean(alert.getAttribute('aria-labelledby')),
      described: Boolean(alert.getAttribute('aria-describedby')),
      outsideInert: [...layer.parentElement.children].filter((child) => child !== layer)
        .some((child) => child.inert),
      dialogReleaseNoteCopies: layer.querySelectorAll('[data-qa="update-release-notes"]').length,
    }
  })()`, 'available dialog and focus')
  assert.deepEqual(dialog, {
    role: 'alertdialog', modal: 'true', labelled: true, described: true,
    outsideInert: true, dialogReleaseNoteCopies: 1,
  })
  assert.equal(
    await runIn(window, `window.dayline.__updateQa.getCalls().install`),
    0,
    'Checking and finding an update must not install without explicit consent',
  )

  qaStage = 'release-notes-semantics-and-scroll'
  const releaseNotes = await runIn(window, `(() => {
    const notes = document.querySelector(
      '[data-qa="update-available-dialog"] [data-qa="update-release-notes"]',
    )
    if (!notes) return null
    const kinds = [...notes.querySelectorAll('[data-release-note-kind]')]
      .map((node) => ({ kind: node.dataset.releaseNoteKind, tag: node.tagName }))
    const headings = [...notes.querySelectorAll('h4, h5')].map((heading) => heading.textContent?.trim())
    const versionGroups = Object.fromEntries(
      [...notes.querySelectorAll('h4')]
        .filter((heading) => /^v\\d+\\.\\d+\\.\\d+$/.test(heading.textContent?.trim() ?? ''))
        .map((heading) => {
          const items = []
          let sibling = heading.nextElementSibling
          while (sibling && !sibling.matches('h4')) {
            items.push(...[...sibling.querySelectorAll('li')].map((item) => item.textContent?.trim()))
            sibling = sibling.nextElementSibling
          }
          return [heading.textContent.trim(), items]
        }),
    )
    const before = notes.scrollTop
    notes.scrollTop = Math.min(64, notes.scrollHeight)
    return {
      role: notes.getAttribute('role'),
      label: notes.getAttribute('aria-label'),
      kinds,
      headings,
      versionGroups,
      listItems: [...notes.querySelectorAll('li')].map((item) => item.textContent),
      hasUnsafeOrInteractiveNode: Boolean(notes.querySelector('a, script, style, iframe, object, embed')),
      unsafeGlobal: Boolean(window.__unsafeReleaseNote),
      hasReadableLinkText: notes.textContent.includes('릴리스 보기 — https://example.invalid/release'),
      hasLiteralHtmlText: notes.textContent.includes('<script>window.__unsafeReleaseNote = true</script>'),
      overflowY: getComputedStyle(notes).overflowY,
      overflows: notes.scrollHeight > notes.clientHeight,
      scrollMoved: notes.scrollTop > before,
    }
  })()`)
  assert.ok(releaseNotes, 'Structured release notes must render')
  assert.equal(releaseNotes.role, 'region')
  assert.equal(releaseNotes.label, '릴리스 노트 상세')
  assert.deepEqual(releaseNotes.kinds.slice(0, 10), [
    { kind: 'heading', tag: 'H4' },
    { kind: 'heading', tag: 'H5' },
    { kind: 'list', tag: 'UL' },
    { kind: 'heading', tag: 'H5' },
    { kind: 'list', tag: 'UL' },
    { kind: 'heading', tag: 'H4' },
    { kind: 'heading', tag: 'H5' },
    { kind: 'list', tag: 'UL' },
    { kind: 'heading', tag: 'H5' },
    { kind: 'list', tag: 'OL' },
  ])
  assert.deepEqual(
    releaseNotes.headings.slice(0, 6),
    ['v0.3.1', '반복 일정', '좌측 메뉴', 'v0.3.2', '업데이트', '보안 검증'],
    'Cumulative release scopes must preserve chronological version order',
  )
  assert.deepEqual(releaseNotes.versionGroups, {
    'v0.3.1': [
      '반복 일정 템플릿을 캘린더로 드래그할 수 있습니다.',
      '좌측 메뉴를 완전히 접을 수 있습니다.',
      '최근 삭제 동작을 다듬었습니다.',
    ],
    'v0.3.2': [
      '누적 변경 사항을 버전별로 표시합니다.',
      '다운로드한 업데이트를 자동 설치하고 다시 시작합니다.',
      '릴리스 보기 — https://example.invalid/release는 안전한 텍스트로 표시됩니다.',
      'HTML은 실행하지 않고 텍스트로 표시합니다.',
      '링크는 클릭 요소가 아닌 읽을 수 있는 텍스트로 표시합니다.',
    ],
  })
  assert.ok(
    releaseNotes.listItems.some((item) => item.includes('릴리스 보기')
      && item.includes('https://example.invalid/release')),
  )
  assert.equal(releaseNotes.hasUnsafeOrInteractiveNode, false)
  assert.equal(releaseNotes.unsafeGlobal, false)
  assert.equal(releaseNotes.hasReadableLinkText, true)
  assert.equal(releaseNotes.hasLiteralHtmlText, true)
  assert.equal(['auto', 'scroll'].includes(releaseNotes.overflowY), true)
  assert.equal(releaseNotes.overflows, true)
  assert.equal(releaseNotes.scrollMoved, true)

  await runIn(window, `document.querySelector('[data-qa="update-dialog-primary"]')?.click()`)
  qaStage = 'download-progress'
  const downloading = await waitFor(window, `(() => {
    const progress = document.querySelector('[data-qa="update-dialog-progress"]')
    if (!progress) return null
    return {
      role: progress.getAttribute('role'),
      min: progress.getAttribute('aria-valuemin'),
      max: progress.getAttribute('aria-valuemax'),
      now: progress.getAttribute('aria-valuenow'),
      calls: window.dayline.__updateQa.getCalls().download,
    }
  })()`, 'dialog download progress')
  assert.deepEqual(downloading, { role: 'progressbar', min: '0', max: '100', now: '37', calls: 1 })

  qaStage = 'silent-auto-install'
  const silentInstall = await waitFor(window, `(() => {
    const calls = window.dayline.__updateQa.getCalls()
    const dialog = document.querySelector('[data-qa="update-available-dialog"]')
    if (calls.install !== 1 || dialog?.dataset.state !== 'installing') return null
    return {
      downloadCalls: calls.download,
      installCalls: calls.install,
      installArguments: calls.installArguments,
      hasManualInstallAction: Boolean(document.querySelector('[data-qa="update-dialog-primary"]')),
      copy: dialog?.innerText,
    }
  })()`, 'silent installation immediately after download')
  assert.equal(silentInstall.downloadCalls, 1)
  assert.equal(silentInstall.installCalls, 1)
  assert.deepEqual(silentInstall.installArguments, [true, true])
  assert.equal(silentInstall.hasManualInstallAction, false)
  assert.ok(silentInstall.copy.includes('설치하고'))

  // A second isolated renderer verifies the explicit "latest" manual result without
  // coupling to the available-version notification flow above.
  qaStage = 'latest-window'
  const latestWindow = new BrowserWindow({
    width: 1120,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'qa-updater-preload.cjs'),
    },
  })
  const latestLoaded = waitForLoad(latestWindow)
  await latestWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode: 'main', qaDate: '2026-08-12' },
  })
  await latestLoaded
  qaStage = 'latest-state'
  await waitFor(latestWindow, `Boolean(window.dayline?.__updateQa)`, 'latest fixture')
  await runIn(latestWindow, `window.dayline.__updateQa.notAvailable()`)
  await runIn(latestWindow, `document.querySelector('[data-qa="update-menu-button"]')?.click()`)
  await waitFor(latestWindow, `document.querySelector('[data-qa="update-status"]')?.classList.contains('status-not-available')`, 'latest panel result')
  assert.equal(await runIn(latestWindow, `Boolean(document.querySelector('[data-qa="update-available-dialog"]'))`), false)

  qaStage = 'startup-available'
  const startupWindow = new BrowserWindow({
    width: 1120,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'qa-updater-preload.cjs'),
    },
  })
  const startupLoaded = waitForLoad(startupWindow)
  await startupWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode: 'main', qaDate: '2026-08-12', updateQa: 'available' },
  })
  await startupLoaded
  assert.equal(await runIn(startupWindow, `window.dayline.__updateQa.getCalls().install`), 0)
  await waitFor(startupWindow, `(() => {
    const layer = document.querySelector('[data-qa="update-available-dialog"]')
    const primary = layer?.querySelector('[data-qa="update-dialog-primary"]')
    const shell = document.querySelector('.main-shell')
    return Boolean(layer && primary && document.activeElement === primary && shell?.inert)
  })()`, 'startup available dialog, focus, and inert background')
  assert.equal(
    await runIn(startupWindow, `window.dayline.__updateQa.getCalls().install`),
    0,
    'Startup availability must not install before explicit consent',
  )
  await runIn(startupWindow, `document.querySelector('[data-qa="update-dialog-later"]')?.click()`)
  await waitFor(startupWindow, `!document.querySelector('[data-qa="update-available-dialog"]')
    && !document.querySelector('.main-shell')?.inert`, 'startup dialog later dismissal')

  qaStage = 'deferred-task-update'
  const taskConflictWindow = new BrowserWindow({
    width: 1120,
    height: 700,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'qa-updater-preload.cjs'),
    },
  })
  const taskConflictLoaded = waitForLoad(taskConflictWindow)
  await taskConflictWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode: 'main', qaDate: '2026-08-12' },
  })
  await taskConflictLoaded
  await waitFor(taskConflictWindow, `Boolean(document.querySelector('[data-qa="schedule-add"]'))`, 'task update-conflict launcher')
  await runIn(taskConflictWindow, `document.querySelector('[data-qa="schedule-add"]')?.click()`)
  await waitFor(taskConflictWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.mode === 'create'`, 'task update-conflict editor')
  await runIn(taskConflictWindow, `(() => {
    const input = document.querySelector('[data-qa="task-modal"] .title-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'QA deferred task draft')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(taskConflictWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'true'`, 'dirty task before update event')
  await runIn(taskConflictWindow, `window.dayline.__updateQa.available()`)
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.deepEqual(
    await runIn(taskConflictWindow, `(() => ({
      updateState: window.dayline.__updateQa.getState().status,
      updatePromptOpen: Boolean(document.querySelector('[data-qa="update-available-dialog"]')),
      modalMode: document.querySelector('[data-qa="task-modal"]')?.dataset.mode,
      dirty: document.querySelector('[data-qa="task-modal"]')?.dataset.dirty,
      draft: document.querySelector('[data-qa="task-modal"] .title-input')?.value,
    }))()`),
    {
      updateState: 'available',
      updatePromptOpen: false,
      modalMode: 'create',
      dirty: 'true',
      draft: 'QA deferred task draft',
    },
    'An available update must wait behind a dirty task editor without replacing its draft',
  )
  await runIn(taskConflictWindow, `document.querySelector('[data-qa="task-modal"] .modal-footer .secondary-button')?.click()`)
  await waitFor(taskConflictWindow, `Boolean(document.querySelector('[data-qa="update-available-dialog"]'))
    && !document.querySelector('[data-qa="task-modal"]')`, 'deferred task update prompt after editor close')

  // Force the otherwise transient overlap to ensure the update dialog owns Escape.
  // This catches propagation to TaskModal's window-level Escape listener.
  await runIn(taskConflictWindow, `(() => {
    document.querySelector('.main-shell').inert = false
    document.querySelector('[data-qa="schedule-add"]')?.click()
  })()`)
  await waitFor(taskConflictWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`, 'task modal under update prompt')
  await runIn(taskConflictWindow, `(() => {
    const input = document.querySelector('[data-qa="task-modal"] .title-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'QA task Escape sentinel')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(taskConflictWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'true'`, 'dirty task Escape sentinel')
  await runIn(taskConflictWindow, `(() => {
    const target = document.querySelector('[data-qa="update-dialog-later"]')
    target?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
    }))
  })()`)
  await waitFor(taskConflictWindow, `!document.querySelector('[data-qa="update-available-dialog"]')`, 'task update prompt Escape dismissal')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(
    await runIn(taskConflictWindow, `(() => ({
      modalOpen: Boolean(document.querySelector('[data-qa="task-modal"]')),
      dirty: document.querySelector('[data-qa="task-modal"]')?.dataset.dirty,
      draft: document.querySelector('[data-qa="task-modal"] .title-input')?.value,
    }))()`),
    { modalOpen: true, dirty: 'true', draft: 'QA task Escape sentinel' },
    'Escape handled by the update prompt must not also close the underlying task editor',
  )
  await runIn(taskConflictWindow, `document.querySelector('[data-qa="task-modal"] .modal-footer .secondary-button')?.click()`)
  await waitFor(taskConflictWindow, `!document.querySelector('[data-qa="task-modal"]')`, 'task conflict cleanup')

  qaStage = 'deferred-template-update'
  const templateConflictWindow = new BrowserWindow({
    width: 1120,
    height: 700,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'qa-updater-preload.cjs'),
    },
  })
  const templateConflictLoaded = waitForLoad(templateConflictWindow)
  await templateConflictWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { mode: 'main', qaDate: '2026-08-12' },
  })
  await templateConflictLoaded
  await waitFor(templateConflictWindow, `Boolean(document.querySelector('[data-rail-action="templates"]'))`, 'template update-conflict launcher')
  await runIn(templateConflictWindow, `document.querySelector('[data-rail-action="templates"]')?.click()`)
  await waitFor(templateConflictWindow, `Boolean(document.querySelector('[data-qa="template-form-toggle"]'))`, 'template create launcher')
  await runIn(templateConflictWindow, `document.querySelector('[data-qa="template-form-toggle"]')?.click()`)
  await waitFor(templateConflictWindow, `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'create'`, 'template update-conflict editor')
  await runIn(templateConflictWindow, `(() => {
    const input = document.querySelector('[data-qa="template-modal"] .title-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'QA deferred template draft')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(templateConflictWindow, `document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'true'`, 'dirty template before update event')
  await runIn(templateConflictWindow, `window.dayline.__updateQa.available()`)
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.deepEqual(
    await runIn(templateConflictWindow, `(() => ({
      updateState: window.dayline.__updateQa.getState().status,
      updatePromptOpen: Boolean(document.querySelector('[data-qa="update-available-dialog"]')),
      modalMode: document.querySelector('[data-qa="template-modal"]')?.dataset.mode,
      dirty: document.querySelector('[data-qa="template-modal"]')?.dataset.dirty,
      draft: document.querySelector('[data-qa="template-modal"] .title-input')?.value,
    }))()`),
    {
      updateState: 'available',
      updatePromptOpen: false,
      modalMode: 'create',
      dirty: 'true',
      draft: 'QA deferred template draft',
    },
    'An available update must wait behind a dirty template editor without replacing its draft',
  )
  await runIn(templateConflictWindow, `document.querySelector('[data-qa="template-form-cancel"]')?.click()`)
  await waitFor(templateConflictWindow, `Boolean(document.querySelector('[data-qa="update-available-dialog"]'))
    && !document.querySelector('[data-qa="template-modal"]')`, 'deferred template update prompt after editor close')

  await runIn(templateConflictWindow, `(() => {
    document.querySelector('.main-shell').inert = false
    document.querySelector('[data-qa="template-form-toggle"]')?.click()
  })()`)
  await waitFor(templateConflictWindow, `Boolean(document.querySelector('[data-qa="template-modal"]'))`, 'template modal under update prompt')
  await runIn(templateConflictWindow, `(() => {
    const input = document.querySelector('[data-qa="template-modal"] .title-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'QA template Escape sentinel')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(templateConflictWindow, `document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'true'`, 'dirty template Escape sentinel')
  await runIn(templateConflictWindow, `(() => {
    const target = document.querySelector('[data-qa="update-dialog-later"]')
    target?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
    }))
  })()`)
  await waitFor(templateConflictWindow, `!document.querySelector('[data-qa="update-available-dialog"]')`, 'template update prompt Escape dismissal')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(
    await runIn(templateConflictWindow, `(() => ({
      modalOpen: Boolean(document.querySelector('[data-qa="template-modal"]')),
      dirty: document.querySelector('[data-qa="template-modal"]')?.dataset.dirty,
      draft: document.querySelector('[data-qa="template-modal"] .title-input')?.value,
    }))()`),
    { modalOpen: true, dirty: 'true', draft: 'QA template Escape sentinel' },
    'Escape handled by the update prompt must not also close the underlying template editor',
  )
  await runIn(templateConflictWindow, `document.querySelector('[data-qa="template-form-cancel"]')?.click()`)
  await waitFor(templateConflictWindow, `!document.querySelector('[data-qa="template-modal"]')`, 'template conflict cleanup')

  qaStage = 'cleanup'
  window.destroy()
  latestWindow.destroy()
  startupWindow.destroy()
  taskConflictWindow.destroy()
  templateConflictWindow.destroy()
  clearTimeout(watchdog)
  app.quit()
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error?.stack || String(error))
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(1)
})
