const fs = require('node:fs')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 30 * DAY_MS
const SCHEMA_VERSION = 2
const STORE_VERSION = 1
const TASK_COLORS = new Set(['coral', 'violet', 'sage', 'blue', 'amber'])
const TASK_PATCHABLE_FIELDS = [
  'title',
  'note',
  'dueDate',
  'dueTime',
  'color',
  'completed',
  'completedAt',
  'deletedAt',
  'previousCompleted',
  'updatedAt',
]
const TASK_COLUMN_BY_FIELD = {
  title: 'title',
  note: 'note',
  dueDate: 'due_date',
  dueTime: 'due_time',
  color: 'color',
  completed: 'completed',
  completedAt: 'completed_at',
  deletedAt: 'deleted_at',
  previousCompleted: 'previous_completed',
  updatedAt: 'updated_at',
}
const SUBTASK_PATCHABLE_FIELDS = ['title', 'completed', 'completedAt', 'updatedAt']
const SUBTASK_COLUMN_BY_FIELD = {
  title: 'title',
  completed: 'completed',
  completedAt: 'completed_at',
  updatedAt: 'updated_at',
}
const DAILY_NOTE_PATCHABLE_FIELDS = ['content', 'noteDate', 'completed', 'completedAt', 'updatedAt']
const DAILY_NOTE_COLUMN_BY_FIELD = {
  content: 'content',
  noteDate: 'note_date',
  completed: 'completed',
  completedAt: 'completed_at',
  updatedAt: 'updated_at',
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateOffset(offset, now = new Date()) {
  const date = new Date(now)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return localDateKey(date)
}

function createSeedStore(now = new Date()) {
  const nowIso = now.toISOString()
  const completedAt = new Date(now.getTime() - 52 * 60 * 1000).toISOString()
  const deletedAt = new Date(now.getTime() - 2 * DAY_MS).toISOString()
  const withDefaults = (task) => ({ ...task, subTasks: task.subTasks || [] })

  return {
    version: STORE_VERSION,
    tasks: [
      withDefaults({
        id: crypto.randomUUID(),
        title: 'Dayline 프로토타입 살펴보기',
        note: '활성 일정과 위젯, 최근 삭제 복구 기능을 확인해 보세요.',
        dueDate: dateOffset(0, now),
        dueTime: null,
        color: 'coral',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        subTasks: [
          {
            id: crypto.randomUUID(),
            title: '캘린더에서 오늘 일정 확인하기',
            completed: false,
            completedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: crypto.randomUUID(),
            title: '오른쪽 일정 영역에서 하위 일정 완료하기',
            completed: false,
            completedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      }),
      withDefaults({
        id: crypto.randomUUID(),
        title: '오늘의 우선순위 정리',
        note: '',
        dueDate: dateOffset(0, now),
        dueTime: '10:30',
        color: 'violet',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      withDefaults({
        id: crypto.randomUUID(),
        title: '주간 계획 초안',
        note: '',
        dueDate: dateOffset(1, now),
        dueTime: null,
        color: 'blue',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      withDefaults({
        id: crypto.randomUUID(),
        title: '복구 기능 예시 일정',
        note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        dueDate: dateOffset(-3, now),
        dueTime: null,
        color: 'blue',
        completed: true,
        completedAt: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
        deletedAt,
        previousCompleted: true,
        createdAt: new Date(now.getTime() - 6 * DAY_MS).toISOString(),
        updatedAt: deletedAt,
      }),
    ],
    dailyNotes: [
      {
        id: crypto.randomUUID(),
        content: '떠오른 할 일을 여기에 바로 적어 보세요.',
        noteDate: dateOffset(0, now),
        completed: false,
        completedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ],
  }
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
}

function normalizeTimestamp(value, fallback) {
  return isIsoTimestamp(value) ? new Date(value).toISOString() : fallback
}

function sanitizeSubTask(subTask, now = new Date()) {
  if (!subTask || typeof subTask !== 'object') return null
  if (typeof subTask.id !== 'string' || subTask.id.length < 1 || subTask.id.length > 128) return null
  if (typeof subTask.title !== 'string' || subTask.title.trim().length < 1) return null
  const nowIso = now.toISOString()
  const completed = Boolean(subTask.completed)
  return {
    id: subTask.id,
    title: subTask.title.trim().slice(0, 240),
    completed,
    completedAt: completed && isIsoTimestamp(subTask.completedAt)
      ? new Date(subTask.completedAt).toISOString()
      : null,
    createdAt: normalizeTimestamp(subTask.createdAt, nowIso),
    updatedAt: normalizeTimestamp(subTask.updatedAt, nowIso),
  }
}

function sanitizeTask(task, now = new Date()) {
  if (!task || typeof task !== 'object') return null
  if (typeof task.id !== 'string' || task.id.length < 1 || task.id.length > 128) return null
  if (typeof task.title !== 'string' || task.title.trim().length < 1) return null
  if (!isDateKey(task.dueDate)) return null

  const nowIso = now.toISOString()
  let completed = Boolean(task.completed)
  let completedAt = completed && isIsoTimestamp(task.completedAt)
    ? new Date(task.completedAt).toISOString()
    : null
  const deletedAt = isIsoTimestamp(task.deletedAt)
    ? new Date(task.deletedAt).toISOString()
    : null

  let subTasks = Array.isArray(task.subTasks)
    ? task.subTasks.map((value) => sanitizeSubTask(value, now)).filter(Boolean)
    : []
  if (completed && subTasks.length > 0) {
    const completionTimestamp = completedAt || nowIso
    completedAt = completionTimestamp
    subTasks = subTasks.map((subTask) => subTask.completed
      ? subTask
      : {
          ...subTask,
          completed: true,
          completedAt: completionTimestamp,
          updatedAt: completionTimestamp,
        })
  } else if (!completed && subTasks.length > 0 && subTasks.every((subTask) => subTask.completed)) {
    completed = true
    completedAt = nowIso
  }

  return {
    id: task.id,
    title: task.title.trim().slice(0, 240),
    note: typeof task.note === 'string' ? task.note.slice(0, 2000) : '',
    dueDate: task.dueDate,
    dueTime: typeof task.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime)
      ? task.dueTime
      : null,
    color: TASK_COLORS.has(task.color) ? task.color : 'coral',
    completed,
    completedAt,
    deletedAt,
    previousCompleted: typeof task.previousCompleted === 'boolean' ? task.previousCompleted : null,
    createdAt: normalizeTimestamp(task.createdAt, nowIso),
    updatedAt: normalizeTimestamp(task.updatedAt, nowIso),
    subTasks,
  }
}

function sanitizeDailyNote(note, now = new Date()) {
  if (!note || typeof note !== 'object') return null
  if (typeof note.id !== 'string' || note.id.length < 1 || note.id.length > 128) return null
  if (typeof note.content !== 'string' || note.content.trim().length < 1) return null
  if (!isDateKey(note.noteDate)) return null
  const nowIso = now.toISOString()
  const completed = Boolean(note.completed)
  return {
    id: note.id,
    content: note.content.slice(0, 10000),
    noteDate: note.noteDate,
    completed,
    completedAt: completed && isIsoTimestamp(note.completedAt)
      ? new Date(note.completedAt).toISOString()
      : null,
    createdAt: normalizeTimestamp(note.createdAt, nowIso),
    updatedAt: normalizeTimestamp(note.updatedAt, nowIso),
  }
}

function isRecoverableTask(task, now = Date.now()) {
  if (!task.deletedAt) return true
  return now - new Date(task.deletedAt).getTime() <= RETENTION_MS
}

function rowToTask(row, subTasks = []) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    dueDate: row.due_date,
    dueTime: row.due_time,
    color: row.color,
    completed: row.completed === 1,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    previousCompleted: row.previous_completed == null ? null : row.previous_completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subTasks,
  }
}

function rowToSubTask(row) {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed === 1,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDailyNote(row) {
  return {
    id: row.id,
    content: row.content,
    noteDate: row.note_date,
    completed: row.completed === 1,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sqliteValue(field, value) {
  if (field === 'completed') return value ? 1 : 0
  if (field === 'previousCompleted') return value == null ? null : value ? 1 : 0
  return value
}

function sanitizeMigrationWarning(rawValue) {
  if (typeof rawValue !== 'string') return null
  try {
    const value = JSON.parse(rawValue)
    if (!value || typeof value !== 'object' || value.status !== 'failed') return null
    const knownReasons = new Set(['invalid-json', 'backup-error', 'read-error'])
    return {
      reason: knownReasons.has(value.reason) ? value.reason : 'read-error',
      backupPath: typeof value.backupPath === 'string' ? value.backupPath : null,
    }
  } catch {
    return null
  }
}

function inTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  }
}

function createSchema(database, appliedAt) {
  const currentVersion = Number(database.prepare('PRAGMA user_version').get().user_version || 0)
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`Dayline database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`)
  }

  inTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        server_user_id TEXT UNIQUE,
        kind TEXT NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest', 'linked')),
        display_name TEXT,
        email TEXT,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_identities (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        avatar_url TEXT,
        credential_ref TEXT,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        UNIQUE (provider, provider_subject)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        device_name TEXT,
        platform TEXT NOT NULL DEFAULT 'windows',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        remote_id TEXT,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
        note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
        due_date TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        due_time TEXT CHECK (
          due_time IS NULL OR (
            due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(due_time, 1, 2) <= '23'
          )
        ),
        color TEXT NOT NULL CHECK (color IN ('coral', 'violet', 'sage', 'blue', 'amber')),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        completed_at TEXT,
        deleted_at TEXT,
        previous_completed INTEGER CHECK (previous_completed IS NULL OR previous_completed IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
        server_version INTEGER,
        sync_state TEXT NOT NULL DEFAULT 'local_only'
          CHECK (sync_state IN ('local_only', 'pending', 'synced', 'conflict')),
        last_synced_at TEXT,
        UNIQUE (profile_id, remote_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tasks_calendar
        ON tasks(profile_id, due_date, completed) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_recovery
        ON tasks(profile_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_sync
        ON tasks(profile_id, sync_state, updated_at);
      CREATE TABLE IF NOT EXISTS sync_outbox (
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
      CREATE TABLE IF NOT EXISTS sync_cursors (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        server_cursor TEXT,
        last_synced_at TEXT,
        last_error TEXT
      ) STRICT;
    `)
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)
      ON CONFLICT(version) DO NOTHING
    `).run(appliedAt)
    if (currentVersion < 1) database.exec('PRAGMA user_version = 1')
  })

  if (currentVersion < 2) {
    inTransaction(database, () => {
      database.exec(`
        CREATE TABLE sub_tasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
          completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
          completed_at TEXT,
          position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          server_version INTEGER,
          sync_state TEXT NOT NULL DEFAULT 'local_only'
            CHECK (sync_state IN ('local_only', 'pending', 'synced', 'conflict'))
        ) STRICT;
        CREATE INDEX idx_sub_tasks_parent ON sub_tasks(task_id, position, created_at, id);

        CREATE TABLE daily_notes (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          remote_id TEXT,
          content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
          note_date TEXT NOT NULL CHECK (note_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
          server_version INTEGER,
          sync_state TEXT NOT NULL DEFAULT 'local_only'
            CHECK (sync_state IN ('local_only', 'pending', 'synced', 'conflict')),
          last_synced_at TEXT,
          UNIQUE (profile_id, remote_id)
        ) STRICT;
        CREATE INDEX idx_daily_notes_date ON daily_notes(profile_id, note_date, created_at, id);
        CREATE INDEX idx_daily_notes_sync ON daily_notes(profile_id, sync_state, updated_at);

        ALTER TABLE sync_outbox RENAME TO sync_outbox_v1;
        CREATE TABLE sync_outbox (
          mutation_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'daily_note')),
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
        INSERT INTO sync_outbox (
          mutation_id, profile_id, entity_type, entity_id, operation,
          base_server_version, payload_json, created_at, attempt_count,
          next_attempt_at, acknowledged_at, last_error
        )
        SELECT mutation_id, profile_id, entity_type, entity_id, operation,
          base_server_version, payload_json, created_at, attempt_count,
          next_attempt_at, acknowledged_at, last_error
        FROM sync_outbox_v1;
        DROP TABLE sync_outbox_v1;
      `)
      database.prepare(`
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)
        ON CONFLICT(version) DO NOTHING
      `).run(appliedAt)
      database.exec('PRAGMA user_version = 2')
    })
  }
}

function insertSubTask(database, taskId, subTask, position) {
  return Number(database.prepare(`
    INSERT INTO sub_tasks (
      id, task_id, title, completed, completed_at, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    subTask.id,
    taskId,
    subTask.title,
    subTask.completed ? 1 : 0,
    subTask.completedAt,
    position,
    subTask.createdAt,
    subTask.updatedAt,
  ).changes)
}

function insertTask(database, profileId, task) {
  const inserted = Number(database.prepare(`
    INSERT INTO tasks (
      id, profile_id, title, note, due_date, due_time, color, completed,
      completed_at, deleted_at, previous_completed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    task.id,
    profileId,
    task.title,
    task.note,
    task.dueDate,
    task.dueTime,
    task.color,
    task.completed ? 1 : 0,
    task.completedAt,
    task.deletedAt,
    task.previousCompleted == null ? null : task.previousCompleted ? 1 : 0,
    task.createdAt,
    task.updatedAt,
  ).changes)
  if (inserted > 0) {
    task.subTasks.forEach((subTask, index) => insertSubTask(database, task.id, subTask, index))
  }
  return inserted
}

function insertDailyNote(database, profileId, note) {
  return Number(database.prepare(`
    INSERT INTO daily_notes (
      id, profile_id, content, note_date, completed, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    note.id,
    profileId,
    note.content,
    note.noteDate,
    note.completed ? 1 : 0,
    note.completedAt,
    note.createdAt,
    note.updatedAt,
  ).changes)
}

function createDaylineDatabase({ databasePath, legacyJsonPath, now = () => new Date() }) {
  const database = new DatabaseSync(databasePath, { timeout: 500 })
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA busy_timeout = 500')
  if (typeof database.enableDefensive === 'function') database.enableDefensive(true)

  const openedAt = now().toISOString()
  createSchema(database, openedAt)

  const getMeta = database.prepare('SELECT value FROM app_meta WHERE key = ?')
  const setMeta = database.prepare(`
    INSERT INTO app_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
  const deleteMeta = database.prepare('DELETE FROM app_meta WHERE key = ?')
  if (!getMeta.get('store_revision')) setMeta.run('store_revision', '0')
  const incrementStoreRevision = database.prepare(`
    UPDATE app_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'store_revision'
  `)

  function readStoreRevision() {
    const value = Number.parseInt(getMeta.get('store_revision')?.value || '0', 10)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  function bumpStoreRevision() {
    incrementStoreRevision.run()
    return readStoreRevision()
  }

  function readMigrationWarning() {
    return sanitizeMigrationWarning(getMeta.get('legacy_json_v1_error')?.value)
  }

  let profileId = getMeta.get('local_profile_id')?.value
  if (!profileId) {
    profileId = crypto.randomUUID()
    const deviceId = crypto.randomUUID()
    inTransaction(database, () => {
      database.prepare(`
        INSERT INTO profiles(id, kind, display_name, created_at, updated_at)
        VALUES (?, 'guest', '로컬 사용자', ?, ?)
      `).run(profileId, openedAt, openedAt)
      database.prepare(`
        INSERT INTO devices(id, profile_id, device_name, platform, created_at, last_seen_at)
        VALUES (?, ?, ?, 'windows', ?, ?)
      `).run(deviceId, profileId, process.env.COMPUTERNAME || 'Windows PC', openedAt, openedAt)
      setMeta.run('local_profile_id', profileId)
      setMeta.run('installation_id', deviceId)
    })
  }

  if (!getMeta.get('legacy_json_v1_migration')) {
    const priorMigrationErrorRaw = getMeta.get('legacy_json_v1_error')?.value
    const hasExistingContent = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM tasks WHERE profile_id = ?',
    ).get(profileId).count) > 0 || Number(database.prepare(
      'SELECT COUNT(*) AS count FROM daily_notes WHERE profile_id = ?',
    ).get(profileId).count) > 0
    let source = 'seeded'
    let tasks = []
    let dailyNotes = []
    let rejectedCount = 0
    let rejectedDailyNoteCount = 0
    let sourceHash = null
    let backupPath = null
    let migrationError = null

    if (legacyJsonPath && fs.existsSync(legacyJsonPath)) {
      try {
        const raw = fs.readFileSync(legacyJsonPath)
        sourceHash = crypto.createHash('sha256').update(raw).digest('hex')
        const parsed = JSON.parse(raw.toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) {
          const error = new Error('Legacy Dayline data must be a version 1 store with a tasks array.')
          error.code = 'DAYLINE_INVALID_LEGACY_STORE'
          throw error
        }
        tasks = parsed.tasks
          .map((task) => sanitizeTask(task, now()))
          .filter((task) => {
            if (!task) rejectedCount += 1
            return Boolean(task)
          })
          .filter((task) => isRecoverableTask(task, now().getTime()))
        dailyNotes = (Array.isArray(parsed.dailyNotes) ? parsed.dailyNotes : [])
          .map((note) => sanitizeDailyNote(note, now()))
          .filter((note) => {
            if (!note) rejectedDailyNoteCount += 1
            return Boolean(note)
          })
        source = 'imported'
        backupPath = `${legacyJsonPath}.pre-sqlite-backup`
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(legacyJsonPath, backupPath, fs.constants.COPYFILE_EXCL)
        }
      } catch (error) {
        tasks = []
        dailyNotes = []
        const failedBackupPath = `${legacyJsonPath}.migration-failed-backup`
        let backupErrorCode = null
        try {
          if (!fs.existsSync(failedBackupPath)) {
            fs.copyFileSync(legacyJsonPath, failedBackupPath, fs.constants.COPYFILE_EXCL)
          }
          backupPath = failedBackupPath
        } catch (backupError) {
          backupErrorCode = typeof backupError?.code === 'string' ? backupError.code : null
        }
        const isInvalidJson = error instanceof SyntaxError || error?.code === 'DAYLINE_INVALID_LEGACY_STORE'
        migrationError = {
          status: 'failed',
          attemptedAt: now().toISOString(),
          reason: isInvalidJson ? 'invalid-json' : sourceHash ? 'backup-error' : 'read-error',
          errorCode: typeof error?.code === 'string' ? error.code : null,
          backupErrorCode,
          sourceHash,
          backupPath,
        }
      }
    } else if (priorMigrationErrorRaw) {
      try {
        const previousError = JSON.parse(priorMigrationErrorRaw)
        migrationError = previousError?.status === 'failed'
          ? previousError
          : null
      } catch {
        migrationError = null
      }
      if (!migrationError) {
        migrationError = {
          status: 'failed',
          attemptedAt: now().toISOString(),
          reason: 'read-error',
          errorCode: null,
          backupErrorCode: null,
          sourceHash: null,
          backupPath: null,
        }
      }
    } else if (!hasExistingContent) {
      const seed = createSeedStore(now())
      tasks = seed.tasks
      dailyNotes = seed.dailyNotes
    } else {
      source = 'existing'
    }

    if (migrationError) {
      const previousWarning = readMigrationWarning()
      const nextWarning = sanitizeMigrationWarning(JSON.stringify(migrationError))
      inTransaction(database, () => {
        setMeta.run('legacy_json_v1_error', JSON.stringify(migrationError))
        if (JSON.stringify(previousWarning) !== JSON.stringify(nextWarning)) bumpStoreRevision()
      })
    } else {
      inTransaction(database, () => {
        for (const task of tasks) insertTask(database, profileId, task)
        for (const note of dailyNotes) insertDailyNote(database, profileId, note)
        setMeta.run('legacy_json_v1_migration', JSON.stringify({
          status: source,
          importedAt: now().toISOString(),
          importedCount: tasks.length,
          importedDailyNoteCount: dailyNotes.length,
          rejectedCount,
          rejectedDailyNoteCount,
          sourceHash,
          backupPath,
        }))
        deleteMeta.run('legacy_json_v1_error')
        bumpStoreRevision()
      })
    }
  }

  const selectTask = database.prepare('SELECT * FROM tasks WHERE id = ? AND profile_id = ?')
  const selectTasks = database.prepare('SELECT * FROM tasks WHERE profile_id = ? ORDER BY created_at, id')
  const selectSubTasks = database.prepare(`
    SELECT sub_tasks.* FROM sub_tasks
    JOIN tasks ON tasks.id = sub_tasks.task_id
    WHERE tasks.profile_id = ?
    ORDER BY sub_tasks.task_id, sub_tasks.position, sub_tasks.created_at, sub_tasks.id
  `)
  const selectSubTask = database.prepare(`
    SELECT sub_tasks.* FROM sub_tasks
    JOIN tasks ON tasks.id = sub_tasks.task_id
    WHERE sub_tasks.id = ? AND sub_tasks.task_id = ? AND tasks.profile_id = ?
  `)
  const selectDailyNotes = database.prepare(`
    SELECT * FROM daily_notes WHERE profile_id = ? ORDER BY note_date, created_at, id
  `)
  const selectDailyNote = database.prepare('SELECT * FROM daily_notes WHERE id = ? AND profile_id = ?')
  const profileKind = database.prepare('SELECT kind FROM profiles WHERE id = ?')

  function purgeExpired(nowDate = now()) {
    const cutoff = new Date(nowDate.getTime() - RETENTION_MS).toISOString()
    return Number(database.prepare(`
      DELETE FROM tasks
      WHERE profile_id = ? AND deleted_at IS NOT NULL AND deleted_at < ? AND sync_state = 'local_only'
    `).run(profileId, cutoff).changes)
  }

  function buildStore() {
    const subTasksByTask = new Map()
    for (const row of selectSubTasks.all(profileId)) {
      const list = subTasksByTask.get(row.task_id) || []
      list.push(rowToSubTask(row))
      subTasksByTask.set(row.task_id, list)
    }
    return {
      version: STORE_VERSION,
      revision: readStoreRevision(),
      migrationWarning: readMigrationWarning(),
      tasks: selectTasks.all(profileId).map((row) => rowToTask(row, subTasksByTask.get(row.id) || [])),
      dailyNotes: selectDailyNotes.all(profileId).map(rowToDailyNote),
    }
  }

  function readStore() {
    inTransaction(database, () => {
      if (purgeExpired() > 0) bumpStoreRevision()
    })
    return buildStore()
  }

  function enqueueSyncMutation(entityType, entityId, operation, payload, previousServerVersion) {
    if (profileKind.get(profileId)?.kind !== 'linked') return
    database.prepare(`
      INSERT INTO sync_outbox (
        mutation_id, profile_id, entity_type, entity_id, operation,
        base_server_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      profileId,
      entityType,
      entityId,
      operation,
      previousServerVersion,
      payload == null ? null : JSON.stringify(payload),
      now().toISOString(),
    )
  }

  function applyStoreMutations(rawMutations) {
    const mutations = Array.isArray(rawMutations) ? rawMutations : []
    inTransaction(database, () => {
      const affectedTaskIds = new Set()
      const taskBaseVersions = new Map()
      const affectedDailyNotes = new Map()
      const syncState = profileKind.get(profileId)?.kind === 'linked' ? 'pending' : 'local_only'

      const markTask = (taskId, serverVersion) => {
        affectedTaskIds.add(taskId)
        if (!taskBaseVersions.has(taskId)) taskBaseVersions.set(taskId, serverVersion ?? null)
      }

      for (const rawMutation of mutations) {
        if (!rawMutation || typeof rawMutation !== 'object') continue
        const mutation = rawMutation.type === 'create'
          ? { ...rawMutation, type: 'task:create' }
          : rawMutation.type === 'patch'
            ? { ...rawMutation, type: 'task:patch' }
            : rawMutation

        if (mutation.type === 'task:create') {
          const task = sanitizeTask(mutation.task, now())
          if (!task || !isRecoverableTask(task, now().getTime())) continue
          if (insertTask(database, profileId, task) > 0) markTask(task.id, null)
          continue
        }

        if (mutation.type === 'task:patch' && typeof mutation.id === 'string') {
          const row = selectTask.get(mutation.id, profileId)
          if (!row || !mutation.changes || typeof mutation.changes !== 'object') continue
          const currentTask = rowToTask(row)
          const requestedFields = TASK_PATCHABLE_FIELDS.filter((field) =>
            Object.prototype.hasOwnProperty.call(mutation.changes, field),
          )
          if (requestedFields.length === 0) continue
          if (currentTask.deletedAt && !requestedFields.includes('deletedAt')) continue
          const normalized = sanitizeTask({ ...currentTask, ...mutation.changes }, now())
          if (!normalized) continue
          if (!currentTask.deletedAt && normalized.deletedAt) {
            // A stale renderer may delete after another window completed the task.
            // The database row is authoritative for the state that recovery restores.
            normalized.previousCompleted = currentTask.completed
            if (!requestedFields.includes('previousCompleted')) requestedFields.push('previousCompleted')
          }
          const assignments = requestedFields.map((field) => `${TASK_COLUMN_BY_FIELD[field]} = ?`)
          const values = requestedFields.map((field) => sqliteValue(field, normalized[field]))
          database.prepare(`
            UPDATE tasks
            SET ${assignments.join(', ')}, row_version = row_version + 1, sync_state = ?
            WHERE id = ? AND profile_id = ?
          `).run(...values, syncState, mutation.id, profileId)
          markTask(mutation.id, row.server_version)

          if (requestedFields.includes('completed')) {
            const timestamp = normalized.completed
              ? normalized.completedAt || now().toISOString()
              : null
            database.prepare(`
              UPDATE sub_tasks
              SET completed = ?, completed_at = ?, updated_at = ?,
                  row_version = row_version + 1, sync_state = ?
              WHERE task_id = ? AND completed <> ?
            `).run(
              normalized.completed ? 1 : 0,
              timestamp,
              now().toISOString(),
              syncState,
              mutation.id,
              normalized.completed ? 1 : 0,
            )
          }
          continue
        }

        if (mutation.type === 'subtask:create' && typeof mutation.taskId === 'string') {
          const parent = selectTask.get(mutation.taskId, profileId)
          if (!parent || parent.deleted_at) continue
          const subTask = sanitizeSubTask(mutation.subTask, now())
          if (!subTask) continue
          const position = Number(database.prepare(`
            SELECT COALESCE(MAX(position) + 1, 0) AS position FROM sub_tasks WHERE task_id = ?
          `).get(mutation.taskId).position)
          if (insertSubTask(database, mutation.taskId, subTask, position) > 0) {
            markTask(mutation.taskId, parent.server_version)
          }
          continue
        }

        if (
          mutation.type === 'subtask:patch'
          && typeof mutation.taskId === 'string'
          && typeof mutation.id === 'string'
        ) {
          const parent = selectTask.get(mutation.taskId, profileId)
          const row = selectSubTask.get(mutation.id, mutation.taskId, profileId)
          if (!parent || parent.deleted_at || !row || !mutation.changes || typeof mutation.changes !== 'object') continue
          const requestedFields = SUBTASK_PATCHABLE_FIELDS.filter((field) =>
            Object.prototype.hasOwnProperty.call(mutation.changes, field),
          )
          if (requestedFields.length === 0) continue
          const normalized = sanitizeSubTask({ ...rowToSubTask(row), ...mutation.changes }, now())
          if (!normalized) continue
          const assignments = requestedFields.map((field) => `${SUBTASK_COLUMN_BY_FIELD[field]} = ?`)
          const values = requestedFields.map((field) => sqliteValue(field, normalized[field]))
          database.prepare(`
            UPDATE sub_tasks
            SET ${assignments.join(', ')}, row_version = row_version + 1, sync_state = ?
            WHERE id = ? AND task_id = ?
          `).run(...values, syncState, mutation.id, mutation.taskId)
          markTask(mutation.taskId, parent.server_version)
          continue
        }

        if (
          mutation.type === 'subtask:delete'
          && typeof mutation.taskId === 'string'
          && typeof mutation.id === 'string'
        ) {
          const parent = selectTask.get(mutation.taskId, profileId)
          if (!parent || parent.deleted_at) continue
          const deleted = Number(database.prepare(`
            DELETE FROM sub_tasks WHERE id = ? AND task_id = ?
          `).run(mutation.id, mutation.taskId).changes)
          if (deleted > 0) markTask(mutation.taskId, parent.server_version)
          continue
        }

        if (mutation.type === 'daily-note:create') {
          const note = sanitizeDailyNote(mutation.note, now())
          if (!note) continue
          if (insertDailyNote(database, profileId, note) > 0) {
            affectedDailyNotes.set(note.id, { operation: 'upsert', baseVersion: null })
          }
          continue
        }

        if (mutation.type === 'daily-note:patch' && typeof mutation.id === 'string') {
          const row = selectDailyNote.get(mutation.id, profileId)
          if (!row || !mutation.changes || typeof mutation.changes !== 'object') continue
          const requestedFields = DAILY_NOTE_PATCHABLE_FIELDS.filter((field) =>
            Object.prototype.hasOwnProperty.call(mutation.changes, field),
          )
          if (requestedFields.length === 0) continue
          const normalized = sanitizeDailyNote({ ...rowToDailyNote(row), ...mutation.changes }, now())
          if (!normalized) continue
          const assignments = requestedFields.map((field) => `${DAILY_NOTE_COLUMN_BY_FIELD[field]} = ?`)
          const values = requestedFields.map((field) => sqliteValue(field, normalized[field]))
          database.prepare(`
            UPDATE daily_notes
            SET ${assignments.join(', ')}, row_version = row_version + 1, sync_state = ?
            WHERE id = ? AND profile_id = ?
          `).run(...values, syncState, mutation.id, profileId)
          if (!affectedDailyNotes.has(mutation.id)) {
            affectedDailyNotes.set(mutation.id, { operation: 'upsert', baseVersion: row.server_version })
          }
          continue
        }

        if (mutation.type === 'daily-note:delete' && typeof mutation.id === 'string') {
          const row = selectDailyNote.get(mutation.id, profileId)
          if (!row) continue
          database.prepare('DELETE FROM daily_notes WHERE id = ? AND profile_id = ?').run(mutation.id, profileId)
          affectedDailyNotes.set(mutation.id, {
            operation: 'delete',
            baseVersion: affectedDailyNotes.get(mutation.id)?.baseVersion ?? row.server_version,
          })
        }
      }

      const completionSummary = database.prepare(`
        SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed_count
        FROM sub_tasks WHERE task_id = ?
      `)
      for (const taskId of affectedTaskIds) {
        const parent = selectTask.get(taskId, profileId)
        if (!parent || parent.deleted_at) continue
        const summary = completionSummary.get(taskId)
        if (Number(summary.total) > 0) {
          const completed = Number(summary.completed_count) === Number(summary.total)
          const needsCompletionUpdate = parent.completed !== (completed ? 1 : 0)
            || (completed ? parent.completed_at == null : parent.completed_at != null)
          if (needsCompletionUpdate) {
            const timestamp = now().toISOString()
            database.prepare(`
              UPDATE tasks
              SET completed = ?, completed_at = ?, updated_at = ?,
                  row_version = row_version + 1, sync_state = ?
              WHERE id = ? AND profile_id = ?
            `).run(completed ? 1 : 0, completed ? timestamp : null, timestamp, syncState, taskId, profileId)
          }
        }
      }

      for (const taskId of affectedTaskIds) {
        const row = selectTask.get(taskId, profileId)
        if (!row) continue
        const subTasks = database.prepare(`
          SELECT * FROM sub_tasks WHERE task_id = ? ORDER BY position, created_at, id
        `).all(taskId).map(rowToSubTask)
        const task = rowToTask(row, subTasks)
        enqueueSyncMutation(
          'task',
          taskId,
          task.deletedAt ? 'delete' : 'upsert',
          task,
          taskBaseVersions.get(taskId),
        )
      }
      for (const [noteId, sync] of affectedDailyNotes) {
        const row = selectDailyNote.get(noteId, profileId)
        enqueueSyncMutation(
          'daily_note',
          noteId,
          sync.operation,
          row ? rowToDailyNote(row) : null,
          sync.baseVersion,
        )
      }

      purgeExpired()
      bumpStoreRevision()
    })
    return buildStore()
  }

  function readDiagnostics() {
    return {
      databasePath,
      schemaVersion: database.prepare('PRAGMA user_version').get().user_version,
      integrity: database.prepare('PRAGMA quick_check').get().quick_check,
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
      profileId,
      storeRevision: readStoreRevision(),
      migration: JSON.parse(getMeta.get('legacy_json_v1_migration')?.value || 'null'),
      migrationError: JSON.parse(getMeta.get('legacy_json_v1_error')?.value || 'null'),
    }
  }

  function close() {
    if (database.isOpen) database.close()
  }

  return {
    readStore,
    applyStoreMutations,
    // Runtime compatibility for already-built QA helpers; renderer types use only the new API.
    applyMutations: applyStoreMutations,
    readDiagnostics,
    close,
  }
}

module.exports = {
  RETENTION_MS,
  SCHEMA_VERSION,
  createDaylineDatabase,
  createSeedStore,
  sanitizeDailyNote,
  sanitizeSubTask,
  sanitizeTask,
}
