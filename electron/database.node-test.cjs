// Runs with Node's built-in test runner, not Vitest.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { RETENTION_MS, createDaylineDatabase } = require('./database.cjs')

const FIXED_NOW = new Date('2026-09-09T04:00:00.000Z')

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: '한글 일정',
    note: '메모 내용',
    startDate: '2026-09-09',
    dueDate: '2026-09-09',
    dueTime: null,
    color: 'coral',
    tagId: 'builtin-coral',
    position: 0,
    completed: false,
    completedAt: null,
    position: 0,
    deletedAt: null,
    previousCompleted: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    subTasks: [],
    ...overrides,
  }
}

function makeSubTask(id, overrides = {}) {
  return {
    id,
    title: `하위 일정 ${id}`,
    completed: false,
    completedAt: null,
    createdAt: '2026-09-01T00:01:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    ...overrides,
  }
}

function makeDailyNote(overrides = {}) {
  return {
    id: 'note-1',
    content: '바로 적은 메모',
    noteDate: '2026-09-09',
    completed: false,
    completedAt: null,
    createdAt: '2026-09-09T01:00:00.000Z',
    updatedAt: '2026-09-09T01:00:00.000Z',
    ...overrides,
  }
}

function tempPaths(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Dayline DB 테스트-'))
  t.diagnostic(`temporary database: ${directory}`)
  return {
    directory,
    databasePath: path.join(directory, 'dayline.db'),
    legacyJsonPath: path.join(directory, 'dayline-data.json'),
  }
}

test('migrates legacy JSON once, preserves its backup, and enforces the recovery boundary', (t) => {
  const paths = tempPaths(t)
  const boundaryDeletedAt = new Date(FIXED_NOW.getTime() - RETENTION_MS).toISOString()
  const expiredDeletedAt = new Date(FIXED_NOW.getTime() - RETENTION_MS - 1).toISOString()
  const legacyStore = {
    version: 1,
    tasks: [
      makeTask(),
      makeTask({ id: 'task-boundary', title: '정확히 30일', deletedAt: boundaryDeletedAt }),
      makeTask({ id: 'task-expired', title: '30일 초과', deletedAt: expiredDeletedAt }),
    ],
  }
  const original = Buffer.from(JSON.stringify(legacyStore, null, 2), 'utf8')
  fs.writeFileSync(paths.legacyJsonPath, original)

  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const firstStore = database.readStore()
  const diagnostics = database.readDiagnostics()
  database.close()

  assert.deepEqual(firstStore.tasks.map((task) => task.id).sort(), ['task-1', 'task-boundary'].sort())
  assert.ok(Number.isSafeInteger(firstStore.revision))
  assert.ok(firstStore.revision > 0)
  assert.equal(firstStore.migrationWarning, null)
  const migratedTask = firstStore.tasks.find((task) => task.id === 'task-1')
  assert.equal(migratedTask.title, '한글 일정')
  assert.equal(migratedTask.dueTime, null)
  assert.equal(diagnostics.integrity, 'ok')
  assert.deepEqual(diagnostics.foreignKeyViolations, [])
  assert.equal(diagnostics.migration.status, 'imported')
  assert.equal(diagnostics.migration.importedCount, 2)
  assert.deepEqual(fs.readFileSync(`${paths.legacyJsonPath}.pre-sqlite-backup`), original)
  assert.deepEqual(fs.readFileSync(paths.legacyJsonPath), original)

  fs.writeFileSync(
    paths.legacyJsonPath,
    JSON.stringify({ ...legacyStore, tasks: [...legacyStore.tasks, makeTask({ id: 'late-json-task' })] }),
  )
  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const reopenedStore = reopened.readStore()
  assert.deepEqual(
    reopenedStore.tasks.map((task) => task.id).sort(),
    ['task-1', 'task-boundary'].sort(),
  )
  assert.equal(reopenedStore.revision, firstStore.revision)
  assert.equal(reopenedStore.migrationWarning, null)
  reopened.close()
})

test('keeps corrupt legacy JSON retryable without replacing it with demo tasks', (t) => {
  const paths = tempPaths(t)
  const corruptJson = Buffer.from('{"version":1,"tasks":[', 'utf8')
  fs.writeFileSync(paths.legacyJsonPath, corruptJson)

  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const failedStore = database.readStore()
  assert.deepEqual(failedStore.tasks, [])
  assert.deepEqual(failedStore.migrationWarning, {
    reason: 'invalid-json',
    backupPath: `${paths.legacyJsonPath}.migration-failed-backup`,
  })
  assert.ok(failedStore.revision > 0)
  let diagnostics = database.readDiagnostics()
  assert.equal(diagnostics.migration, null)
  assert.equal(diagnostics.migrationError.status, 'failed')
  assert.equal(diagnostics.migrationError.reason, 'invalid-json')
  assert.deepEqual(fs.readFileSync(paths.legacyJsonPath), corruptJson)
  assert.deepEqual(fs.readFileSync(diagnostics.migrationError.backupPath), corruptJson)

  database.applyMutations([
    { type: 'create', task: makeTask({ id: 'local-after-failure', title: '로컬에서 추가' }) },
  ])
  database.close()

  const stillCorrupt = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const stillCorruptStore = stillCorrupt.readStore()
  assert.deepEqual(stillCorruptStore.tasks.map((task) => task.id), ['local-after-failure'])
  assert.deepEqual(stillCorruptStore.migrationWarning, failedStore.migrationWarning)
  assert.equal(stillCorrupt.readDiagnostics().migration, null)
  stillCorrupt.close()

  fs.unlinkSync(paths.legacyJsonPath)
  const sourceRemoved = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const sourceRemovedStore = sourceRemoved.readStore()
  assert.deepEqual(sourceRemovedStore.tasks.map((task) => task.id), ['local-after-failure'])
  assert.deepEqual(sourceRemovedStore.dailyNotes, [])
  assert.deepEqual(sourceRemovedStore.migrationWarning, failedStore.migrationWarning)
  assert.equal(sourceRemoved.readDiagnostics().migration, null)
  sourceRemoved.close()

  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [makeTask({ id: 'recovered-legacy-task', title: '복구된 JSON 일정' })],
  }))
  const recovered = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const recoveredStore = recovered.readStore()
  assert.deepEqual(
    recoveredStore.tasks.map((task) => task.id).sort(),
    ['local-after-failure', 'recovered-legacy-task'].sort(),
  )
  assert.equal(recoveredStore.migrationWarning, null)
  assert.ok(recoveredStore.revision > stillCorruptStore.revision)
  diagnostics = recovered.readDiagnostics()
  assert.equal(diagnostics.migration.status, 'imported')
  assert.equal(diagnostics.migration.importedCount, 1)
  assert.equal(diagnostics.migrationError, null)
  recovered.close()

  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [makeTask({ id: 'must-not-import-after-success' })],
  }))
  const completed = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.deepEqual(
    completed.readStore().tasks.map((task) => task.id).sort(),
    ['local-after-failure', 'recovered-legacy-task'].sort(),
  )
  completed.close()
})

