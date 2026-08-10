const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

// This QA process always redirects Electron before main.cjs initializes. It must
// never open the user's real %APPDATA% Dayline database.
const qaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'Dayline DB IPC QA-'))
fs.writeFileSync(
  path.join(qaDirectory, 'dayline-data.json'),
  JSON.stringify({ version: 1, tasks: [], dailyNotes: [] }),
)
process.env.DAYLINE_DATABASE_QA = '1'
process.env.DAYLINE_DATABASE_QA_USER_DATA = qaDirectory

require('../electron/main.cjs')

function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check()
        if (value) return resolve(value)
      } catch {
        // The renderer can reject while its preload or React tree is starting.
      }
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`))
      setTimeout(poll, 30)
    }
    void poll()
  })
}

function runIn(window, expression) {
  return window.webContents.executeJavaScript(expression)
}

function applyIn(window, mutations) {
  return runIn(
    window,
    `window.dayline.applyStoreMutations(${JSON.stringify(mutations)})`,
  )
}

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

const createdAt = '2026-09-09T04:00:00.000Z'

function makeSubTask(id, title = `세부 할 일 ${id}`, overrides = {}) {
  return {
    id,
    title,
    completed: false,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function makeTask(id, title, overrides = {}) {
  return {
    id,
    title,
    note: '',
    dueDate: localDateKey(),
    dueTime: null,
    color: 'blue',
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    createdAt,
    updatedAt: createdAt,
    subTasks: [],
    ...overrides,
  }
}

function makeDailyNote(id, content, overrides = {}) {
  return {
    id,
    content,
    noteDate: localDateKey(),
    completed: false,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

const watchdog = setTimeout(() => {
  console.error(new Error(`Database IPC QA exceeded 45 seconds. Files: ${qaDirectory}`))
  app.exit(1)
}, 45_000)

app.whenReady().then(async () => {
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('mode=main')),
    'main window',
  )
  await waitFor(
    () => runIn(mainWindow, 'Boolean(window.dayline?.applyStoreMutations)'),
    'main preload store API',
  )

  const originalMainUrl = mainWindow.webContents.getURL()
  assert.equal(await runIn(mainWindow, "window.open('https://example.com') === null"), true)
  await runIn(mainWindow, "window.location.assign('https://example.com'); true")
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.equal(mainWindow.webContents.getURL(), originalMainUrl)

  await runIn(mainWindow, 'window.dayline.openWidget()')
  const widgetWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('mode=widget')),
    'widget window',
  )
  await waitFor(
    () => runIn(widgetWindow, 'Boolean(window.dayline?.applyStoreMutations)'),
    'widget preload store API',
  )

  const parentId = crypto.randomUUID()
  const childAId = crypto.randomUUID()
  const childBId = crypto.randomUUID()
  const secondTaskId = crypto.randomUUID()
  const noteId = crypto.randomUUID()
  const parent = makeTask(parentId, '동시성 상위 일정', {
    color: 'coral',
    subTasks: [
      makeSubTask(childAId, '메인 창 세부 할 일'),
      makeSubTask(childBId, '위젯 창 세부 할 일'),
    ],
  })
  const secondTask = makeTask(secondTaskId, '위젯에서 만든 일정', { dueTime: '13:30' })
  const note = makeDailyNote(noteId, '위젯에서 만든 순간 메모')

  await Promise.all([
    applyIn(mainWindow, [{ type: 'task:create', task: parent }]),
    applyIn(widgetWindow, [
      { type: 'task:create', task: secondTask },
      { type: 'daily-note:create', note },
    ]),
  ])

  let store = await runIn(mainWindow, 'window.dayline.loadData()')
  assert.deepEqual(store.tasks.map((task) => task.id).sort(), [parentId, secondTaskId].sort())
  assert.deepEqual(
    store.tasks.find((task) => task.id === parentId).subTasks.map((subTask) => subTask.id),
    [childAId, childBId],
  )
  assert.deepEqual(store.dailyNotes.map((value) => value.id), [noteId])
  await waitFor(
    () => runIn(mainWindow, `document.body.innerText.includes(${JSON.stringify(note.content)})`),
    'daily note broadcast into main UI',
  )

  // Two windows complete different child rows from stale snapshots. The database
  // must merge both rows, then derive parent completion after the whole batch.
  await Promise.all([
    applyIn(mainWindow, [{
      type: 'subtask:patch',
      taskId: parentId,
      id: childAId,
      changes: {
        completed: true,
        completedAt: '2026-09-09T04:01:00.000Z',
        updatedAt: '2026-09-09T04:01:00.000Z',
      },
    }]),
    applyIn(widgetWindow, [{
      type: 'subtask:patch',
      taskId: parentId,
      id: childBId,
      changes: {
        completed: true,
        completedAt: '2026-09-09T04:02:00.000Z',
        updatedAt: '2026-09-09T04:02:00.000Z',
      },
    }]),
  ])
  store = await runIn(mainWindow, 'window.dayline.loadData()')
  let mergedParent = store.tasks.find((task) => task.id === parentId)
  assert.deepEqual(mergedParent.subTasks.map((subTask) => subTask.completed), [true, true])
  assert.equal(mergedParent.completed, true)

  // A parent scalar edit and a child-row reactivation must not overwrite each other.
  await Promise.all([
    applyIn(mainWindow, [{
      type: 'task:patch',
      id: parentId,
      changes: { title: '메인에서 수정한 상위 제목', updatedAt: '2026-09-09T04:03:00.000Z' },
    }]),
    applyIn(widgetWindow, [{
      type: 'subtask:patch',
      taskId: parentId,
      id: childAId,
      changes: { completed: false, completedAt: null, updatedAt: '2026-09-09T04:04:00.000Z' },
    }]),
  ])
  store = await runIn(widgetWindow, 'window.dayline.loadData()')
  mergedParent = store.tasks.find((task) => task.id === parentId)
  assert.equal(mergedParent.title, '메인에서 수정한 상위 제목')
  assert.deepEqual(mergedParent.subTasks.map((subTask) => subTask.completed), [false, true])
  assert.equal(mergedParent.completed, false)

  // Daily-note fields are row-level patches too; concurrent content/status edits merge.
  await Promise.all([
    applyIn(mainWindow, [{
      type: 'daily-note:patch',
      id: noteId,
      changes: { content: '메인에서 수정한 순간 메모', updatedAt: '2026-09-09T04:05:00.000Z' },
    }]),
    applyIn(widgetWindow, [{
      type: 'daily-note:patch',
      id: noteId,
      changes: {
        completed: true,
        completedAt: '2026-09-09T04:06:00.000Z',
        updatedAt: '2026-09-09T04:06:00.000Z',
      },
    }]),
  ])
  const [mainStore, widgetStore] = await Promise.all([
    runIn(mainWindow, 'window.dayline.loadData()'),
    runIn(widgetWindow, 'window.dayline.loadData()'),
  ])
  const mergedNote = mainStore.dailyNotes.find((value) => value.id === noteId)
  assert.equal(mergedNote.content, '메인에서 수정한 순간 메모')
  assert.equal(mergedNote.completed, true)
  assert.deepEqual(mainStore, widgetStore)

  // A single parent mutation must cascade beyond the renderer's historical
  // 100-child batch size without sending a mutation for every child.
  const manyTaskId = crypto.randomUUID()
  const manyTask = makeTask(manyTaskId, '대량 세부 할 일', {
    subTasks: Array.from({ length: 150 }, (_, index) => (
      makeSubTask(crypto.randomUUID(), `대량 세부 ${index + 1}`)
    )),
  })
  await applyIn(mainWindow, [{ type: 'task:create', task: manyTask }])
  store = await applyIn(widgetWindow, [{
    type: 'task:patch',
    id: manyTaskId,
    changes: {
      completed: true,
      completedAt: '2026-09-09T04:07:00.000Z',
      updatedAt: '2026-09-09T04:07:00.000Z',
    },
  }])
  const manyResult = store.tasks.find((task) => task.id === manyTaskId)
  assert.equal(manyResult.subTasks.length, 150)
  assert.equal(manyResult.subTasks.every((subTask) => subTask.completed), true)
  assert.equal(manyResult.completed, true)

  // Deletion wins over an edit from a stale child view and cannot revive the aggregate.
  await applyIn(mainWindow, [{
    type: 'task:patch',
    id: parentId,
    changes: {
      deletedAt: '2026-09-09T04:08:00.000Z',
      previousCompleted: false,
      updatedAt: '2026-09-09T04:08:00.000Z',
    },
  }])
  store = await applyIn(widgetWindow, [{
    type: 'subtask:patch',
    taskId: parentId,
    id: childAId,
    changes: {
      completed: true,
      completedAt: '2026-09-09T04:09:00.000Z',
      updatedAt: '2026-09-09T04:09:00.000Z',
    },
  }])
  mergedParent = store.tasks.find((task) => task.id === parentId)
  assert.equal(mergedParent.deletedAt, '2026-09-09T04:08:00.000Z')
  assert.equal(mergedParent.subTasks.find((subTask) => subTask.id === childAId).completed, false)

  store = await applyIn(mainWindow, [{
    type: 'task:patch',
    id: parentId,
    changes: {
      deletedAt: null,
      previousCompleted: null,
      completed: false,
      completedAt: null,
      updatedAt: '2026-09-09T04:10:00.000Z',
    },
  }])
  mergedParent = store.tasks.find((task) => task.id === parentId)
  assert.equal(mergedParent.deletedAt, null)
  assert.equal(mergedParent.completed, false)
  assert.equal(mergedParent.subTasks.every((subTask) => !subTask.completed), true)

  // A deleted daily note is absent from the canonical store and remains absent after reopen/load.
  const disposableNoteId = crypto.randomUUID()
  await applyIn(mainWindow, [{
    type: 'daily-note:create',
    note: makeDailyNote(disposableNoteId, '삭제할 순간 메모'),
  }])
  store = await applyIn(widgetWindow, [{ type: 'daily-note:delete', id: disposableNoteId }])
  assert.equal(store.dailyNotes.some((value) => value.id === disposableNoteId), false)

  // Broadcasts with lower revisions may arrive late and must not roll either UI back.
  const staleStore = await runIn(mainWindow, 'window.dayline.loadData()')
  const revisionTaskId = crypto.randomUUID()
  const revisionTaskTitle = '최신 저장 순번 일정'
  const revisionNoteId = crypto.randomUUID()
  const revisionNoteContent = '최신 저장 순번 순간 메모'
  const revisionTaskStore = await applyIn(mainWindow, [{
    type: 'task:create',
    task: makeTask(revisionTaskId, revisionTaskTitle),
  }])
  const revisionNoteStore = await applyIn(widgetWindow, [{
    type: 'daily-note:create',
    note: makeDailyNote(revisionNoteId, revisionNoteContent),
  }])
  assert.ok(revisionTaskStore.revision > staleStore.revision)
  assert.ok(revisionNoteStore.revision > revisionTaskStore.revision)
  await waitFor(
    () => runIn(widgetWindow, `document.body.innerText.includes(${JSON.stringify(revisionTaskTitle)})`),
    'latest task in widget UI',
  )
  await waitFor(
    () => runIn(mainWindow, `document.body.innerText.includes(${JSON.stringify(revisionNoteContent)})`),
    'latest daily note in main UI',
  )
  mainWindow.webContents.send('dayline:data-changed', staleStore)
  widgetWindow.webContents.send('dayline:data-changed', staleStore)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(
    await runIn(widgetWindow, `document.body.innerText.includes(${JSON.stringify(revisionTaskTitle)})`),
    true,
  )
  assert.equal(
    await runIn(mainWindow, `document.body.innerText.includes(${JSON.stringify(revisionNoteContent)})`),
    true,
  )

  assert.equal(fs.existsSync(path.join(qaDirectory, 'dayline.db')), true)
  const inspected = new DatabaseSync(path.join(qaDirectory, 'dayline.db'), { readOnly: true })
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(inspected.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), [])
  assert.ok(inspected.prepare(`SELECT COUNT(*) AS count FROM sub_tasks`).get().count >= 152)
  assert.ok(inspected.prepare(`SELECT COUNT(*) AS count FROM daily_notes`).get().count >= 2)
  inspected.close()

  const closeSafeId = crypto.randomUUID()
  const closeSafeMutation = [{
    type: 'task:create',
    task: makeTask(closeSafeId, '닫기 직전 저장'),
  }]
  await runIn(
    mainWindow,
    `window.dayline.applyStoreMutations(${JSON.stringify(closeSafeMutation)}); window.close(); true`,
  ).catch(() => {
    // executeJavaScript may reject because the renderer destroys itself immediately.
  })
  await waitFor(() => mainWindow.isDestroyed(), 'main window close after synchronous write')
  store = await runIn(widgetWindow, 'window.dayline.loadData()')
  assert.equal(store.tasks.some((task) => task.id === closeSafeId), true)

  clearTimeout(watchdog)
  app.quit()
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error)
  console.error(`Database IPC QA files were preserved at: ${qaDirectory}`)
  app.exit(1)
})
