const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createDaylineDatabase } = require('../electron/database.cjs')

const FIXED_NOW = new Date('2026-09-09T04:00:00.000Z')

function makeTask(id, subTasks = [], overrides = {}) {
  return {
    id,
    title: `Electron SQLite ${id}`,
    note: '',
    startDate: '2026-09-09',
    dueDate: '2026-09-09',
    dueTime: null,
    color: 'blue',
    tagId: 'builtin-blue',
    position: 0,
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    createdAt: '2026-09-09T01:00:00.000Z',
    updatedAt: '2026-09-09T01:00:00.000Z',
    subTasks,
    ...overrides,
  }
}

function makeSubTask(id) {
  return {
    id,
    title: `하위 일정 ${id}`,
    completed: false,
    completedAt: null,
    createdAt: '2026-09-09T01:01:00.000Z',
    updatedAt: '2026-09-09T01:01:00.000Z',
  }
}

function makeDailyNote(id) {
  return {
    id,
    content: 'Electron 런타임 퀵 노트',
    noteDate: '2026-09-09',
    completed: false,
    completedAt: null,
    position: 0,
    createdAt: '2026-09-09T01:02:00.000Z',
    updatedAt: '2026-09-09T01:02:00.000Z',
  }
}

function makeTag(id = 'runtime-custom-tag') {
  return {
    id,
    name: '런타임 사용자 태그',
    color: '#336699',
    builtIn: false,
    legacyColor: null,
    position: 20,
    createdAt: '2026-09-09T01:03:00.000Z',
    updatedAt: '2026-09-09T01:03:00.000Z',
  }
}

function makeTemplate(id = 'runtime-template') {
  return {
    id,
    title: 'Electron 반복 일정',
    note: '템플릿 메모',
    dueTime: '08:45',
    tagId: 'builtin-violet',
    legacyColor: 'violet',
    durationDays: 3,
    subTaskTitles: ['준비', '검토'],
    position: 0,
    createdAt: '2026-09-09T01:04:00.000Z',
    updatedAt: '2026-09-09T01:04:00.000Z',
  }
}