test('records a transient legacy read failure and imports on the next successful launch', (t) => {
  const paths = tempPaths(t)
  const legacyJson = Buffer.from(JSON.stringify({
    version: 1,
    tasks: [makeTask({ id: 'task-after-read-retry' })],
  }), 'utf8')
  fs.writeFileSync(paths.legacyJsonPath, legacyJson)

  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = function readFileSyncWithTransientFailure(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(paths.legacyJsonPath)) {
      const error = new Error('simulated transient read failure')
      error.code = 'EACCES'
      throw error
    }
    return originalReadFileSync.call(this, filePath, ...args)
  }

  let database
  try {
    database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  } finally {
    fs.readFileSync = originalReadFileSync
  }

  assert.deepEqual(database.readStore().tasks, [])
  const failedDiagnostics = database.readDiagnostics()
  assert.equal(failedDiagnostics.migration, null)
  assert.equal(failedDiagnostics.migrationError.reason, 'read-error')
  assert.equal(failedDiagnostics.migrationError.errorCode, 'EACCES')
  assert.deepEqual(fs.readFileSync(paths.legacyJsonPath), legacyJson)
  assert.deepEqual(fs.readFileSync(failedDiagnostics.migrationError.backupPath), legacyJson)
  database.close()

  const retried = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.deepEqual(retried.readStore().tasks.map((task) => task.id), ['task-after-read-retry'])
  assert.equal(retried.readDiagnostics().migration.status, 'imported')
  assert.equal(retried.readDiagnostics().migrationError, null)
  retried.close()
})

test('applies field-level mutations without losing unrelated changes or reviving a deleted task', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [makeTask()] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision

  const firstMutationStore = database.applyMutations([
    {
      type: 'patch',
      id: 'task-1',
      changes: { title: '제목 수정', updatedAt: '2026-09-09T04:01:00.000Z' },
    },
  ])
  assert.equal(firstMutationStore.revision, initialRevision + 1)
  let store = database.applyMutations([
    {
      type: 'patch',
      id: 'task-1',
      changes: {
        completed: true,
        completedAt: '2026-09-09T04:02:00.000Z',
        updatedAt: '2026-09-09T04:02:00.000Z',
      },
    },
  ])
  assert.equal(store.tasks[0].title, '제목 수정')
  assert.equal(store.tasks[0].completed, true)

  store = database.applyMutations([
    {
      type: 'patch',
      id: 'task-1',
      changes: {
        deletedAt: '2026-09-09T04:03:00.000Z',
        previousCompleted: true,
        updatedAt: '2026-09-09T04:03:00.000Z',
      },
    },
  ])
  assert.equal(store.tasks[0].deletedAt, '2026-09-09T04:03:00.000Z')

  store = database.applyMutations([
    {
      type: 'patch',
      id: 'task-1',
      changes: { title: '삭제를 되살리는 오래된 편집', updatedAt: '2026-09-09T04:04:00.000Z' },
    },
  ])
  assert.equal(store.tasks[0].title, '제목 수정')
  assert.equal(store.tasks[0].deletedAt, '2026-09-09T04:03:00.000Z')

  store = database.applyMutations([
    {
      type: 'patch',
      id: 'task-1',
      changes: {
        deletedAt: null,
        previousCompleted: null,
        completed: true,
        updatedAt: '2026-09-09T04:05:00.000Z',
      },
    },
  ])
  assert.equal(store.tasks[0].deletedAt, null)
  assert.equal(store.tasks[0].completed, true)

  const revisionBeforeNoOp = store.revision
  store = database.applyMutations([])
  assert.equal(store.revision, revisionBeforeNoOp + 1)
  database.close()
})

