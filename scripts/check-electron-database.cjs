const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createDaylineDatabase } = require('../electron/database.cjs')

const FIXED_NOW = new Date('2026-09-09T04:00:00.000Z')

function makeTask(id, subTasks = []) {
  return {
    id,
    title: `Electron SQLite ${id}`,
    note: '',
    dueDate: '2026-09-09',
    dueTime: null,
    color: 'blue',
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    createdAt: '2026-09-09T01:00:00.000Z',
    updatedAt: '2026-09-09T01:00:00.000Z',
    subTasks,
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
    content: 'Electron 런타임 순간 메모',
    noteDate: '2026-09-09',
    completed: false,
    completedAt: null,
    createdAt: '2026-09-09T01:02:00.000Z',
    updatedAt: '2026-09-09T01:02:00.000Z',
  }
}

function createV1Fixture(databasePath) {
  const sqlite = new DatabaseSync(databasePath)
  sqlite.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
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
    assert.equal(database.readDiagnostics().schemaVersion, 2)

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
          content: 'Electron 런타임에서 수정한 순간 메모',
          completed: true,
          completedAt: '2026-09-09T04:03:00.000Z',
        },
      },
    ])
    assert.equal(store.tasks[0].completed, true)
    assert.equal(store.tasks[0].subTasks.every((value) => value.completed), true)
    assert.equal(store.dailyNotes[0].completed, true)
    assert.equal(store.dailyNotes[0].content, 'Electron 런타임에서 수정한 순간 메모')
    assert.equal(database.readDiagnostics().integrity, 'ok')
    assert.deepEqual(database.readDiagnostics().foreignKeyViolations, [])
    database.close()
    database = null

    const v1Directory = path.join(directory, 'sqlite-v1')
    fs.mkdirSync(v1Directory)
    const v1DatabasePath = path.join(v1Directory, 'dayline.db')
    createV1Fixture(v1DatabasePath)
    database = createDaylineDatabase({
      databasePath: v1DatabasePath,
      legacyJsonPath: path.join(v1Directory, 'missing-legacy.json'),
      now: () => new Date(FIXED_NOW),
    })
    const upgradedStore = database.readStore()
    const upgradedDiagnostics = database.readDiagnostics()
    assert.equal(upgradedDiagnostics.schemaVersion, 2)
    assert.deepEqual(upgradedStore.tasks.map((value) => value.id), ['runtime-v1-task'])
    assert.deepEqual(upgradedStore.tasks[0].subTasks, [])
    assert.deepEqual(upgradedStore.dailyNotes, [])
    database.close()
    database = null

    const inspected = new DatabaseSync(v1DatabasePath, { readOnly: true })
    const tableNames = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => row.name)
    assert.ok(tableNames.includes('sub_tasks'))
    assert.ok(tableNames.includes('daily_notes'))
    assert.equal(
      inspected.prepare(`
        SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id = 'runtime-v1-outbox'
      `).get().count,
      1,
    )
    assert.equal(
      inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2`).get().count,
      1,
    )
    inspected.close()

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