function createV2Fixture(databasePath) {
  const sqlite = new DatabaseSync(databasePath)
  sqlite.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, server_user_id TEXT UNIQUE,
      kind TEXT NOT NULL DEFAULT 'guest', display_name TEXT, email TEXT, avatar_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      remote_id TEXT,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL,
      due_time TEXT,
      color TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      deleted_at TEXT,
      previous_completed INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only',
      last_synced_at TEXT,
      UNIQUE(profile_id, remote_id)
    ) STRICT;
    CREATE TABLE sync_outbox (
      mutation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type = 'task'),
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      base_server_version INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      acknowledged_at TEXT,
      last_error TEXT
    ) STRICT;
    CREATE TABLE sync_cursors (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      server_cursor TEXT, last_synced_at TEXT, last_error TEXT
    ) STRICT;
    CREATE TABLE sub_tasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only'
    ) STRICT;
    CREATE TABLE daily_notes (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      remote_id TEXT,
      content TEXT NOT NULL,
      note_date TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only',
      last_synced_at TEXT,
      UNIQUE(profile_id, remote_id)
    ) STRICT;
    INSERT INTO schema_migrations(version, applied_at) VALUES
      (1, '2026-09-01T00:00:00.000Z'),
      (2, '2026-09-01T00:00:00.000Z');
    INSERT INTO profiles(id, kind, display_name, created_at, updated_at)
      VALUES ('runtime-v1-profile', 'guest', '기존 사용자',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO app_meta(key, value) VALUES
      ('local_profile_id', 'runtime-v1-profile'),
      ('store_revision', '4'),
      ('legacy_json_v1_migration', '{"status":"imported"}');
    INSERT INTO tasks (
      id, profile_id, title, note, due_date, color, completed, created_at, updated_at
    ) VALUES (
      'runtime-v1-task', 'runtime-v1-profile', '기존 Electron DB 일정', '',
      '2026-09-09', 'coral', 0,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      id, profile_id, title, note, due_date, color, completed, created_at, updated_at
    ) VALUES (
      'runtime-v2-task-later', 'runtime-v1-profile', '두 번째 기존 일정', '',
      '2026-09-10', 'amber', 0,
      '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
    );
    INSERT INTO sub_tasks (
      id, task_id, title, completed, position, created_at, updated_at
    ) VALUES (
      'runtime-v2-child', 'runtime-v1-task', '기존 세부 일정', 0, 0,
      '2026-09-01T00:10:00.000Z', '2026-09-01T00:10:00.000Z'
    );
    INSERT INTO daily_notes (
      id, profile_id, content, note_date, completed, created_at, updated_at
    ) VALUES
      ('runtime-v2-note-a', 'runtime-v1-profile', '기존 퀵 노트 A', '2026-09-09', 0,
        '2026-09-01T00:20:00.000Z', '2026-09-01T00:20:00.000Z'),
      ('runtime-v2-note-b', 'runtime-v1-profile', '기존 퀵 노트 B', '2026-09-09', 0,
        '2026-09-01T00:21:00.000Z', '2026-09-01T00:21:00.000Z');
    INSERT INTO sync_outbox (
      mutation_id, profile_id, entity_type, entity_id, operation, created_at
    ) VALUES (
      'runtime-v1-outbox', 'runtime-v1-profile', 'task', 'runtime-v1-task', 'upsert',
      '2026-09-01T00:00:00.000Z'
    );
  `)
  sqlite.close()
}

app.whenReady().then(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Dayline Electron DB QA-'))
  let database

  try {
    const legacyDirectory = path.join(directory, 'legacy-json')
    fs.mkdirSync(legacyDirectory)
    const databasePath = path.join(legacyDirectory, 'dayline.db')
    const legacyJsonPath = path.join(legacyDirectory, 'dayline-data.json')
    const task = makeTask('electron-runtime-task', [
      makeSubTask('electron-sub-a'),
      makeSubTask('electron-sub-b'),
    ])
    const note = makeDailyNote('electron-note')
    fs.writeFileSync(legacyJsonPath, JSON.stringify({
      version: 1,
      tasks: [task],
      dailyNotes: [note],
      taskTags: [makeTag()],
      settings: {
        sidebarSplit: 44,
        widgetSplit: 56,
        fontScale: 1.1,
        themeColor: '#224466',
      },
      taskTemplates: [makeTemplate()],
    }))

    database = createDaylineDatabase({
      databasePath,
      legacyJsonPath,
      now: () => new Date(FIXED_NOW),
    })
    let store = database.readStore()
    assert.equal(store.tasks.length, 1)
    assert.deepEqual(store.tasks[0].subTasks.map((value) => value.id), [
      'electron-sub-a',
      'electron-sub-b',
    ])
    assert.deepEqual(store.dailyNotes.map((value) => value.id), ['electron-note'])
    assert.equal(store.taskTags.some((value) => value.id === 'runtime-custom-tag'), true)
    assert.deepEqual(store.taskTemplates.map((value) => value.id), ['runtime-template'])
    assert.equal(store.settings.fontScale, 1.1)
    assert.equal(database.readDiagnostics().schemaVersion, 5)

    store = database.applyStoreMutations([
      {
        type: 'subtask:patch',
        taskId: task.id,
        id: 'electron-sub-a',
        changes: { completed: true, completedAt: '2026-09-09T04:01:00.000Z' },
      },
      {
        type: 'subtask:patch',
        taskId: task.id,
        id: 'electron-sub-b',
        changes: { completed: true, completedAt: '2026-09-09T04:02:00.000Z' },
      },
      {
        type: 'daily-note:patch',
        id: note.id,
        changes: {
          content: 'Electron 런타임에서 수정한 퀵 노트',
          completed: true,
          completedAt: '2026-09-09T04:03:00.000Z',
          position: 4,
        },
      },
      {
        type: 'task:patch',
        id: task.id,
        changes: {
          startDate: '2026-09-07',
          dueDate: '2026-09-09',
          position: 5,
          tagId: 'runtime-custom-tag',
          updatedAt: '2026-09-09T04:04:00.000Z',
        },
      },
      {
        type: 'tag:patch',
        id: 'runtime-custom-tag',
        changes: {
          name: '런타임 태그 수정',
          color: '#445566',
          updatedAt: '2026-09-09T04:05:00.000Z',
        },
      },
      {
        type: 'settings:patch',
        changes: {
          sidebarSplit: 62,
          widgetSplit: 38,
          fontScale: 1.5,
          themeColor: '#112233',
          calendarWeekScroll: true,
        },
      },
      {
        type: 'template:patch',
        id: 'runtime-template',
        changes: {
          title: 'Electron 반복 일정 수정',
          tagId: 'runtime-custom-tag',
          subTaskTitles: ['준비 수정', '검토 유지'],
          updatedAt: '2026-09-09T04:06:00.000Z',
        },
      },
    ])
    assert.equal(store.tasks[0].completed, true)
    assert.equal(store.tasks[0].subTasks.every((value) => value.completed), true)
    assert.equal(store.dailyNotes[0].completed, true)
    assert.equal(store.dailyNotes[0].content, 'Electron 런타임에서 수정한 퀵 노트')
    assert.equal(store.dailyNotes[0].position, 4)
    assert.equal(store.tasks[0].startDate, '2026-09-07')
    assert.equal(store.tasks[0].dueDate, '2026-09-09')
    assert.equal(store.tasks[0].position, 5)
    assert.equal(store.tasks[0].tagId, 'runtime-custom-tag')
    assert.equal(store.taskTags.find((value) => value.id === 'runtime-custom-tag').name, '런타임 태그 수정')
    assert.deepEqual(store.settings, {
      sidebarSplit: 62,
      widgetSplit: 38,
      fontScale: 1.5,
      themeColor: '#112233',
      calendarWeekScroll: true,
    })
    assert.deepEqual(store.taskTemplates[0].subTaskTitles, ['준비 수정', '검토 유지'])
    assert.equal(database.readDiagnostics().integrity, 'ok')
    assert.deepEqual(database.readDiagnostics().foreignKeyViolations, [])
    database.close()
    database = null

    database = createDaylineDatabase({
      databasePath,
      legacyJsonPath,
      now: () => new Date(FIXED_NOW),
    })
    store = database.readStore()
    assert.equal(store.tasks[0].startDate, '2026-09-07')
    assert.equal(store.tasks[0].tagId, 'runtime-custom-tag')
    assert.equal(store.settings.fontScale, 1.5)
    assert.equal(store.settings.calendarWeekScroll, true)
    assert.equal(store.taskTemplates[0].title, 'Electron 반복 일정 수정')
    store = database.applyStoreMutations([
      { type: 'tag:delete', id: 'builtin-blue' },
      { type: 'tag:delete', id: 'runtime-custom-tag' },
    ])
    assert.equal(store.taskTags.some((value) => value.id === 'builtin-blue'), true)
    assert.equal(store.taskTags.some((value) => value.id === 'runtime-custom-tag'), false)
    assert.equal(store.tasks[0].tagId, null)
    assert.equal(store.taskTemplates[0].tagId, null)
    database.close()
    database = null

    const v1Directory = path.join(directory, 'sqlite-v2')
    fs.mkdirSync(v1Directory)
    const v1DatabasePath = path.join(v1Directory, 'dayline.db')
    createV2Fixture(v1DatabasePath)
    database = createDaylineDatabase({
      databasePath: v1DatabasePath,
      legacyJsonPath: path.join(v1Directory, 'missing-legacy.json'),
      now: () => new Date(FIXED_NOW),
    })
    const upgradedStore = database.readStore()
    const upgradedDiagnostics = database.readDiagnostics()
    assert.equal(upgradedDiagnostics.schemaVersion, 5)
    assert.deepEqual(upgradedStore.tasks.map((value) => value.id), [
      'runtime-v1-task',
      'runtime-v2-task-later',
    ])
    assert.deepEqual(upgradedStore.tasks.map((value) => value.position), [0, 1])
    assert.deepEqual(upgradedStore.tasks.map((value) => value.startDate), [
      '2026-09-09',
      '2026-09-10',
    ])
    assert.deepEqual(upgradedStore.tasks.map((value) => value.tagId), [
      'builtin-coral',
      'builtin-amber',
    ])
    assert.deepEqual(upgradedStore.tasks[0].subTasks.map((value) => value.id), ['runtime-v2-child'])
    assert.deepEqual(upgradedStore.dailyNotes.map((value) => value.id), [
      'runtime-v2-note-a',
      'runtime-v2-note-b',
    ])
    assert.deepEqual(upgradedStore.dailyNotes.map((value) => value.position), [0, 1])
    assert.equal(upgradedStore.taskTags.length, 9)
    assert.deepEqual(upgradedStore.settings, {
      sidebarSplit: 50,
      widgetSplit: 50,
      fontScale: 1,
      themeColor: '#255F4B',
      calendarWeekScroll: false,
    })
    assert.deepEqual(upgradedStore.taskTemplates, [])
    database.close()
    database = null

    const inspected = new DatabaseSync(v1DatabasePath, { readOnly: true })
    const tableNames = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => row.name)
    assert.ok(tableNames.includes('sub_tasks'))
    assert.ok(tableNames.includes('daily_notes'))
    assert.ok(tableNames.includes('task_tags'))
    assert.ok(tableNames.includes('task_templates'))
    assert.ok(tableNames.includes('app_settings'))
    assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 5)
    assert.equal(inspected.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), [])
    const indexNames = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).all().map((row) => row.name)
    for (const indexName of [
      'idx_tasks_range',
      'idx_tasks_position',
      'idx_daily_notes_position',
      'idx_task_tags_position',
      'idx_task_templates_position',
    ]) assert.ok(indexNames.includes(indexName), `Missing v3 index ${indexName}`)
    const outboxSql = inspected.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'
    `).get().sql
    for (const entity of ['task_tag', 'task_template', 'app_settings']) {
      assert.ok(outboxSql.includes(entity), `Outbox must accept ${entity}`)
    }
    assert.equal(
      inspected.prepare(`
        SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id = 'runtime-v1-outbox'
      `).get().count,
      1,
    )
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3`).get().count,
      1,
    )
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 4`).get().count,
      1,
    )
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5`).get().count,
      1,
    )
    inspected.close()

    database = createDaylineDatabase({
      databasePath: v1DatabasePath,
      legacyJsonPath: path.join(v1Directory, 'missing-legacy.json'),
      now: () => new Date(FIXED_NOW),
    })
    assert.equal(database.readDiagnostics().schemaVersion, 5)
    assert.equal(database.readStore().taskTags.length, 9)
    assert.deepEqual(database.readStore().tasks.map((value) => value.position), [0, 1])
    database.close()
    database = null

    app.exit(0)
  } catch (error) {
    database?.close()
    console.error(error)
    console.error(`Database QA files were preserved at: ${directory}`)
    app.exit(1)
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