test('rejects a stale date patch that would invert the canonical range and rolls back its batch', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [
      makeTask({
        id: 'range-target',
        startDate: '2026-08-10',
        dueDate: '2026-08-20',
        position: 0,
      }),
      makeTask({ id: 'batch-peer', title: '원래 제목', position: 1 }),
    ],
  }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })

  const latest = database.applyStoreMutations([{
    type: 'task:patch',
    id: 'range-target',
    changes: { dueDate: '2026-08-12', updatedAt: '2026-09-09T04:01:00.000Z' },
  }])
  assert.equal(latest.tasks.find((task) => task.id === 'range-target').dueDate, '2026-08-12')
  const revisionBeforeRejectedBatch = latest.revision

  assert.throws(
    () => database.applyStoreMutations([
      {
        type: 'task:patch',
        id: 'batch-peer',
        changes: { title: '롤백되어야 할 제목', updatedAt: '2026-09-09T04:02:00.000Z' },
      },
      {
        type: 'task:patch',
        id: 'range-target',
        changes: { startDate: '2026-08-15', updatedAt: '2026-09-09T04:02:00.000Z' },
      },
    ]),
    (error) => error?.code === 'DAYLINE_INVALID_TASK_RANGE',
  )

  const canonical = database.readStore()
  const rangeTask = canonical.tasks.find((task) => task.id === 'range-target')
  assert.equal(canonical.revision, revisionBeforeRejectedBatch)
  assert.equal(rangeTask.startDate, '2026-08-10')
  assert.equal(rangeTask.dueDate, '2026-08-12')
  assert.equal(canonical.tasks.find((task) => task.id === 'batch-peer').title, '원래 제목')
  database.close()
})

test('increments the persistent revision when a read purges expired recovery data', (t) => {
  const paths = tempPaths(t)
  let clock = new Date(FIXED_NOW)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [makeTask({
      id: 'purge-later',
      deletedAt: new Date(FIXED_NOW.getTime() - RETENTION_MS + 1).toISOString(),
    })],
  }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(clock) })
  const beforePurge = database.readStore()
  assert.deepEqual(beforePurge.tasks.map((task) => task.id), ['purge-later'])

  clock = new Date(FIXED_NOW.getTime() + 2)
  const afterPurge = database.readStore()
  assert.deepEqual(afterPurge.tasks, [])
  assert.equal(afterPurge.revision, beforePurge.revision + 1)
  database.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(clock) })
  assert.equal(reopened.readStore().revision, afterPurge.revision)
  reopened.close()
})

test('creates account-link and sync schema without storing OAuth tokens', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  database.close()

  const sqlite = new DatabaseSync(paths.databasePath, { readOnly: true })
  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all().map((row) => row.name)
  const identityColumns = sqlite.prepare(`PRAGMA table_info(auth_identities)`).all().map((row) => row.name)
  assert.ok(tables.includes('profiles'))
  assert.ok(tables.includes('auth_identities'))
  assert.ok(tables.includes('devices'))
  assert.ok(tables.includes('sync_outbox'))
  assert.ok(tables.includes('sync_cursors'))
  assert.ok(tables.includes('sub_tasks'))
  assert.ok(tables.includes('daily_notes'))
  assert.ok(identityColumns.includes('provider_subject'))
  assert.ok(identityColumns.includes('credential_ref'))
  assert.equal(identityColumns.some((column) => /access_token|refresh_token/i.test(column)), false)
  sqlite.close()
})

test('seeds subtask and selected-day note examples only for a truly fresh database', (t) => {
  const paths = tempPaths(t)
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const store = database.readStore()
  assert.ok(store.tasks.some((task) => task.subTasks.length >= 2))
  assert.ok(store.dailyNotes.some((note) => note.noteDate === '2026-09-09'))
  const seededTaskIds = store.tasks.map((task) => task.id)
  const seededNoteIds = store.dailyNotes.map((note) => note.id)
  database.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.deepEqual(reopened.readStore().tasks.map((task) => task.id), seededTaskIds)
  assert.deepEqual(reopened.readStore().dailyNotes.map((note) => note.id), seededNoteIds)
  reopened.close()
})

test('imports legacy nested subtasks and notes without adding fresh-install demos', (t) => {
  const paths = tempPaths(t)
  const task = makeTask({ subTasks: [makeSubTask('legacy-sub-1'), makeSubTask('legacy-sub-2')] })
  const note = makeDailyNote({ id: 'legacy-note' })
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [task],
    dailyNotes: [note],
  }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const store = database.readStore()
  assert.deepEqual(store.tasks.map((value) => value.id), ['task-1'])
  assert.deepEqual(store.tasks[0].subTasks.map((value) => value.id), ['legacy-sub-1', 'legacy-sub-2'])
  assert.deepEqual(store.dailyNotes.map((value) => value.id), ['legacy-note'])
  assert.equal(database.readDiagnostics().migration.importedCount, 1)
  assert.equal(database.readDiagnostics().migration.importedDailyNoteCount, 1)
  database.close()
})

