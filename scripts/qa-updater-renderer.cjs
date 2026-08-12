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
      hasNotes: Boolean(document.querySelector('[data-qa="update-release-notes"]')),
    }
  })()`, 'available dialog and focus')
  assert.deepEqual(dialog, {
    role: 'alertdialog', modal: 'true', labelled: true, described: true,
    outsideInert: true, hasNotes: true,
  })

  qaStage = 'release-notes-semantics-and-scroll'
  const releaseNotes = await runIn(window, `(() => {
    const notes = document.querySelector('[data-qa="update-release-notes"]')
    if (!notes) return null
    const kinds = [...notes.querySelectorAll('[data-release-note-kind]')]
      .map((node) => ({ kind: node.dataset.releaseNoteKind, tag: node.tagName }))
    const before = notes.scrollTop
    notes.scrollTop = Math.min(64, notes.scrollHeight)
    return {
      role: notes.getAttribute('role'),
      label: notes.getAttribute('aria-label'),
      kinds,
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
  assert.deepEqual(releaseNotes.kinds.slice(0, 5), [
    { kind: 'heading', tag: 'H4' },
    { kind: 'paragraph', tag: 'P' },
    { kind: 'list', tag: 'UL' },
    { kind: 'heading', tag: 'H5' },
    { kind: 'list', tag: 'OL' },
  ])
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

  await waitFor(window, `document.querySelector('[data-qa="update-dialog-primary"]')?.textContent.includes('설치')`, 'downloaded install action')
  qaStage = 'install'
  await runIn(window, `document.querySelector('[data-qa="update-dialog-primary"]')?.click()`)
  await waitFor(window, `window.dayline.__updateQa.getCalls().install === 1
    && document.body.innerText.includes('설치하고')`, 'fake install invocation and installing state')

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
  await waitFor(startupWindow, `(() => {
    const layer = document.querySelector('[data-qa="update-available-dialog"]')
    const primary = layer?.querySelector('[data-qa="update-dialog-primary"]')
    const shell = document.querySelector('.main-shell')
    return Boolean(layer && primary && document.activeElement === primary && shell?.inert)
  })()`, 'startup available dialog, focus, and inert background')
  await runIn(startupWindow, `document.querySelector('[data-qa="update-dialog-later"]')?.click()`)
  await waitFor(startupWindow, `!document.querySelector('[data-qa="update-available-dialog"]')
    && !document.querySelector('.main-shell')?.inert`, 'startup dialog later dismissal')

  qaStage = 'cleanup'
  window.destroy()
  latestWindow.destroy()
  startupWindow.destroy()
  clearTimeout(watchdog)
  app.quit()
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error?.stack || String(error))
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(1)
})
