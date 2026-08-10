const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function waitForLoad(window) {
  return new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve)
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer failed to load (${code}): ${description}`))
    })
  })
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runIn(window, expression) {
  return window.webContents.executeJavaScript(expression)
}

async function waitForRenderer(window, expression, label, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await runIn(window, expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }
  const detail = lastError ? ` Last renderer error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}.${detail}`)
}

async function installQaHelpers(window) {
  await window.webContents.insertCSS(`
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  `)
  await runIn(window, `
    (() => {
      const setNativeValue = (element, value) => {
        if (!element) return false
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        setter?.call(element, value)
        element.dispatchEvent(new Event(
          element instanceof HTMLSelectElement ? 'change' : 'input',
          { bubbles: true },
        ))
        return true
      }
      window.__daylineQa = {
        setValue: (selector, value) => setNativeValue(document.querySelector(selector), value),
        scheduleIds: () => [...document.querySelectorAll(
          '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
        )].map((row) => row.dataset.taskId),
        clickButtonText: (scopeSelector, text) => {
          const scope = scopeSelector ? document.querySelector(scopeSelector) : document
          const button = [...(scope?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.trim().includes(text))
          button?.click()
          return Boolean(button)
        },
        contextMenu: (element) => {
          if (!element) return false
          element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
          return true
        },
      }
      return true
    })()
  `)
}

async function reloadRenderer(window) {
  const loaded = waitForLoad(window)
  window.webContents.reload()
  await loaded
  await installQaHelpers(window)
}

let qaTimeout

app.whenReady().then(async () => {
  qaTimeout = setTimeout(() => {
    console.error(new Error('Electron feature QA exceeded 60 seconds'))
    app.exit(1)
  }, 60_000)

  const outputDir = path.join(__dirname, '..', 'qa')
  fs.mkdirSync(outputDir, { recursive: true })
  const rendererPath = path.join(__dirname, '..', 'dist', 'index.html')
  const partition = `dayline-capture-qa-${process.pid}-${Date.now()}`

  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: '#f4f5f0',
    webPreferences: { backgroundThrottling: false, partition },
  })
  const widgetWindow = new BrowserWindow({
    width: 390,
    height: 620,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, partition },
  })

  const mainLoaded = waitForLoad(mainWindow)
  const widgetLoaded = waitForLoad(widgetWindow)
  await Promise.all([
    mainWindow.loadFile(rendererPath, { query: { mode: 'main' } }),
    widgetWindow.loadFile(rendererPath, { query: { mode: 'widget' } }),
    mainLoaded,
    widgetLoaded,
  ])
  await Promise.all([installQaHelpers(mainWindow), installQaHelpers(widgetWindow)])
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="quick-note-section"]')
      && document.querySelector('[data-qa="schedule-section"] .task-row[data-task-id]'))`,
    'main calendar and sidebar',
  )
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.widget-shell') && document.querySelector('.task-row[data-task-id]'))`,
    'widget task list',
  )

  await sleep(150)
  const [mainImage, widgetImage] = await Promise.all([
    mainWindow.webContents.capturePage(),
    widgetWindow.webContents.capturePage(),
  ])
  fs.writeFileSync(path.join(outputDir, 'main-window.png'), mainImage.toPNG())
  fs.writeFileSync(path.join(outputDir, 'widget-window.png'), widgetImage.toPNG())

  const sidebarStructure = await runIn(mainWindow, `
    (() => {
      const quick = document.querySelector('[data-qa="quick-note-section"]')
      const schedule = document.querySelector('[data-qa="schedule-section"]')
      const body = document.querySelector('.day-panel-body')
      if (!quick || !schedule || !body) return null
      const quickRect = quick.getBoundingClientRect()
      const scheduleRect = schedule.getBoundingClientRect()
      return {
        quickHeight: quickRect.height,
        scheduleHeight: scheduleRect.height,
        bodyHeight: body.getBoundingClientRect().height,
        hasLegacyProgress: Boolean(document.querySelector('.day-progress')),
        hasLegacyTip: Boolean(document.querySelector('.panel-tip')),
        hasLegacyCopy: document.body.innerText.includes('오늘의 흐름'),
      }
    })()
  `)
  assert.ok(sidebarStructure, 'The two new sidebar sections must render')
  assert.equal(sidebarStructure.hasLegacyProgress, false, 'Legacy today progress must be removed')
  assert.equal(sidebarStructure.hasLegacyTip, false, 'Legacy sidebar tip must be removed')
  assert.equal(sidebarStructure.hasLegacyCopy, false, 'Legacy today flow copy must be removed')
  assert.ok(sidebarStructure.bodyHeight > 0, 'Sidebar body must have usable height')
  assert.ok(
    Math.abs(sidebarStructure.quickHeight - sidebarStructure.scheduleHeight)
      <= sidebarStructure.bodyHeight * 0.15,
    `Sidebar sections must be split approximately 1:1 (${sidebarStructure.quickHeight}/${sidebarStructure.scheduleHeight})`,
  )

  // Direct year/month selection must stay in sync with previous/next navigation.
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.setValue('[aria-label="연도 선택"]', '2032')`),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="연도 선택"]')?.value === '2032'`,
    'year jump to 2032',
  )
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.setValue('[aria-label="월 선택"]', '1')`),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.header-title h1')?.textContent?.includes('2032년 2월')
      && document.querySelector('[aria-label="월 선택"]')?.value === '1'`,
    'month jump to February 2032',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="이전 달"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="월 선택"]')?.value === '0'`,
    'previous month after direct jump',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="다음 달"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="월 선택"]')?.value === '1'`,
    'next month after direct jump',
  )
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('.calendar-cell.is-today.is-selected'))`,
    'return to today',
  )

  const initialCounts = await runIn(mainWindow, `({
    calendar: document.querySelectorAll('.calendar-cell.is-selected .task-chip[data-task-id]').length,
    schedule: document.querySelectorAll(
      '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
    ).length,
  })`)

  // The sidebar + adds a multiline daily note, never a calendar task.
  await runIn(mainWindow, `document.querySelector('[aria-label="선택한 날짜에 순간 메모 추가"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.activeElement?.getAttribute('aria-label') === '새 순간 메모'`,
    'focused daily-note composer',
  )
  const quickNoteContent = 'QA 순간 메모 첫 줄\n형식 없는 두 번째 줄'
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.setValue('[aria-label="새 순간 메모"]', ${JSON.stringify(quickNoteContent)})`,
    ),
    true,
  )
  await runIn(mainWindow, `document.querySelector('.daily-note-composer .note-save')?.click()`)
  const quickNoteId = await waitForRenderer(
    mainWindow,
    `(() => {
      const item = [...document.querySelectorAll('[data-daily-note-id]')]
        .find((candidate) => candidate.querySelector('.note-content')?.textContent
          === ${JSON.stringify(quickNoteContent)})
      return item?.dataset.dailyNoteId ?? ''
    })()`,
    'saved multiline daily note',
  )
  const countsAfterQuickNote = await runIn(mainWindow, `({
    calendar: document.querySelectorAll('.calendar-cell.is-selected .task-chip[data-task-id]').length,
    schedule: document.querySelectorAll(
      '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
    ).length,
  })`)
  assert.deepEqual(countsAfterQuickNote, initialCounts, 'A daily note must not enter either calendar task count')
  await runIn(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"] .note-check')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"]')?.classList.contains('is-completed')`,
    'daily-note completion state',
  )

  const editableTask = await runIn(mainWindow, `
    (() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]:not(.is-completed)',
      )]
      const row = rows.find((candidate) => !candidate.querySelector('.task-due-time')) ?? rows[0]
      return row ? {
        id: row.dataset.taskId,
        title: row.querySelector('.task-title')?.textContent ?? '',
      } : null
    })()
  `)
  assert.ok(editableTask?.id && editableTask.title, 'An active task is required for task-detail QA')

  // Draft parent and child edits must be discarded on Cancel.
  await runIn(
    mainWindow,
    `(() => {
      const trigger = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )
      trigger?.focus()
      trigger?.click()
      return Boolean(trigger)
    })()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'task detail modal')
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.task-modal .title-input')?.value === ${JSON.stringify(editableTask.title)}
      && ['.side-rail', '.calendar-workspace', '.day-panel']
        .every((selector) => document.querySelector(selector)?.inert === true)`,
    'hydrated inert task modal',
  )
  const modalAccessibility = await runIn(mainWindow, `
    (() => {
      const modal = document.querySelector('.task-modal')
      const focusable = [...(modal?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
      if (!modal || focusable.length < 2) return null
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
      }))
      const wrappedBackward = document.activeElement === last
      last.focus()
      last.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }))
      return {
        outsideInert: ['.side-rail', '.calendar-workspace', '.day-panel']
          .every((selector) => document.querySelector(selector)?.inert === true),
        wrappedBackward,
        wrappedForward: document.activeElement === first,
      }
    })()
  `)
  assert.ok(modalAccessibility, 'Task modal must expose a keyboard focus loop')
  assert.equal(modalAccessibility.outsideInert, true, 'Task modal background must be inert')
  assert.equal(modalAccessibility.wrappedBackward, true, 'Shift+Tab must wrap to the modal end')
  assert.equal(modalAccessibility.wrappedForward, true, 'Tab must wrap to the modal start')
  const originalDetail = await runIn(mainWindow, `({
    title: document.querySelector('.task-modal .title-input')?.value,
    date: document.querySelector('.task-modal [aria-label="마감 날짜"]')?.value,
    note: document.querySelector('.task-modal [aria-label="일정 메모"]')?.value,
    color: document.querySelector('.task-modal .color-option.is-selected')?.getAttribute('aria-label'),
    subTaskCount: document.querySelectorAll('.task-modal .subtask-edit-row').length,
  })`)
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('.task-modal .title-input', ${JSON.stringify(`${editableTask.title} QA 취소`)})`,
  )
  await runIn(mainWindow, `window.__daylineQa.setValue('.task-modal [aria-label="마감 날짜"]', '2099-12-31')`)
  await runIn(mainWindow, `window.__daylineQa.setValue('.task-modal [aria-label="일정 메모"]', '저장되면 안 되는 메모')`)
  await runIn(mainWindow, `
    [...document.querySelectorAll('.task-modal .color-option')]
      .find((button) => !button.classList.contains('is-selected'))?.click()
    window.__daylineQa.clickButtonText('[aria-label="활성 상태 선택"]', '비활성')
    window.__daylineQa.setValue('[aria-label="subtask 추가"]', '취소될 세부 할 일')
    document.querySelector('.subtask-add-row button')?.click()
  `)
  await waitForRenderer(
    mainWindow,
    `[...document.querySelectorAll('.subtask-edit-row')]
      .some((row) => row.querySelector('input')?.value === '취소될 세부 할 일')`,
    'draft subtask before cancel',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '취소')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal')
      && document.activeElement === document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )
      && ['.side-rail', '.calendar-workspace', '.day-panel']
        .every((selector) => document.querySelector(selector)?.inert === false)`,
    'modal close, background release, and trigger focus restoration',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main')?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'reopened task detail')
  const discarded = await runIn(mainWindow, `(() => {
    const modal = document.querySelector('.task-modal')
    return modal?.querySelector('.title-input')?.value === ${JSON.stringify(originalDetail.title)}
      && modal?.querySelector('[aria-label="마감 날짜"]')?.value === ${JSON.stringify(originalDetail.date)}
      && modal?.querySelector('[aria-label="일정 메모"]')?.value === ${JSON.stringify(originalDetail.note)}
      && modal?.querySelector('.color-option.is-selected')?.getAttribute('aria-label')
        === ${JSON.stringify(originalDetail.color)}
      && ![...modal.querySelectorAll('.subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === '취소될 세부 할 일')
      && modal?.querySelectorAll('.subtask-edit-row').length === ${originalDetail.subTaskCount}
      && [...modal.querySelectorAll('[aria-label="활성 상태 선택"] button')]
        .find((button) => button.textContent?.includes('활성'))?.getAttribute('aria-pressed') === 'true'
  })()`)
  assert.equal(discarded, true, 'Cancel must discard parent fields, state, color, and child drafts')

  // Add two real children and persist them with Change Save.
  for (const title of ['QA 자료 정리', 'QA 검토 요청']) {
    await runIn(
      mainWindow,
      `window.__daylineQa.setValue('[aria-label="subtask 추가"]', ${JSON.stringify(title)})`,
    )
    await runIn(mainWindow, `document.querySelector('.subtask-add-row button')?.click()`)
    await waitForRenderer(
      mainWindow,
      `[...document.querySelectorAll('.subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === ${JSON.stringify(title)})`,
      `draft child ${title}`,
    )
  }
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  await waitForRenderer(mainWindow, `!document.querySelector('.task-modal')`, 'saved task detail')
  const subTaskState = await waitForRenderer(
    mainWindow,
    `(() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )]
      const ids = rows.map((row) => row.dataset.subtaskId)
      const qaIds = rows
        .filter((row) => ['QA 자료 정리', 'QA 검토 요청'].includes(
          row.querySelector('span')?.textContent?.trim(),
        ))
        .map((row) => row.dataset.subtaskId)
      const qaByTitle = Object.fromEntries(rows
        .map((row) => [row.querySelector('span')?.textContent?.trim(), row.dataset.subtaskId])
        .filter(([title]) => ['QA 자료 정리', 'QA 검토 요청'].includes(title)))
      return ids.length === ${originalDetail.subTaskCount + 2} && qaIds.length === 2
        ? { ids, qaIds, qaByTitle }
        : null
    })()`,
    'two sidebar subtasks after save',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `document.querySelectorAll('.calendar-cell.is-selected .task-chip[data-task-id]').length`,
    ),
    initialCounts.calendar,
    'Subtasks must not add calendar chips',
  )

  // Time is right aligned; missing time and inactive labels are intentionally absent.
  const timeLayout = await runIn(mainWindow, `
    (() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
      )]
      const timed = rows.find((row) => row.querySelector('.task-due-time'))
      const untimed = rows.find((row) => !row.querySelector('.task-due-time'))
      if (!timed || !untimed) return null
      const main = timed.querySelector('.task-row-main').getBoundingClientRect()
      const time = timed.querySelector('.task-due-time').getBoundingClientRect()
      return {
        timedId: timed.dataset.taskId,
        hasPlaceholder: untimed.textContent.includes('시간 없음'),
        hasInactiveLabel: rows.some((row) => row.textContent.includes('비활성')),
        rightAligned: main.right - time.right < 20,
        verticallyCentered: Math.abs((main.top + main.height / 2) - (time.top + time.height / 2)) < 6,
      }
    })()
  `)
  assert.ok(timeLayout, 'Seed data must contain timed and untimed tasks')
  assert.equal(timeLayout.hasPlaceholder, false, 'Untimed rows must have no placeholder')
  assert.equal(timeLayout.hasInactiveLabel, false, 'Rows must not render a redundant inactive label')
  assert.equal(timeLayout.rightAligned, true, 'Due time must be on the row right edge')
  assert.equal(timeLayout.verticallyCentered, true, 'Due time must not render below the title')

  // Individual children toggle without deletion; completing every active child aggregates the parent.
  const activeChildIds = await runIn(mainWindow, `
    [...document.querySelectorAll(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
    )]
      .filter((row) => !row.classList.contains('is-completed'))
      .map((row) => row.dataset.subtaskId)
  `)
  assert.ok(activeChildIds.length >= 2, 'The two newly added subtasks must start active')
  const firstToggleId = subTaskState.qaByTitle['QA 자료 정리']
  assert.ok(firstToggleId, 'The saved QA child must retain its row ID')
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${firstToggleId}"]'))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
      && !document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )?.classList.contains('is-completed')`,
    'first child completion without parent completion',
  )
  for (const childId of activeChildIds.filter((id) => id !== firstToggleId)) {
    await runIn(
      mainWindow,
      `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${childId}"]'))`,
    )
    await waitForRenderer(
      mainWindow,
      `document.querySelector('[data-subtask-id="${childId}"]')?.classList.contains('is-completed')`,
      `child completion ${childId}`,
    )
  }
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')`,
    'parent aggregate completion',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${firstToggleId}"]'))`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-subtask-id="${firstToggleId}"]'))
      && !document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
      && !document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )?.classList.contains('is-completed')`,
    'child right-click reactivation without deletion',
  )

  // Parent completion preserves its exact list index and cascades to every child.
  const orderBeforeParentCompletion = await runIn(mainWindow, `window.__daylineQa.scheduleIds()`)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')
      && [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )].every((row) => row.classList.contains('is-completed'))`,
    'parent completion cascade',
  )
  assert.deepEqual(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds()`),
    orderBeforeParentCompletion,
    'Completing a parent must not move it down the list',
  )

  // Regression: editing one child on an all-complete parent must not make the
  // modal's derived parent state cascade over untouched completed siblings.
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('.task-modal'))
      && [...document.querySelectorAll('.task-modal [aria-label="활성 상태 선택"] button')]
        .find((button) => button.textContent?.includes('비활성'))?.getAttribute('aria-pressed') === 'true'
      && [...document.querySelectorAll('.task-modal .subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === 'QA 자료 정리'
          && row.classList.contains('is-completed'))`,
    'hydrated completed parent detail',
  )
  await runIn(mainWindow, `
    (() => {
      const row = [...document.querySelectorAll('.task-modal .subtask-edit-row')]
        .find((candidate) => candidate.querySelector('input')?.value === 'QA 자료 정리')
      row?.querySelector('.subtask-toggle')?.click()
      return Boolean(row)
    })()
  `)
  await waitForRenderer(
    mainWindow,
    `[...document.querySelectorAll('.task-modal .subtask-edit-row')]
      .some((row) => row.querySelector('input')?.value === 'QA 자료 정리'
        && !row.classList.contains('is-completed'))`,
    'single draft child reactivation',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  try {
    await waitForRenderer(
      mainWindow,
      `!document.querySelector('.task-modal')
        && !document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
        && !document.querySelector(
          '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
        )?.classList.contains('is-completed')
        && [...document.querySelectorAll(
          '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
        )].filter((row) => row.dataset.subtaskId !== '${firstToggleId}')
          .every((row) => row.classList.contains('is-completed'))`,
      'isolated child reactivation after detail save',
    )
  } catch (error) {
    const detailState = await runIn(mainWindow, `(() => {
      const parent = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )
      return {
        modalOpen: Boolean(document.querySelector('.task-modal')),
        parentCompleted: parent?.classList.contains('is-completed'),
        children: [...(parent?.querySelectorAll('[data-subtask-id]') ?? [])].map((row) => ({
          id: row.dataset.subtaskId,
          title: row.querySelector('span')?.textContent?.trim(),
          completed: row.classList.contains('is-completed'),
        })),
      }
    })()`)
    throw new Error(`${error.message} State: ${JSON.stringify(detailState)}`)
  }

  // Restore the completed feature state for the color comparison and screenshot.
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')
      && [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )].every((row) => row.classList.contains('is-completed'))`,
    'recompleted parent after isolated child edit',
  )

  // Complete a second color and verify color-specific pale styling in both sidebar and calendar.
  const orderBeforeTimedCompletion = await runIn(mainWindow, `window.__daylineQa.scheduleIds()`)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'second colored task completion',
  )
  assert.deepEqual(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds()`),
    orderBeforeTimedCompletion,
    'Completing a timed task must not reorder the list',
  )
  const completedColors = await runIn(mainWindow, `
    (() => {
      const first = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )
      const second = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
      )
      const firstChip = document.querySelector(
        '.calendar-cell.is-selected .task-chip[data-task-id="${editableTask.id}"]',
      )
      const secondChip = document.querySelector(
        '.calendar-cell.is-selected .task-chip[data-task-id="${timeLayout.timedId}"]',
      )
      if (!first || !second || !firstChip || !secondChip) return null
      return {
        rowBackgrounds: [getComputedStyle(first).backgroundColor, getComputedStyle(second).backgroundColor],
        chipBackgrounds: [getComputedStyle(firstChip).backgroundColor, getComputedStyle(secondChip).backgroundColor],
        taskColors: [
          getComputedStyle(first).getPropertyValue('--task-color').trim(),
          getComputedStyle(second).getPropertyValue('--task-color').trim(),
        ],
        decorations: [
          getComputedStyle(first.querySelector('.task-title')).textDecorationLine,
          getComputedStyle(second.querySelector('.task-title')).textDecorationLine,
        ],
      }
    })()
  `)
  assert.ok(completedColors, 'Two completed colors must remain visible')
  assert.notEqual(...completedColors.taskColors, 'The completed rows must originate from different task colors')
  assert.notEqual(...completedColors.rowBackgrounds, 'Completed sidebar rows must retain distinct pale colors')
  assert.notEqual(...completedColors.chipBackgrounds, 'Completed calendar chips must retain distinct pale colors')
  assert.ok(
    completedColors.decorations.every((value) => value.includes('line-through')),
    'Completed titles must use a line-through',
  )

  // Existing parent semantics remain active -> inactive -> unconfirmed recent deletion, with undo.
  await sleep(780)
  const rowCountBeforeDelete = orderBeforeTimedCompletion.length
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    ) && !document.querySelector('.delete-confirm-dialog')`,
    'unconfirmed second-right-click deletion',
  )
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds().length`),
    rowCountBeforeDelete - 1,
  )
  await waitForRenderer(
    mainWindow,
    `window.__daylineQa.clickButtonText('.toast', '실행 취소')`,
    'right-click deletion undo button',
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'restored completed task',
  )

  // Detail status remains a draft until Save, and detail deletion remains guarded.
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'restored task detail')
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('[aria-label="활성 상태 선택"]', '활성')`)
  assert.equal(
    await runIn(
      mainWindow,
      `document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
      )?.classList.contains('is-completed')`,
    ),
    true,
    'Detail status must not apply before Save',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal') && !document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'saved detail reactivation',
  )
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-remove-button'))`, 'detail remove button')
  await runIn(mainWindow, `document.querySelector('.task-remove-button')?.click()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.delete-confirm-dialog'))`, 'detail delete warning')
  const alertAccessibility = await runIn(mainWindow, `
    (() => {
      const dialog = document.querySelector('.delete-confirm-dialog')
      const buttons = [...(dialog?.querySelectorAll('button:not([disabled])') ?? [])]
        .filter((button) => button.getClientRects().length > 0)
      if (!dialog || buttons.length < 2) return null
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
      }))
      const wrappedBackward = document.activeElement === last
      last.focus()
      last.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }))
      return {
        taskModalInert: document.querySelector('.task-modal')?.inert === true,
        wrappedBackward,
        wrappedForward: document.activeElement === first,
      }
    })()
  `)
  assert.ok(alertAccessibility, 'Delete alert must expose a keyboard focus loop')
  assert.equal(alertAccessibility.taskModalInert, true, 'Underlying task modal must be inert during delete alert')
  assert.equal(alertAccessibility.wrappedBackward, true, 'Shift+Tab must wrap inside delete alert')
  assert.equal(alertAccessibility.wrappedForward, true, 'Tab must wrap inside delete alert')
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.delete-confirm-dialog', '취소')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.delete-confirm-dialog')
      && Boolean(document.querySelector('.task-modal'))
      && document.querySelector('.task-modal')?.inert === false
      && document.activeElement === document.querySelector('.task-remove-button')`,
    'cancelled detail deletion and remove-trigger focus restoration',
  )
  await runIn(mainWindow, `document.querySelector('.task-remove-button')?.click()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.delete-confirm-button'))`, 'second detail warning')
  await runIn(mainWindow, `document.querySelector('.delete-confirm-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal') && !document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )`,
    'confirmed detail deletion',
  )
  await waitForRenderer(
    mainWindow,
    `window.__daylineQa.clickButtonText('.toast', '실행 취소')`,
    'detail deletion undo button',
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    ))`,
    'detail-deleted task restoration',
  )

  // Reload the isolated renderer to prove browser-store persistence before the feature capture.
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"]')?.classList.contains('is-completed')
      && document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      ).length === ${originalDetail.subTaskCount + 2}`,
    'daily-note and subtask persistence after reload',
  )
  const featureImage = await mainWindow.webContents.capturePage()
  fs.writeFileSync(path.join(outputDir, 'main-window-features.png'), featureImage.toPNG())

  // The app's configured minimum window size must keep both sidebar halves usable.
  mainWindow.setSize(1050, 680)
  await sleep(180)
  const minimumLayout = await runIn(mainWindow, `
    (() => {
      const panel = document.querySelector('.day-panel')?.getBoundingClientRect()
      const body = document.querySelector('.day-panel-body')?.getBoundingClientRect()
      const quick = document.querySelector('[data-qa="quick-note-section"]')?.getBoundingClientRect()
      const schedule = document.querySelector('[data-qa="schedule-section"]')?.getBoundingClientRect()
      const add = document.querySelector('[aria-label="선택한 날짜에 순간 메모 추가"]')
        ?.getBoundingClientRect()
      const noteList = document.querySelector('.daily-note-list')
      const taskList = document.querySelector('[data-qa="schedule-section"] .day-task-list')
      if (!panel || !body || !quick || !schedule || !add || !noteList || !taskList) return null
      return {
        viewport: { width: innerWidth, height: innerHeight },
        usable: quick.height >= 100 && schedule.height >= 100,
        separated: quick.bottom <= schedule.top,
        contained: quick.left >= panel.left && schedule.right <= panel.right
          && schedule.bottom <= body.bottom + 1,
        addVisible: add.left >= panel.left && add.right <= panel.right && add.bottom <= panel.bottom,
        independentScroll: ['auto', 'scroll'].includes(getComputedStyle(noteList).overflowY)
          && ['auto', 'scroll'].includes(getComputedStyle(taskList).overflowY),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
          && document.documentElement.scrollHeight <= innerHeight + 1,
      }
    })()
  `)
  assert.ok(minimumLayout, 'Minimum-size sidebar elements must render')
  assert.equal(minimumLayout.usable, true, 'Both sidebar halves need usable minimum height')
  assert.equal(minimumLayout.separated, true, 'Sidebar halves must not overlap')
  assert.equal(minimumLayout.contained, true, 'Sidebar sections must remain inside the panel')
  assert.equal(minimumLayout.addVisible, true, 'Quick-note add must stay visible at minimum size')
  assert.equal(minimumLayout.independentScroll, true, 'Each sidebar half needs independent scrolling')
  assert.equal(minimumLayout.noPageOverflow, true, 'Minimum-size layout must not overflow the page')
  const minimumImage = await mainWindow.webContents.capturePage()
  fs.writeFileSync(path.join(outputDir, 'main-window-minimum.png'), minimumImage.toPNG())

  // Widget regression: the latest parent detail includes persisted children and state controls.
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.task-row[data-task-id="${editableTask.id}"] .task-row-main'))`,
    'persisted parent in widget',
  )
  await runIn(
    widgetWindow,
    `document.querySelector('.task-row[data-task-id="${editableTask.id}"] .task-row-main')?.click()`,
  )
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.task-modal [aria-label="활성 상태 선택"]'))
      && document.querySelectorAll('.task-modal .subtask-edit-row').length
        === ${originalDetail.subTaskCount + 2}`,
    'widget detail state and subtasks',
  )

  mainWindow.destroy()
  widgetWindow.destroy()
  clearTimeout(qaTimeout)
  app.quit()
}).catch((error) => {
  clearTimeout(qaTimeout)
  console.error(error)
  app.exit(1)
})