test('upgrades an existing v1 SQLite database without duplicates or demo data', (t) => {
  const paths = tempPaths(t)
  const sqlite = new DatabaseSync(paths.databasePath)
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
      VALUES ('profile-v1', 'guest', '기존 사용자', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO app_meta(key, value) VALUES
      ('local_profile_id', 'profile-v1'),
      ('store_revision', '7'),
      ('legacy_json_v1_migration', '{"status":"imported"}');
    INSERT INTO tasks (
      id, profile_id, title, note, due_date, color, completed, created_at, updated_at
    ) VALUES (
      'v1-task', 'profile-v1', '기존 DB 일정', '', '2026-09-09', 'coral', 0,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO sync_outbox (
      mutation_id, profile_id, entity_type, entity_id, operation, created_at
    ) VALUES (
      'v1-outbox', 'profile-v1', 'task', 'v1-task', 'upsert', '2026-09-01T00:00:00.000Z'
    );
  `)
  sqlite.close()

  const upgraded = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  let store = upgraded.readStore()
  assert.equal(upgraded.readDiagnostics().schemaVersion, 4)
  assert.deepEqual(store.tasks.map((task) => task.id), ['v1-task'])
  assert.deepEqual(store.tasks[0].subTasks, [])
  assert.equal(store.tasks[0].startDate, store.tasks[0].dueDate)
  assert.equal(store.tasks[0].tagId, 'builtin-coral')
  assert.deepEqual(store.dailyNotes, [])
  upgraded.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  store = reopened.readStore()
  assert.deepEqual(store.tasks.map((task) => task.id), ['v1-task'])
  assert.deepEqual(store.dailyNotes, [])
  reopened.close()

  const inspected = new DatabaseSync(paths.databasePath, { readOnly: true })
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id = 'v1-outbox'`).get().count, 1)
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2`).get().count, 1)
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3`).get().count, 1)
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 4`).get().count, 1)
  inspected.close()
})

test('upgrades a v2 database to v4 without demos and assigns deterministic ranges, tags, and positions', (t) => {
  const paths = tempPaths(t)
  const sqlite = new DatabaseSync(paths.databasePath)
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 2;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, server_user_id TEXT UNIQUE,
      kind TEXT NOT NULL DEFAULT 'guest', display_name TEXT, email TEXT, avatar_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), remote_id TEXT,
      title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL, due_time TEXT,
      color TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
      deleted_at TEXT, previous_completed INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1, server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only', last_synced_at TEXT,
      UNIQUE(profile_id, remote_id)
    ) STRICT;
    CREATE TABLE sub_tasks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1, server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only'
    ) STRICT;
    CREATE TABLE daily_notes (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      remote_id TEXT, content TEXT NOT NULL, note_date TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1, server_version INTEGER,
      sync_state TEXT NOT NULL DEFAULT 'local_only', last_synced_at TEXT,
      UNIQUE(profile_id, remote_id)
    ) STRICT;
    CREATE TABLE sync_outbox (
      mutation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'daily_note')),
      entity_id TEXT NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      base_server_version INTEGER, payload_json TEXT, created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
      acknowledged_at TEXT, last_error TEXT
    ) STRICT;
    INSERT INTO profiles(id, kind, display_name, created_at, updated_at)
      VALUES ('profile-v2', 'guest', '기존 v2 사용자', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO app_meta(key, value) VALUES
      ('local_profile_id', 'profile-v2'),
      ('store_revision', '11'),
      ('legacy_json_v1_migration', '{"status":"imported"}');
    INSERT INTO tasks(id, profile_id, title, note, due_date, color, created_at, updated_at) VALUES
      ('v2-later', 'profile-v2', '두 번째', '', '2026-09-12', 'blue', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
      ('v2-first', 'profile-v2', '첫 번째', '', '2026-09-10', 'coral', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO daily_notes(id, profile_id, content, note_date, created_at, updated_at) VALUES
      ('note-b', 'profile-v2', '둘째', '2026-09-09', '2026-09-09T02:00:00.000Z', '2026-09-09T02:00:00.000Z'),
      ('note-a', 'profile-v2', '첫째', '2026-09-09', '2026-09-09T01:00:00.000Z', '2026-09-09T01:00:00.000Z'),
      ('note-other', 'profile-v2', '다른 날', '2026-09-10', '2026-09-09T03:00:00.000Z', '2026-09-09T03:00:00.000Z');
  `)
  sqlite.close()

  const upgraded = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const store = upgraded.readStore()
  assert.equal(upgraded.readDiagnostics().schemaVersion, 4)
  assert.deepEqual(store.tasks.map(({ id, position }) => ({ id, position })), [
    { id: 'v2-first', position: 0 },
    { id: 'v2-later', position: 1 },
  ])
  assert.deepEqual(store.tasks.map(({ startDate, dueDate }) => ({ startDate, dueDate })), [
    { startDate: '2026-09-10', dueDate: '2026-09-10' },
    { startDate: '2026-09-12', dueDate: '2026-09-12' },
  ])
  assert.deepEqual(store.tasks.map((task) => task.tagId), ['builtin-coral', 'builtin-blue'])
  assert.deepEqual(
    store.dailyNotes.filter((note) => note.noteDate === '2026-09-09').map(({ id, position }) => ({ id, position })),
    [{ id: 'note-a', position: 0 }, { id: 'note-b', position: 1 }],
  )
  assert.equal(store.dailyNotes.find((note) => note.id === 'note-other').position, 0)
  assert.equal(store.taskTags.length, 9)
  assert.deepEqual(store.settings, {
    sidebarSplit: 50,
    widgetSplit: 50,
    fontScale: 1,
    themeColor: '#255F4B',
  })
  assert.deepEqual(store.taskTemplates, [])
  const firstRevision = store.revision
  upgraded.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const reopenedStore = reopened.readStore()
  assert.deepEqual(reopenedStore.tasks.map((task) => task.id), ['v2-first', 'v2-later'])
  assert.deepEqual(reopenedStore.taskTemplates, [])
  assert.equal(reopenedStore.revision, firstRevision)
  reopened.close()
})

test('merges stale child-row mutations and derives parent completion after the whole batch', (t) => {
  const paths = tempPaths(t)
  const task = makeTask({ subTasks: [makeSubTask('sub-a'), makeSubTask('sub-b')] })
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [task] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })

  database.applyStoreMutations([{
    type: 'subtask:patch',
    taskId: task.id,
    id: 'sub-a',
    changes: { completed: true, completedAt: '2026-09-09T04:01:00.000Z' },
  }])
  let store = database.applyStoreMutations([{
    type: 'subtask:patch',
    taskId: task.id,
    id: 'sub-b',
    changes: { completed: true, completedAt: '2026-09-09T04:02:00.000Z' },
  }])
  assert.deepEqual(store.tasks[0].subTasks.map((value) => value.completed), [true, true])
  assert.equal(store.tasks[0].completed, true)

  store = database.applyStoreMutations([{
    type: 'subtask:patch',
    taskId: task.id,
    id: 'sub-a',
    changes: { completed: false, completedAt: null },
  }])
  assert.deepEqual(store.tasks[0].subTasks.map((value) => value.completed), [false, true])
  assert.equal(store.tasks[0].completed, false)
  database.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  store = reopened.readStore()
  assert.deepEqual(store.tasks[0].subTasks.map((value) => value.completed), [false, true])
  assert.equal(store.tasks[0].completed, false)
  reopened.close()
})

test('parent completion scales without per-child IPC mutations', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const task = makeTask({
    id: 'many-children',
    subTasks: Array.from({ length: 150 }, (_, index) => makeSubTask(`many-${index}`)),
  })
  database.applyStoreMutations([{ type: 'task:create', task }])
  const store = database.applyStoreMutations([{
    type: 'task:patch',
    id: task.id,
    changes: { completed: true, completedAt: '2026-09-09T04:10:00.000Z' },
  }])
  assert.equal(store.tasks[0].subTasks.length, 150)
  assert.equal(store.tasks[0].subTasks.every((subTask) => subTask.completed), true)
  assert.equal(store.tasks[0].completed, true)
  database.close()
})

test('deleted parents reject stale child writes and restore with a coherent aggregate', (t) => {
  const paths = tempPaths(t)
  const task = makeTask({
    completed: true,
    completedAt: '2026-09-09T03:00:00.000Z',
    subTasks: [
      makeSubTask('sub-a', { completed: true, completedAt: '2026-09-09T03:00:00.000Z' }),
      makeSubTask('sub-b', { completed: true, completedAt: '2026-09-09T03:00:00.000Z' }),
    ],
  })
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [task] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  database.applyStoreMutations([{
    type: 'task:patch',
    id: task.id,
    changes: { deletedAt: '2026-09-09T04:01:00.000Z', previousCompleted: true },
  }])
  let store = database.applyStoreMutations([{
    type: 'subtask:patch',
    taskId: task.id,
    id: 'sub-a',
    changes: { completed: false, completedAt: null },
  }])
  assert.equal(store.tasks[0].deletedAt, '2026-09-09T04:01:00.000Z')
  assert.equal(store.tasks[0].subTasks[0].completed, true)

  store = database.applyStoreMutations([{
    type: 'task:patch',
    id: task.id,
    changes: { deletedAt: null, previousCompleted: null, completed: true },
  }])
  assert.equal(store.tasks[0].deletedAt, null)
  assert.equal(store.tasks[0].completed, true)
  assert.equal(store.tasks[0].subTasks.every((subTask) => subTask.completed), true)
  database.close()
})

test('captures the canonical completion state when a stale window deletes a task', (t) => {
  const paths = tempPaths(t)
  const task = makeTask({ subTasks: [makeSubTask('sub-a'), makeSubTask('sub-b')] })
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [task] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })

  database.applyStoreMutations([
    {
      type: 'subtask:patch',
      taskId: task.id,
      id: 'sub-a',
      changes: { completed: true, completedAt: '2026-09-09T04:01:00.000Z' },
    },
    {
      type: 'subtask:patch',
      taskId: task.id,
      id: 'sub-b',
      changes: { completed: true, completedAt: '2026-09-09T04:02:00.000Z' },
    },
  ])
  let store = database.applyStoreMutations([{
    type: 'task:patch',
    id: task.id,
    changes: {
      deletedAt: '2026-09-09T04:03:00.000Z',
      previousCompleted: false,
    },
  }])
  assert.equal(store.tasks[0].completed, true)
  assert.equal(store.tasks[0].previousCompleted, true)

  store = database.applyStoreMutations([{
    type: 'task:patch',
    id: task.id,
    changes: {
      deletedAt: null,
      previousCompleted: null,
      completed: store.tasks[0].previousCompleted,
    },
  }])
  assert.equal(store.tasks[0].completed, true)
  assert.equal(store.tasks[0].subTasks.every((subTask) => subTask.completed), true)
  database.close()
})

test('supports daily-note create, field-level patch merge, delete, and persistent revisions', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision
  let store = database.applyStoreMutations([{ type: 'daily-note:create', note: makeDailyNote() }])
  assert.equal(store.revision, initialRevision + 1)
  assert.deepEqual(store.dailyNotes.map((note) => note.id), ['note-1'])

  database.applyStoreMutations([{
    type: 'daily-note:patch',
    id: 'note-1',
    changes: { content: '다른 창에서 바꾼 내용' },
  }])
  store = database.applyStoreMutations([{
    type: 'daily-note:patch',
    id: 'note-1',
    changes: { completed: true, completedAt: '2026-09-09T04:05:00.000Z' },
  }])
  assert.equal(store.dailyNotes[0].content, '다른 창에서 바꾼 내용')
  assert.equal(store.dailyNotes[0].completed, true)

  store = database.applyStoreMutations([{ type: 'daily-note:delete', id: 'note-1' }])
  assert.deepEqual(store.dailyNotes, [])
  const finalRevision = store.revision
  database.close()
  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.equal(reopened.readStore().revision, finalRevision)
  assert.deepEqual(reopened.readStore().dailyNotes, [])
  reopened.close()
})

test('persists reordering, editable built-ins, custom tags, clamped settings, and template CRUD', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [
      makeTask({ id: 'ordered-a', position: 0 }),
      makeTask({ id: 'ordered-b', position: 1, color: 'blue', tagId: 'builtin-blue' }),
    ],
    dailyNotes: [
      makeDailyNote({ id: 'note-a', position: 0 }),
      makeDailyNote({ id: 'note-b', position: 1, createdAt: '2026-09-09T02:00:00.000Z' }),
    ],
  }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const timestamp = '2026-09-09T04:10:00.000Z'
  const template = {
    id: 'template-custom',
    title: '집중 기간',
    note: '템플릿 메모',
    dueTime: '09:30',
    tagId: 'custom-focus',
    legacyColor: 'sage',
    durationDays: 5,
    subTaskTitles: ['준비', '실행'],
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  let store = database.applyStoreMutations([
    { type: 'task:patch', id: 'ordered-a', changes: { position: 1, tagId: 'custom-focus' } },
    { type: 'template:create', template },
    {
      type: 'tag:create',
      tag: {
        id: 'custom-focus',
        name: '집중',
        color: '#123456',
        builtIn: false,
        legacyColor: null,
        position: 9,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    { type: 'tag:patch', id: 'builtin-coral', changes: { name: '중요', updatedAt: timestamp } },
    { type: 'tag:delete', id: 'builtin-blue' },
    { type: 'task:patch', id: 'ordered-b', changes: { position: 0 } },
    { type: 'daily-note:patch', id: 'note-a', changes: { position: 1 } },
    { type: 'daily-note:patch', id: 'note-b', changes: { position: 0 } },
    {
      type: 'settings:patch',
      changes: { sidebarSplit: 5, widgetSplit: 95, fontScale: 9, themeColor: '#abcdef' },
    },
  ])

  assert.deepEqual(store.tasks.map(({ id, position }) => ({ id, position })), [
    { id: 'ordered-b', position: 0 },
    { id: 'ordered-a', position: 1 },
  ])
  assert.deepEqual(store.dailyNotes.map(({ id, position }) => ({ id, position })), [
    { id: 'note-b', position: 0 },
    { id: 'note-a', position: 1 },
  ])
  assert.equal(store.taskTags.find((tag) => tag.id === 'builtin-coral').name, '중요')
  assert.ok(store.taskTags.some((tag) => tag.id === 'builtin-blue'))
  assert.equal(store.taskTags.find((tag) => tag.id === 'custom-focus').builtIn, false)
  assert.deepEqual(store.settings, {
    sidebarSplit: 20,
    widgetSplit: 80,
    fontScale: 1.5,
    themeColor: '#ABCDEF',
  })
  assert.deepEqual(store.taskTemplates, [template])

  store = database.applyStoreMutations([
    {
      type: 'tag:patch',
      id: 'custom-focus',
      changes: { name: '깊은 집중', color: '#654321', updatedAt: '2026-09-09T04:11:00.000Z' },
    },
    {
      type: 'template:patch',
      id: template.id,
      changes: {
        title: '수정한 기간',
        durationDays: 0,
        subTaskTitles: ['한 단계'],
        updatedAt: '2026-09-09T04:11:00.000Z',
      },
    },
  ])
  assert.equal(store.taskTags.find((tag) => tag.id === 'custom-focus').name, '깊은 집중')
  assert.equal(store.taskTemplates[0].title, '수정한 기간')
  assert.equal(store.taskTemplates[0].durationDays, 1)
  assert.deepEqual(store.taskTemplates[0].subTaskTitles, ['한 단계'])
  database.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  store = reopened.readStore()
  assert.equal(store.taskTags.find((tag) => tag.id === 'builtin-coral').name, '중요')
  assert.equal(store.taskTags.find((tag) => tag.id === 'custom-focus').color, '#654321')
  assert.equal(store.taskTemplates[0].durationDays, 1)

  store = reopened.applyStoreMutations([{ type: 'tag:delete', id: 'custom-focus' }])
  assert.equal(store.taskTags.some((tag) => tag.id === 'custom-focus'), false)
  assert.equal(store.tasks.find((task) => task.id === 'ordered-a').tagId, null)
  assert.equal(store.taskTemplates[0].tagId, null)
  assert.equal(store.tasks.some((task) => task.id === 'ordered-a'), true)
  store = reopened.applyStoreMutations([{ type: 'template:delete', id: template.id }])
  assert.deepEqual(store.taskTemplates, [])
  reopened.close()

  const afterDeleteReopen = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.equal(afterDeleteReopen.readStore().tasks.find((task) => task.id === 'ordered-a').tagId, null)
  afterDeleteReopen.close()
})

test('queues nested task and daily-note payloads for a future linked profile', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({
    version: 1,
    tasks: [makeTask({ subTasks: [makeSubTask('sync-sub')] })],
    dailyNotes: [makeDailyNote()],
  }))
  let database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const profileId = database.readDiagnostics().profileId
  database.close()

  let sqlite = new DatabaseSync(paths.databasePath)
  sqlite.prepare(`UPDATE profiles SET kind = 'linked' WHERE id = ?`).run(profileId)
  sqlite.close()

  database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  database.applyStoreMutations([{
    type: 'subtask:patch',
    taskId: 'task-1',
    id: 'sync-sub',
    changes: { title: '동기화할 하위 일정' },
  }])
  database.applyStoreMutations([{
    type: 'daily-note:patch',
    id: 'note-1',
    changes: { content: '동기화할 당일 메모' },
  }])
  database.applyStoreMutations([
    {
      type: 'tag:create',
      tag: {
        id: 'sync-tag',
        name: '동기화 태그',
        color: '#123456',
        builtIn: false,
        legacyColor: null,
        position: 9,
        createdAt: '2026-09-09T04:20:00.000Z',
        updatedAt: '2026-09-09T04:20:00.000Z',
      },
    },
    {
      type: 'template:create',
      template: {
        id: 'sync-template',
        title: '동기화 템플릿',
        note: '',
        dueTime: null,
        tagId: 'sync-tag',
        legacyColor: 'coral',
        durationDays: 2,
        subTaskTitles: ['하위 일정'],
        position: 0,
        createdAt: '2026-09-09T04:20:00.000Z',
        updatedAt: '2026-09-09T04:20:00.000Z',
      },
    },
    { type: 'settings:patch', changes: { sidebarSplit: 42 } },
  ])
  database.close()

  sqlite = new DatabaseSync(paths.databasePath, { readOnly: true })
  const taskOutbox = sqlite.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE entity_type = 'task' AND entity_id = 'task-1'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  const noteOutbox = sqlite.prepare(`
    SELECT operation, payload_json FROM sync_outbox
    WHERE entity_type = 'daily_note' AND entity_id = 'note-1'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  const tagOutbox = sqlite.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE entity_type = 'task_tag' AND entity_id = 'sync-tag'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  const templateOutbox = sqlite.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE entity_type = 'task_template' AND entity_id = 'sync-template'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  const settingsOutbox = sqlite.prepare(`
    SELECT payload_json FROM sync_outbox
    WHERE entity_type = 'app_settings'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  const taskPayload = JSON.parse(taskOutbox.payload_json)
  assert.equal(taskPayload.subTasks[0].title, '동기화할 하위 일정')
  assert.equal(taskPayload.startDate, '2026-09-09')
  assert.equal(taskPayload.tagId, 'builtin-coral')
  assert.equal(taskPayload.position, 0)
  assert.equal(noteOutbox.operation, 'upsert')
  assert.equal(JSON.parse(noteOutbox.payload_json).content, '동기화할 당일 메모')
  assert.equal(JSON.parse(tagOutbox.payload_json).name, '동기화 태그')
  assert.deepEqual(JSON.parse(templateOutbox.payload_json).subTaskTitles, ['하위 일정'])
  assert.equal(JSON.parse(settingsOutbox.payload_json).sidebarSplit, 42)
  sqlite.close()
})

test('records cached update consent and reconciles an exact installed target offline', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  let database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision

  assert.equal(database.readInstalledReleaseHistory(), null)
  assert.deepEqual(database.recordUpdateConsent(
    'v0.3.2',
    '0.3.4',
    '2026-09-09T05:00:00+00:00',
    ' Dayline   v0.3.4 ',
    '\n## v0.3.3\n\nFirst\n\n## v0.3.4\n\nSecond\n',
  ), {
    fromVersion: '0.3.2',
    targetVersion: '0.3.4',
    recordedAt: '2026-09-09T05:00:00.000Z',
    releaseName: 'Dayline v0.3.4',
    releaseNotes: '## v0.3.3\n\nFirst\n\n## v0.3.4\n\nSecond',
  })
  assert.equal(database.readStore().revision, initialRevision)
  database.close()

  database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.equal(database.reconcileUpdateHistory('0.3.2', '2026-09-09T05:01:00.000Z'), null)
  assert.equal(database.reconcileUpdateHistory('0.3.3', '2026-09-09T05:02:00.000Z'), null)
  const reconciled = database.reconcileUpdateHistory('v0.3.4', '2026-09-09T05:03:00.000Z')
  assert.deepEqual(reconciled, {
    state: 'ready',
    fromVersion: '0.3.2',
    targetVersion: '0.3.4',
    toVersion: '0.3.4',
    releaseName: 'Dayline v0.3.4',
    releaseNotes: '## v0.3.3\n\nFirst\n\n## v0.3.4\n\nSecond',
    recordedAt: '2026-09-09T05:00:00.000Z',
    completedAt: '2026-09-09T05:03:00.000Z',
    verified: false,
  })
  assert.deepEqual(database.readInstalledReleaseHistory(), reconciled)
  assert.equal(database.reconcileUpdateHistory('0.3.4', '2026-09-09T05:04:00.000Z'), null)
  assert.equal(database.readStore().revision, initialRevision)
  database.close()

  const inspected = new DatabaseSync(paths.databasePath, { readOnly: true })
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM sync_outbox`).get().count, 0)
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM app_meta WHERE key = 'pending_update_consent_v1'
  `).get().count, 0)
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM app_meta WHERE key = 'installed_release_history_v1'
  `).get().count, 1)
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 4)
  inspected.close()
})

test('marks jumped installed versions unavailable and safely fills their notes later', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision
  database.recordUpdateConsent(
    '1.0.0-beta.2',
    '1.0.0-beta.10',
    '2026-09-09T06:00:00.000Z',
    'Dayline preview',
    'Cached notes stop at beta.10',
  )

  const unavailable = database.reconcileUpdateHistory('1.0.0', '2026-09-09T06:01:00.000Z')
  assert.deepEqual(unavailable, {
    state: 'notes-unavailable',
    fromVersion: '1.0.0-beta.2',
    targetVersion: '1.0.0-beta.10',
    toVersion: '1.0.0',
    releaseName: null,
    releaseNotes: null,
    recordedAt: '2026-09-09T06:00:00.000Z',
    completedAt: '2026-09-09T06:01:00.000Z',
    verified: false,
  })

  const ready = database.saveInstalledReleaseNotes({
    ...unavailable,
    state: 'ready',
    targetVersion: '1.0.0',
    releaseName: ' Dayline   1.0.0 ',
    releaseNotes: '\n## v1.0.0-beta.10\n\nPreview\n\n## v1.0.0\n\nStable\n',
  })
  assert.deepEqual(ready, {
    ...unavailable,
    state: 'ready',
    releaseName: 'Dayline 1.0.0',
    releaseNotes: '## v1.0.0-beta.10\n\nPreview\n\n## v1.0.0\n\nStable',
    verified: true,
  })
  assert.deepEqual(database.readInstalledReleaseHistory(), ready)

  assert.throws(() => database.saveInstalledReleaseNotes({
    ...ready,
    targetVersion: '1.0.1',
    toVersion: '1.0.1',
  }), /do not match/)
  assert.throws(() => database.saveInstalledReleaseNotes({
    ...ready,
    recordedAt: '2026-09-09T06:00:01.000Z',
  }), /do not match/)
  assert.deepEqual(database.readInstalledReleaseHistory(), ready)
  assert.equal(database.readStore().revision, initialRevision)
  database.close()
})

test('bootstraps ready notes without inventing a prior version baseline', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision

  const baseline = database.saveInstalledReleaseNotes({
    state: 'ready',
    fromVersion: null,
    targetVersion: 'v0.3.3',
    toVersion: '0.3.3',
    releaseName: 'Dayline v0.3.3',
    releaseNotes: '- First visible release notes',
    recordedAt: null,
    completedAt: null,
    verified: true,
  })
  assert.deepEqual(baseline, {
    state: 'ready',
    fromVersion: null,
    targetVersion: '0.3.3',
    toVersion: '0.3.3',
    releaseName: 'Dayline v0.3.3',
    releaseNotes: '- First visible release notes',
    recordedAt: null,
    completedAt: null,
    verified: true,
  })
  assert.deepEqual(database.readInstalledReleaseHistory(), baseline)
  assert.equal(database.readStore().revision, initialRevision)
  database.close()

  const reopened = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.deepEqual(reopened.readInstalledReleaseHistory(), baseline)
  assert.equal(reopened.readStore().revision, initialRevision)
  reopened.close()
})

test('validates update metadata without changing user data revision', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  const database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision

  assert.throws(
    () => database.recordUpdateConsent('0.3.2', '0.3.2+other-build', FIXED_NOW.toISOString()),
    /newer than/,
  )
  assert.throws(
    () => database.recordUpdateConsent('1.0.0-beta.01', '1.0.0', FIXED_NOW.toISOString()),
    /semantic version/,
  )
  assert.throws(
    () => database.recordUpdateConsent('0.3.2', '0.3.3', 'not-a-date'),
    /valid timestamp/,
  )
  assert.throws(() => database.saveInstalledReleaseNotes({
    state: 'ready',
    fromVersion: null,
    targetVersion: '0.3.3',
    toVersion: '0.3.3',
    releaseName: null,
    releaseNotes: 'x'.repeat((128 * 1024) + 1),
    recordedAt: null,
    completedAt: null,
  }), /too long/)
  assert.equal(database.readInstalledReleaseHistory(), null)
  assert.deepEqual(
    database.recordUpdateConsent('0.3.2', '0.3.3', '2026-09-09T06:30:00.000Z'),
    {
      fromVersion: '0.3.2',
      targetVersion: '0.3.3',
      recordedAt: '2026-09-09T06:30:00.000Z',
      releaseName: null,
      releaseNotes: null,
    },
  )
  assert.equal(
    database.reconcileUpdateHistory('0.3.3', '2026-09-09T06:31:00.000Z').state,
    'notes-unavailable',
  )
  assert.equal(database.readStore().revision, initialRevision)
  database.close()
})

test('rolls back pending reconciliation when its installed metadata write fails', (t) => {
  const paths = tempPaths(t)
  fs.writeFileSync(paths.legacyJsonPath, JSON.stringify({ version: 1, tasks: [] }))
  let database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  const initialRevision = database.readStore().revision
  database.recordUpdateConsent('0.3.2', '0.3.3', '2026-09-09T07:00:00.000Z')
  database.close()

  const setup = new DatabaseSync(paths.databasePath)
  setup.exec(`
    CREATE TRIGGER fail_installed_release_history
    BEFORE INSERT ON app_meta
    WHEN NEW.key = 'installed_release_history_v1'
    BEGIN
      SELECT RAISE(ABORT, 'forced installed history failure');
    END;
  `)
  setup.close()

  database = createDaylineDatabase({ ...paths, now: () => new Date(FIXED_NOW) })
  assert.throws(
    () => database.reconcileUpdateHistory('0.3.3', '2026-09-09T07:01:00.000Z'),
    /forced installed history failure/,
  )
  assert.equal(database.readInstalledReleaseHistory(), null)
  assert.equal(database.readStore().revision, initialRevision)
  database.close()

  const inspected = new DatabaseSync(paths.databasePath, { readOnly: true })
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM app_meta WHERE key = 'pending_update_consent_v1'
  `).get().count, 1)
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM app_meta WHERE key = 'installed_release_history_v1'
  `).get().count, 0)
  inspected.close()
})
