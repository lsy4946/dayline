const fs = require('node:fs')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = 30 * DAY_MS
const SCHEMA_VERSION = 4
const STORE_VERSION = 1
const UPDATE_CONSENT_META_KEY = 'pending_update_consent_v1'
const INSTALLED_RELEASE_HISTORY_META_KEY = 'installed_release_history_v1'
const MAX_UPDATE_VERSION_LENGTH = 128
const MAX_UPDATE_RELEASE_NAME_LENGTH = 200
const MAX_UPDATE_RELEASE_NOTES_LENGTH = 128 * 1024
const TASK_COLORS = new Set(['coral', 'violet', 'sage', 'blue', 'amber'])
const DEFAULT_APP_SETTINGS = Object.freeze({
  sidebarSplit: 50,
  widgetSplit: 50,
  fontScale: 1,
  themeColor: '#255F4B',
})
const BUILT_IN_TAG_DEFINITIONS = Object.freeze([
  { id: 'builtin-coral', name: '코랄', color: '#EF6F61', legacyColor: 'coral' },
  { id: 'builtin-violet', name: '바이올렛', color: '#8B6FD6', legacyColor: 'violet' },
  { id: 'builtin-sage', name: '세이지', color: '#6F9F7D', legacyColor: 'sage' },
  { id: 'builtin-blue', name: '블루', color: '#4F86C6', legacyColor: 'blue' },
  { id: 'builtin-amber', name: '앰버', color: '#D99A32', legacyColor: 'amber' },
  { id: 'builtin-rose', name: '로즈', color: '#D66787', legacyColor: null },
  { id: 'builtin-teal', name: '틸', color: '#3F9B96', legacyColor: null },
  { id: 'builtin-indigo', name: '인디고', color: '#5C6AC4', legacyColor: null },
  { id: 'builtin-slate', name: '슬레이트', color: '#718096', legacyColor: null },
])
const LEGACY_TAG_ID_BY_COLOR = Object.freeze({
  coral: 'builtin-coral',
  violet: 'builtin-violet',
  sage: 'builtin-sage',
  blue: 'builtin-blue',
  amber: 'builtin-amber',
})
const TASK_PATCHABLE_FIELDS = [
  'title',
  'note',
  'startDate',
  'dueDate',
  'dueTime',
  'color',
  'tagId',
  'position',
  'completed',
  'completedAt',
  'deletedAt',
  'previousCompleted',
  'updatedAt',
]
const TASK_COLUMN_BY_FIELD = {
  title: 'title',
  note: 'note',
  startDate: 'start_date',
  dueDate: 'due_date',
  dueTime: 'due_time',
  color: 'color',
  tagId: 'tag_id',
  position: 'position',
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
const DAILY_NOTE_PATCHABLE_FIELDS = ['content', 'noteDate', 'completed', 'completedAt', 'position', 'updatedAt']
const DAILY_NOTE_COLUMN_BY_FIELD = {
  content: 'content',
  noteDate: 'note_date',
  completed: 'completed',
  completedAt: 'completed_at',
  position: 'position',
  updatedAt: 'updated_at',
}
const TAG_PATCHABLE_FIELDS = ['name', 'color', 'position', 'updatedAt']
const TAG_COLUMN_BY_FIELD = {
  name: 'name',
  color: 'color',
  position: 'position',
  updatedAt: 'updated_at',
}
const TEMPLATE_PATCHABLE_FIELDS = [
  'title', 'note', 'dueTime', 'tagId', 'legacyColor', 'durationDays',
  'subTaskTitles', 'position', 'updatedAt',
]
const TEMPLATE_COLUMN_BY_FIELD = {
  title: 'title',
  note: 'note',
  dueTime: 'due_time',
  tagId: 'tag_id',
  legacyColor: 'legacy_color',
  durationDays: 'duration_days',
  subTaskTitles: 'sub_task_titles_json',
  position: 'position',
  updatedAt: 'updated_at',
}

function parseUpdateVersion(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_UPDATE_VERSION_LENGTH) return null
  const normalized = trimmed.replace(/^v/i, '')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(normalized)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : null
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null
  return {
    normalized,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  }
}

function compareUpdateVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1
    if (left.core[index] > right.core[index]) return 1
  }
  if (left.prerelease === null && right.prerelease !== null) return 1
  if (left.prerelease !== null && right.prerelease === null) return -1
  if (left.prerelease !== null && right.prerelease !== null) {
    const length = Math.max(left.prerelease.length, right.prerelease.length)
    for (let index = 0; index < length; index += 1) {
      const leftPart = left.prerelease[index]
      const rightPart = right.prerelease[index]
      if (leftPart === undefined) return -1
      if (rightPart === undefined) return 1
      if (leftPart === rightPart) continue
      const leftNumeric = /^\d+$/.test(leftPart)
      const rightNumeric = /^\d+$/.test(rightPart)
      if (leftNumeric && rightNumeric) {
        const leftNumber = BigInt(leftPart)
        const rightNumber = BigInt(rightPart)
        if (leftNumber < rightNumber) return -1
        if (leftNumber > rightNumber) return 1
      } else if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1
      } else {
        return leftPart < rightPart ? -1 : 1
      }
    }
  }
  return 0
}

function requireUpdateVersion(value, fieldName) {
  const version = parseUpdateVersion(value)
  if (!version) throw new TypeError(`${fieldName} must be a valid semantic version.`)
  return version
}

function requireUpdateTimestamp(value, fieldName, { nullable = false } = {}) {
  if (nullable && value == null) return null
  if (typeof value !== 'string' || !value || value.length > 64) {
    throw new TypeError(`${fieldName} must be a valid timestamp.`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${fieldName} must be a valid timestamp.`)
  return parsed.toISOString()
}

function normalizeUpdateReleaseName(value) {
  if (value == null) return null
  if (typeof value !== 'string') throw new TypeError('releaseName must be a string or null.')
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length > MAX_UPDATE_RELEASE_NAME_LENGTH) {
    throw new RangeError('releaseName is too long.')
  }
  return normalized
}

function requireUpdateReleaseNotes(value) {
  if (typeof value !== 'string') throw new TypeError('releaseNotes must be a string.')
  const normalized = value.trim()
  if (!normalized) throw new TypeError('releaseNotes must not be empty.')
  if (normalized.length > MAX_UPDATE_RELEASE_NOTES_LENGTH) {
    throw new RangeError('releaseNotes is too long.')
  }
  return normalized
}

function normalizeOptionalUpdateReleaseNotes(value) {
  return value == null ? null : requireUpdateReleaseNotes(value)
}

function parseMetaJson(rawValue) {
  if (typeof rawValue !== 'string') return null
  try {
    const value = JSON.parse(rawValue)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function sanitizeStoredUpdateConsent(rawValue) {
  const value = parseMetaJson(rawValue)
  if (!value || value.schema !== 1) return null
  try {
    const fromVersion = requireUpdateVersion(value.fromVersion, 'fromVersion')
    const targetVersion = requireUpdateVersion(value.targetVersion, 'targetVersion')
    if (compareUpdateVersions(fromVersion, targetVersion) >= 0) return null
    return {
      fromVersion: fromVersion.normalized,
      targetVersion: targetVersion.normalized,
      recordedAt: requireUpdateTimestamp(value.recordedAt, 'recordedAt'),
      releaseName: normalizeUpdateReleaseName(value.releaseName),
      releaseNotes: normalizeOptionalUpdateReleaseNotes(value.releaseNotes),
    }
  } catch {
    return null
  }
}

function sanitizeStoredInstalledReleaseHistory(rawValue) {
  const value = parseMetaJson(rawValue)
  if (!value || value.schema !== 1 || !['ready', 'notes-unavailable'].includes(value.state)) return null
  try {
    const targetVersion = requireUpdateVersion(value.targetVersion, 'targetVersion')
    const toVersion = requireUpdateVersion(value.toVersion, 'toVersion')
    if (compareUpdateVersions(targetVersion, toVersion) > 0) return null
    const fromVersion = value.fromVersion == null
      ? null
      : requireUpdateVersion(value.fromVersion, 'fromVersion')
    if (fromVersion && compareUpdateVersions(fromVersion, toVersion) >= 0) return null

    const recordedAt = requireUpdateTimestamp(value.recordedAt, 'recordedAt', { nullable: true })
    const completedAt = requireUpdateTimestamp(value.completedAt, 'completedAt', { nullable: true })
    if (fromVersion === null) {
      if (recordedAt !== null || completedAt !== null) return null
      if (targetVersion.normalized !== toVersion.normalized) return null
      if (value.state !== 'ready') return null
    } else if (recordedAt === null || completedAt === null) {
      return null
    }

    const releaseName = normalizeUpdateReleaseName(value.releaseName)
    const releaseNotes = value.state === 'ready'
      ? requireUpdateReleaseNotes(value.releaseNotes)
      : null
    if (value.state === 'notes-unavailable' && value.releaseNotes != null) return null
    return {
      state: value.state,
      fromVersion: fromVersion?.normalized ?? null,
      targetVersion: targetVersion.normalized,
      toVersion: toVersion.normalized,
      releaseName,
      releaseNotes,
      recordedAt,
      completedAt,
      verified: value.verified === true,
    }
  } catch {
    return null
  }
}

function storedUpdateValue(value) {
  return JSON.stringify({ schema: 1, ...value })
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
  const deletedAt = new Date(now.getTime() - 2 * DAY_MS).toISOString()
  const taskTags = BUILT_IN_TAG_DEFINITIONS.map((tag, position) => ({
    ...tag,
    builtIn: true,
    position,
    createdAt: nowIso,
    updatedAt: nowIso,
  }))

  return {
    version: STORE_VERSION,
    tasks: [
      {
        id: crypto.randomUUID(),
        title: 'Dayline 프로토타입 살펴보기',
        note: '기간 일정과 태그, 템플릿 기능을 확인해 보세요.',
        startDate: dateOffset(0, now),
        dueDate: dateOffset(0, now),
        dueTime: null,
        color: 'coral',
        tagId: 'builtin-coral',
        position: 0,
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
      },
      {
        id: crypto.randomUUID(),
        title: '오늘의 우선순위 정리',
        note: '',
        startDate: dateOffset(0, now),
        dueDate: dateOffset(0, now),
        dueTime: '10:30',
        color: 'violet',
        tagId: 'builtin-violet',
        position: 1,
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        subTasks: [],
      },
      {
        id: crypto.randomUUID(),
        title: '주간 계획 초안',
        note: '',
        startDate: dateOffset(0, now),
        dueDate: dateOffset(1, now),
        dueTime: null,
        color: 'blue',
        tagId: 'builtin-blue',
        position: 2,
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        subTasks: [],
      },
      {
        id: crypto.randomUUID(),
        title: '복구 기능 예시 일정',
        note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        startDate: dateOffset(-3, now),
        dueDate: dateOffset(-3, now),
        dueTime: null,
        color: 'blue',
        tagId: 'builtin-blue',
        position: 3,
        completed: true,
        completedAt: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
        deletedAt,
        previousCompleted: true,
        createdAt: new Date(now.getTime() - 6 * DAY_MS).toISOString(),
        updatedAt: deletedAt,
        subTasks: [],
      },
    ],
    dailyNotes: [
      {
        id: crypto.randomUUID(),
        content: '떠오른 할 일을 여기에 바로 적어 보세요.',
        noteDate: dateOffset(0, now),
        completed: false,
        completedAt: null,
        position: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ],
    taskTags,
    settings: { ...DEFAULT_APP_SETTINGS },
    taskTemplates: [
      {
        id: crypto.randomUUID(),
        title: '주간 계획',
        note: '',
        dueTime: null,
        tagId: 'builtin-blue',
        legacyColor: 'blue',
        durationDays: 7,
        subTaskTitles: ['목표 정리', '진행 상황 확인'],
        position: 0,
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

function validPosition(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeHex(value, fallback = '#718096') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : fallback
}

function clampNumber(value, minimum, maximum, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function sanitizeSettings(settings) {
  const value = settings && typeof settings === 'object' ? settings : {}
  return {
    sidebarSplit: clampNumber(value.sidebarSplit, 20, 80, DEFAULT_APP_SETTINGS.sidebarSplit),
    widgetSplit: clampNumber(value.widgetSplit, 20, 80, DEFAULT_APP_SETTINGS.widgetSplit),
    fontScale: clampNumber(value.fontScale, 0.85, 1.5, DEFAULT_APP_SETTINGS.fontScale),
    themeColor: normalizeHex(value.themeColor, DEFAULT_APP_SETTINGS.themeColor),
  }
}

function sanitizeTaskTag(tag, now = new Date(), fallbackPosition = 0) {
  if (!tag || typeof tag !== 'object') return null
  if (typeof tag.id !== 'string' || tag.id.length < 1 || tag.id.length > 128) return null
  if (typeof tag.name !== 'string' || tag.name.trim().length < 1) return null
  const nowIso = now.toISOString()
  const definition = BUILT_IN_TAG_DEFINITIONS.find((value) => value.id === tag.id)
  return {
    id: tag.id,
    name: tag.name.trim().slice(0, 80),
    color: normalizeHex(tag.color, definition?.color),
    builtIn: Boolean(definition),
    legacyColor: definition?.legacyColor ?? null,
    position: validPosition(tag.position, fallbackPosition),
    createdAt: normalizeTimestamp(tag.createdAt, nowIso),
    updatedAt: normalizeTimestamp(tag.updatedAt, nowIso),
  }
}

function sanitizeTaskTemplate(template, now = new Date(), fallbackPosition = 0) {
  if (!template || typeof template !== 'object') return null
  if (typeof template.id !== 'string' || template.id.length < 1 || template.id.length > 128) return null
  if (typeof template.title !== 'string' || template.title.trim().length < 1) return null
  const nowIso = now.toISOString()
  const legacyColor = TASK_COLORS.has(template.legacyColor) ? template.legacyColor : 'coral'
  return {
    id: template.id,
    title: template.title.trim().slice(0, 240),
    note: typeof template.note === 'string' ? template.note.slice(0, 2000) : '',
    dueTime: typeof template.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(template.dueTime)
      ? template.dueTime
      : null,
    tagId: typeof template.tagId === 'string' && template.tagId.length <= 128
      ? template.tagId
      : Object.prototype.hasOwnProperty.call(template, 'tagId')
        ? null
        : LEGACY_TAG_ID_BY_COLOR[legacyColor],
    legacyColor,
    durationDays: Math.max(1, validPosition(template.durationDays, 1)),
    subTaskTitles: Array.isArray(template.subTaskTitles)
      ? template.subTaskTitles
        .filter((title) => typeof title === 'string' && title.trim().length > 0)
        .slice(0, 500)
        .map((title) => title.trim().slice(0, 240))
      : [],
    position: validPosition(template.position, fallbackPosition),
    createdAt: normalizeTimestamp(template.createdAt, nowIso),
    updatedAt: normalizeTimestamp(template.updatedAt, nowIso),
  }
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

function sanitizeTask(task, now = new Date(), fallbackPosition = 0) {
  if (!task || typeof task !== 'object') return null
  if (typeof task.id !== 'string' || task.id.length < 1 || task.id.length > 128) return null
  if (typeof task.title !== 'string' || task.title.trim().length < 1) return null
  if (!isDateKey(task.dueDate)) return null

  const nowIso = now.toISOString()
  const validStartDate = isDateKey(task.startDate) ? task.startDate : task.dueDate
  if (validStartDate > task.dueDate) return null
  const startDate = validStartDate
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
    startDate,
    dueDate: task.dueDate,
    dueTime: typeof task.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime)
      ? task.dueTime
      : null,
    color: TASK_COLORS.has(task.color) ? task.color : 'coral',
    tagId: typeof task.tagId === 'string' && task.tagId.length <= 128
      ? task.tagId
      : Object.prototype.hasOwnProperty.call(task, 'tagId')
        ? null
        : LEGACY_TAG_ID_BY_COLOR[TASK_COLORS.has(task.color) ? task.color : 'coral'],
    position: validPosition(task.position, fallbackPosition),
    completed,
    completedAt,
    deletedAt,
    previousCompleted: typeof task.previousCompleted === 'boolean' ? task.previousCompleted : null,
    createdAt: normalizeTimestamp(task.createdAt, nowIso),
    updatedAt: normalizeTimestamp(task.updatedAt, nowIso),
    subTasks,
  }
}

function sanitizeDailyNote(note, now = new Date(), fallbackPosition = 0) {
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
    position: validPosition(note.position, fallbackPosition),
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
    startDate: row.start_date,
    dueDate: row.due_date,
    dueTime: row.due_time,
    color: row.color,
    tagId: row.tag_id,
    position: row.position,
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
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTaskTag(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    builtIn: row.built_in === 1,
    legacyColor: row.legacy_color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSettings(row) {
  return row
    ? {
        sidebarSplit: row.sidebar_split,
        widgetSplit: row.widget_split,
        fontScale: row.font_scale,
        themeColor: row.theme_color,
      }
    : { ...DEFAULT_APP_SETTINGS }
}

function rowToTaskTemplate(row) {
  let subTaskTitles = []
  try {
    const parsed = JSON.parse(row.sub_task_titles_json)
    if (Array.isArray(parsed)) subTaskTitles = parsed.filter((title) => typeof title === 'string')
  } catch {
    // Invalid template child data is isolated to that template.
  }
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    dueTime: row.due_time,
    tagId: row.tag_id,
    legacyColor: row.legacy_color,
    durationDays: row.duration_days,
    subTaskTitles,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sqliteValue(field, value) {
  if (field === 'completed') return value ? 1 : 0
  if (field === 'previousCompleted') return value == null ? null : value ? 1 : 0
  if (field === 'subTaskTitles') return JSON.stringify(value)
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

function tableHasColumn(database, tableName, columnName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName)
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

  if (currentVersion < 3) {
    inTransaction(database, () => {
      database.exec(`
        ALTER TABLE sync_outbox RENAME TO sync_outbox_v2;
        CREATE TABLE sync_outbox (
          mutation_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL CHECK (
            entity_type IN ('task', 'daily_note', 'task_tag', 'task_template', 'app_settings')
          ),
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
        FROM sync_outbox_v2;
        DROP TABLE sync_outbox_v2;

        CREATE TABLE IF NOT EXISTS task_tags (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
          color TEXT NOT NULL CHECK (
            length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
          ),
          built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
          legacy_color TEXT CHECK (
            legacy_color IS NULL OR legacy_color IN ('coral', 'violet', 'sage', 'blue', 'amber')
          ),
          position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_task_tags_position
          ON task_tags(profile_id, position, created_at, id);

        CREATE TABLE IF NOT EXISTS app_settings (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          sidebar_split REAL NOT NULL CHECK (sidebar_split BETWEEN 20 AND 80),
          widget_split REAL NOT NULL CHECK (widget_split BETWEEN 20 AND 80),
          font_scale REAL NOT NULL CHECK (font_scale BETWEEN 0.85 AND 1.3),
          theme_color TEXT NOT NULL CHECK (
            length(theme_color) = 7 AND theme_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
          ),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS task_templates (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
          note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
          due_time TEXT CHECK (
            due_time IS NULL OR (
              due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(due_time, 1, 2) <= '23'
            )
          ),
          tag_id TEXT REFERENCES task_tags(id) ON DELETE SET NULL,
          legacy_color TEXT NOT NULL CHECK (legacy_color IN ('coral', 'violet', 'sage', 'blue', 'amber')),
          duration_days INTEGER NOT NULL DEFAULT 1 CHECK (duration_days >= 1),
          sub_task_titles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sub_task_titles_json)),
          position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_task_templates_position
          ON task_templates(profile_id, position, created_at, id);
      `)

      if (!tableHasColumn(database, 'tasks', 'start_date')) {
        database.exec(`
          ALTER TABLE tasks ADD COLUMN start_date TEXT NOT NULL DEFAULT '1970-01-01'
          CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
        `)
      }
      if (!tableHasColumn(database, 'tasks', 'position')) {
        database.exec('ALTER TABLE tasks ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0)')
      }
      if (!tableHasColumn(database, 'tasks', 'tag_id')) {
        database.exec('ALTER TABLE tasks ADD COLUMN tag_id TEXT REFERENCES task_tags(id) ON DELETE SET NULL')
      }
      if (!tableHasColumn(database, 'daily_notes', 'position')) {
        database.exec('ALTER TABLE daily_notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0)')
      }

      database.exec(`
        UPDATE tasks SET start_date = due_date
        WHERE start_date IS NULL OR start_date = '1970-01-01';
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at, id) - 1 AS next_position
          FROM tasks
        )
        UPDATE tasks
        SET position = (SELECT next_position FROM ranked WHERE ranked.id = tasks.id);
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY profile_id, note_date ORDER BY created_at, id
          ) - 1 AS next_position
          FROM daily_notes
        )
        UPDATE daily_notes
        SET position = (SELECT next_position FROM ranked WHERE ranked.id = daily_notes.id);
        CREATE INDEX IF NOT EXISTS idx_tasks_range
          ON tasks(profile_id, start_date, due_date, position) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_position
          ON tasks(profile_id, position, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_daily_notes_position
          ON daily_notes(profile_id, note_date, position, created_at, id);
      `)
      database.prepare(`
        INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)
        ON CONFLICT(version) DO NOTHING
      `).run(appliedAt)
      database.exec('PRAGMA user_version = 3')
    })
  }

  if (currentVersion < 4) {
    inTransaction(database, () => {
      database.exec(`
        ALTER TABLE app_settings RENAME TO app_settings_v3;
        CREATE TABLE app_settings (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          sidebar_split REAL NOT NULL CHECK (sidebar_split BETWEEN 20 AND 80),
          widget_split REAL NOT NULL CHECK (widget_split BETWEEN 20 AND 80),
          font_scale REAL NOT NULL CHECK (font_scale BETWEEN 0.85 AND 1.5),
          theme_color TEXT NOT NULL CHECK (
            length(theme_color) = 7 AND theme_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
          ),
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO app_settings (
          profile_id, sidebar_split, widget_split, font_scale, theme_color, updated_at
        )
        SELECT profile_id, sidebar_split, widget_split, font_scale, theme_color, updated_at
        FROM app_settings_v3;
        DROP TABLE app_settings_v3;
      `)
      database.prepare(`
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)
        ON CONFLICT(version) DO NOTHING
      `).run(appliedAt)
      database.exec('PRAGMA user_version = 4')
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

function knownTagId(database, profileId, value) {
  if (typeof value !== 'string') return null
  return database.prepare('SELECT id FROM task_tags WHERE id = ? AND profile_id = ?').get(value, profileId)?.id || null
}

function insertTask(database, profileId, task) {
  const inserted = Number(database.prepare(`
    INSERT INTO tasks (
      id, profile_id, title, note, start_date, due_date, due_time, color, tag_id, position,
      completed, completed_at, deleted_at, previous_completed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    task.id,
    profileId,
    task.title,
    task.note,
    task.startDate,
    task.dueDate,
    task.dueTime,
    task.color,
    knownTagId(database, profileId, task.tagId),
    task.position,
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
      id, profile_id, content, note_date, completed, completed_at, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    note.id,
    profileId,
    note.content,
    note.noteDate,
    note.completed ? 1 : 0,
    note.completedAt,
    note.position,
    note.createdAt,
    note.updatedAt,
  ).changes)
}

function insertTaskTag(database, profileId, tag, replaceMutable = false) {
  const conflictClause = replaceMutable
    ? `DO UPDATE SET
        name = excluded.name,
        color = excluded.color,
        position = excluded.position,
        updated_at = excluded.updated_at,
        row_version = task_tags.row_version + 1`
    : 'DO NOTHING'
  return Number(database.prepare(`
    INSERT INTO task_tags (
      id, profile_id, name, color, built_in, legacy_color, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) ${conflictClause}
  `).run(
    tag.id,
    profileId,
    tag.name,
    tag.color,
    tag.builtIn ? 1 : 0,
    tag.legacyColor,
    tag.position,
    tag.createdAt,
    tag.updatedAt,
  ).changes)
}

function insertTaskTemplate(database, profileId, template) {
  return Number(database.prepare(`
    INSERT INTO task_templates (
      id, profile_id, title, note, due_time, tag_id, legacy_color,
      duration_days, sub_task_titles_json, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    template.id,
    profileId,
    template.title,
    template.note,
    template.dueTime,
    knownTagId(database, profileId, template.tagId),
    template.legacyColor,
    template.durationDays,
    JSON.stringify(template.subTaskTitles),
    template.position,
    template.createdAt,
    template.updatedAt,
  ).changes)
}

function upsertSettings(database, profileId, settings, updatedAt) {
  database.prepare(`
    INSERT INTO app_settings (
      profile_id, sidebar_split, widget_split, font_scale, theme_color, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      sidebar_split = excluded.sidebar_split,
      widget_split = excluded.widget_split,
      font_scale = excluded.font_scale,
      theme_color = excluded.theme_color,
      updated_at = excluded.updated_at
  `).run(
    profileId,
    settings.sidebarSplit,
    settings.widgetSplit,
    settings.fontScale,
    settings.themeColor,
    updatedAt,
  )
}

function ensureProfileV3Defaults(database, profileId, timestamp, assignLegacyTaskTags = false) {
  for (const [position, definition] of BUILT_IN_TAG_DEFINITIONS.entries()) {
    insertTaskTag(database, profileId, {
      ...definition,
      builtIn: true,
      position,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }
  database.prepare(`
    INSERT INTO app_settings (
      profile_id, sidebar_split, widget_split, font_scale, theme_color, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO NOTHING
  `).run(
    profileId,
    DEFAULT_APP_SETTINGS.sidebarSplit,
    DEFAULT_APP_SETTINGS.widgetSplit,
    DEFAULT_APP_SETTINGS.fontScale,
    DEFAULT_APP_SETTINGS.themeColor,
    timestamp,
  )
  if (assignLegacyTaskTags) {
    for (const [legacyColor, tagId] of Object.entries(LEGACY_TAG_ID_BY_COLOR)) {
      database.prepare(`
        UPDATE tasks SET tag_id = ?
        WHERE profile_id = ? AND tag_id IS NULL AND color = ?
      `).run(tagId, profileId, legacyColor)
    }
  }
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

  function recordUpdateConsent(
    fromVersionValue,
    targetVersionValue,
    recordedAtValue,
    releaseNameValue = null,
    releaseNotesValue = null,
  ) {
    const fromVersion = requireUpdateVersion(fromVersionValue, 'fromVersion')
    const targetVersion = requireUpdateVersion(targetVersionValue, 'targetVersion')
    if (compareUpdateVersions(fromVersion, targetVersion) >= 0) {
      throw new RangeError('targetVersion must be newer than fromVersion.')
    }
    const consent = {
      fromVersion: fromVersion.normalized,
      targetVersion: targetVersion.normalized,
      recordedAt: requireUpdateTimestamp(recordedAtValue, 'recordedAt'),
      releaseName: normalizeUpdateReleaseName(releaseNameValue),
      releaseNotes: normalizeOptionalUpdateReleaseNotes(releaseNotesValue),
    }
    inTransaction(database, () => {
      const existing = sanitizeStoredUpdateConsent(getMeta.get(UPDATE_CONSENT_META_KEY)?.value)
      if (
        existing
        && existing.fromVersion === consent.fromVersion
        && existing.targetVersion === consent.targetVersion
      ) {
        consent.recordedAt = existing.recordedAt
        consent.releaseName = consent.releaseName || existing.releaseName
        consent.releaseNotes = consent.releaseNotes || existing.releaseNotes
      }
      setMeta.run(UPDATE_CONSENT_META_KEY, storedUpdateValue(consent))
    })
    return { ...consent }
  }

  function reconcileUpdateHistory(currentVersionValue, completedAtValue) {
    const currentVersion = requireUpdateVersion(currentVersionValue, 'currentVersion')
    const completedAt = requireUpdateTimestamp(completedAtValue, 'completedAt')
    let installedHistory = null
    inTransaction(database, () => {
      const rawConsent = getMeta.get(UPDATE_CONSENT_META_KEY)?.value
      const consent = sanitizeStoredUpdateConsent(rawConsent)
      if (!consent) {
        if (rawConsent != null) deleteMeta.run(UPDATE_CONSENT_META_KEY)
        return
      }
      const fromVersion = requireUpdateVersion(consent.fromVersion, 'fromVersion')
      const targetVersion = requireUpdateVersion(consent.targetVersion, 'targetVersion')
      if (
        compareUpdateVersions(targetVersion, currentVersion) > 0
        || compareUpdateVersions(fromVersion, currentVersion) >= 0
      ) return

      installedHistory = {
        state: compareUpdateVersions(targetVersion, currentVersion) === 0 && consent.releaseNotes
          ? 'ready'
          : 'notes-unavailable',
        fromVersion: fromVersion.normalized,
        targetVersion: targetVersion.normalized,
        toVersion: currentVersion.normalized,
        releaseName: compareUpdateVersions(targetVersion, currentVersion) === 0 && consent.releaseNotes
          ? consent.releaseName
          : null,
        releaseNotes: compareUpdateVersions(targetVersion, currentVersion) === 0
          ? consent.releaseNotes
          : null,
        recordedAt: consent.recordedAt,
        completedAt,
        verified: false,
      }
      setMeta.run(INSTALLED_RELEASE_HISTORY_META_KEY, storedUpdateValue(installedHistory))
      deleteMeta.run(UPDATE_CONSENT_META_KEY)
    })
    return installedHistory ? { ...installedHistory } : null
  }

  function saveInstalledReleaseNotes(historyValue) {
    if (!historyValue || typeof historyValue !== 'object' || Array.isArray(historyValue)) {
      throw new TypeError('history must be an installed release history object.')
    }
    if (historyValue.state != null && historyValue.state !== 'ready') {
      throw new TypeError('history.state must be ready.')
    }
    const fromVersion = historyValue.fromVersion == null
      ? null
      : requireUpdateVersion(historyValue.fromVersion, 'fromVersion')
    const targetVersion = requireUpdateVersion(historyValue.targetVersion, 'targetVersion')
    const toVersion = requireUpdateVersion(historyValue.toVersion, 'toVersion')
    if (compareUpdateVersions(targetVersion, toVersion) > 0) {
      throw new RangeError('targetVersion must not be newer than toVersion.')
    }
    if (fromVersion && compareUpdateVersions(fromVersion, toVersion) >= 0) {
      throw new RangeError('fromVersion must be older than toVersion.')
    }
    const releaseName = normalizeUpdateReleaseName(historyValue.releaseName)
    const releaseNotes = requireUpdateReleaseNotes(historyValue.releaseNotes)
    const recordedAt = requireUpdateTimestamp(historyValue.recordedAt, 'recordedAt', { nullable: true })

    let savedHistory = null
    inTransaction(database, () => {
      const existing = sanitizeStoredInstalledReleaseHistory(
        getMeta.get(INSTALLED_RELEASE_HISTORY_META_KEY)?.value,
      )
      if (existing) {
        const normalizedFromVersion = fromVersion?.normalized ?? null
        if (
          normalizedFromVersion !== existing.fromVersion
          || toVersion.normalized !== existing.toVersion
          || recordedAt !== existing.recordedAt
        ) {
          throw new Error('Release notes do not match the installed update history.')
        }
        savedHistory = {
          ...existing,
          state: 'ready',
          releaseName,
          releaseNotes,
          verified: true,
        }
      } else {
        const completedAt = requireUpdateTimestamp(historyValue.completedAt, 'completedAt', { nullable: true })
        if (
          fromVersion !== null
          || targetVersion.normalized !== toVersion.normalized
          || recordedAt !== null
          || completedAt !== null
        ) {
          throw new Error('A release-note baseline must describe only the current version.')
        }
        savedHistory = {
          state: 'ready',
          fromVersion: null,
          targetVersion: targetVersion.normalized,
          toVersion: toVersion.normalized,
          releaseName,
          releaseNotes,
          recordedAt: null,
          completedAt: null,
          verified: true,
        }
      }
      setMeta.run(INSTALLED_RELEASE_HISTORY_META_KEY, storedUpdateValue(savedHistory))
    })
    return { ...savedHistory }
  }

  function readInstalledReleaseHistory() {
    const history = sanitizeStoredInstalledReleaseHistory(
      getMeta.get(INSTALLED_RELEASE_HISTORY_META_KEY)?.value,
    )
    return history ? { ...history } : null
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

  const v3DefaultsMetaKey = `store_v3_profile_defaults:${profileId}`
  if (!getMeta.get(v3DefaultsMetaKey)) {
    inTransaction(database, () => {
      ensureProfileV3Defaults(database, profileId, openedAt, true)
      setMeta.run(v3DefaultsMetaKey, openedAt)
      bumpStoreRevision()
    })
  } else {
    inTransaction(database, () => ensureProfileV3Defaults(database, profileId, openedAt))
  }

  if (!getMeta.get('legacy_json_v1_migration')) {
    const priorMigrationErrorRaw = getMeta.get('legacy_json_v1_error')?.value
    const hasExistingContent = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM tasks WHERE profile_id = ?',
    ).get(profileId).count) > 0 || Number(database.prepare(
      'SELECT COUNT(*) AS count FROM daily_notes WHERE profile_id = ?',
    ).get(profileId).count) > 0 || Number(database.prepare(
      'SELECT COUNT(*) AS count FROM task_templates WHERE profile_id = ?',
    ).get(profileId).count) > 0
    let source = 'seeded'
    let tasks = []
    let dailyNotes = []
    let taskTags = []
    let settings = null
    let taskTemplates = []
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
          .map((task, index) => sanitizeTask(task, now(), index))
          .filter((task) => {
            if (!task) rejectedCount += 1
            return Boolean(task)
          })
          .filter((task) => isRecoverableTask(task, now().getTime()))
        const notePositionsByDate = new Map()
        dailyNotes = (Array.isArray(parsed.dailyNotes) ? parsed.dailyNotes : [])
          .map((note) => {
            const noteDate = typeof note?.noteDate === 'string' ? note.noteDate : ''
            const position = notePositionsByDate.get(noteDate) || 0
            notePositionsByDate.set(noteDate, position + 1)
            return sanitizeDailyNote(note, now(), position)
          })
          .filter((note) => {
            if (!note) rejectedDailyNoteCount += 1
            return Boolean(note)
          })
        taskTags = (Array.isArray(parsed.taskTags) ? parsed.taskTags : [])
          .map((tag, index) => sanitizeTaskTag(tag, now(), index))
          .filter(Boolean)
        settings = parsed.settings && typeof parsed.settings === 'object'
          ? sanitizeSettings(parsed.settings)
          : null
        taskTemplates = (Array.isArray(parsed.taskTemplates) ? parsed.taskTemplates : [])
          .map((template, index) => sanitizeTaskTemplate(template, now(), index))
          .filter(Boolean)
        source = 'imported'
        backupPath = `${legacyJsonPath}.pre-sqlite-backup`
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(legacyJsonPath, backupPath, fs.constants.COPYFILE_EXCL)
        }
      } catch (error) {
        tasks = []
        dailyNotes = []
        taskTags = []
        settings = null
        taskTemplates = []
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
      taskTemplates = seed.taskTemplates
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
        for (const tag of taskTags) insertTaskTag(database, profileId, tag, true)
        if (settings) upsertSettings(database, profileId, settings, now().toISOString())
        for (const task of tasks) insertTask(database, profileId, task)
        for (const note of dailyNotes) insertDailyNote(database, profileId, note)
        for (const template of taskTemplates) insertTaskTemplate(database, profileId, template)
        setMeta.run('legacy_json_v1_migration', JSON.stringify({
          status: source,
          importedAt: now().toISOString(),
          importedCount: tasks.length,
          importedDailyNoteCount: dailyNotes.length,
          importedTagCount: taskTags.length,
          importedTemplateCount: taskTemplates.length,
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
  const selectTasks = database.prepare('SELECT * FROM tasks WHERE profile_id = ? ORDER BY position, created_at, id')
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
    SELECT * FROM daily_notes WHERE profile_id = ? ORDER BY note_date, position, created_at, id
  `)
  const selectDailyNote = database.prepare('SELECT * FROM daily_notes WHERE id = ? AND profile_id = ?')
  const selectTaskTags = database.prepare(`
    SELECT * FROM task_tags WHERE profile_id = ? ORDER BY position, created_at, id
  `)
  const selectTaskTag = database.prepare('SELECT * FROM task_tags WHERE id = ? AND profile_id = ?')
  const selectSettings = database.prepare('SELECT * FROM app_settings WHERE profile_id = ?')
  const selectTaskTemplates = database.prepare(`
    SELECT * FROM task_templates WHERE profile_id = ? ORDER BY position, created_at, id
  `)
  const selectTaskTemplate = database.prepare('SELECT * FROM task_templates WHERE id = ? AND profile_id = ?')
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
      taskTags: selectTaskTags.all(profileId).map(rowToTaskTag),
      settings: rowToSettings(selectSettings.get(profileId)),
      taskTemplates: selectTaskTemplates.all(profileId).map(rowToTaskTemplate),
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
    const orderedMutations = [
      ...mutations.filter((mutation) => mutation?.type === 'tag:create'),
      ...mutations.filter((mutation) => mutation?.type !== 'tag:create'),
    ]
    inTransaction(database, () => {
      const affectedTaskIds = new Set()
      const taskBaseVersions = new Map()
      const affectedDailyNotes = new Map()
      const affectedTags = new Map()
      const affectedTemplates = new Map()
      let settingsAffected = false
      const syncState = profileKind.get(profileId)?.kind === 'linked' ? 'pending' : 'local_only'

      const markTask = (taskId, serverVersion) => {
        affectedTaskIds.add(taskId)
        if (!taskBaseVersions.has(taskId)) taskBaseVersions.set(taskId, serverVersion ?? null)
      }

      for (const rawMutation of orderedMutations) {
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
          if (requestedFields.includes('startDate') || requestedFields.includes('dueDate')) {
            const nextStartDate = requestedFields.includes('startDate')
              ? mutation.changes.startDate
              : currentTask.startDate
            const nextDueDate = requestedFields.includes('dueDate')
              ? mutation.changes.dueDate
              : currentTask.dueDate
            if (!isDateKey(nextStartDate) || !isDateKey(nextDueDate) || nextStartDate > nextDueDate) {
              const error = new Error('Invalid Dayline task date range')
              error.code = 'DAYLINE_INVALID_TASK_RANGE'
              throw error
            }
          }
          const normalized = sanitizeTask({ ...currentTask, ...mutation.changes }, now())
          if (!normalized) continue
          if (requestedFields.includes('tagId')) {
            normalized.tagId = knownTagId(database, profileId, normalized.tagId)
          }
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
          continue
        }

        if (mutation.type === 'tag:create') {
          const tag = sanitizeTaskTag(mutation.tag, now())
          if (!tag || tag.builtIn) continue
          if (insertTaskTag(database, profileId, { ...tag, builtIn: false, legacyColor: null }) > 0) {
            affectedTags.set(tag.id, 'upsert')
          }
          continue
        }

        if (mutation.type === 'tag:patch' && typeof mutation.id === 'string') {
          const row = selectTaskTag.get(mutation.id, profileId)
          if (!row || !mutation.changes || typeof mutation.changes !== 'object') continue
          const requestedFields = TAG_PATCHABLE_FIELDS.filter((field) =>
            Object.prototype.hasOwnProperty.call(mutation.changes, field),
          )
          if (requestedFields.length === 0) continue
          const normalized = sanitizeTaskTag({ ...rowToTaskTag(row), ...mutation.changes }, now(), row.position)
          if (!normalized) continue
          const assignments = requestedFields.map((field) => `${TAG_COLUMN_BY_FIELD[field]} = ?`)
          const values = requestedFields.map((field) => normalized[field])
          const updated = Number(database.prepare(`
            UPDATE task_tags
            SET ${assignments.join(', ')}, row_version = row_version + 1
            WHERE id = ? AND profile_id = ?
          `).run(...values, mutation.id, profileId).changes)
          if (updated > 0) affectedTags.set(mutation.id, 'upsert')
          continue
        }

        if (mutation.type === 'tag:delete' && typeof mutation.id === 'string') {
          const tag = selectTaskTag.get(mutation.id, profileId)
          if (!tag || tag.built_in === 1) continue
          const referencedTasks = database.prepare(`
            SELECT id, server_version FROM tasks WHERE profile_id = ? AND tag_id = ?
          `).all(profileId, mutation.id)
          const referencedTemplates = database.prepare(`
            SELECT id FROM task_templates WHERE profile_id = ? AND tag_id = ?
          `).all(profileId, mutation.id)
          const deleted = Number(database.prepare(`
            DELETE FROM task_tags WHERE id = ? AND profile_id = ? AND built_in = 0
          `).run(mutation.id, profileId).changes)
          if (deleted > 0) affectedTags.set(mutation.id, 'delete')
          if (deleted > 0 && referencedTasks.length > 0) {
            const timestamp = now().toISOString()
            for (const task of referencedTasks) {
              database.prepare(`
                UPDATE tasks
                SET updated_at = ?, row_version = row_version + 1, sync_state = ?
                WHERE id = ? AND profile_id = ?
              `).run(timestamp, syncState, task.id, profileId)
              markTask(task.id, task.server_version)
            }
          }
          if (deleted > 0 && referencedTemplates.length > 0) {
            const timestamp = now().toISOString()
            for (const template of referencedTemplates) {
              database.prepare(`
                UPDATE task_templates
                SET updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND profile_id = ?
              `).run(timestamp, template.id, profileId)
              affectedTemplates.set(template.id, 'upsert')
            }
          }
          continue
        }

        if (mutation.type === 'settings:patch' && mutation.changes && typeof mutation.changes === 'object') {
          const current = rowToSettings(selectSettings.get(profileId))
          const settings = sanitizeSettings({ ...current, ...mutation.changes })
          upsertSettings(database, profileId, settings, now().toISOString())
          settingsAffected = true
          continue
        }

        if (mutation.type === 'template:create') {
          const template = sanitizeTaskTemplate(mutation.template, now())
          if (!template) continue
          template.tagId = knownTagId(database, profileId, template.tagId)
          if (insertTaskTemplate(database, profileId, template) > 0) {
            affectedTemplates.set(template.id, 'upsert')
          }
          continue
        }

        if (mutation.type === 'template:patch' && typeof mutation.id === 'string') {
          const row = selectTaskTemplate.get(mutation.id, profileId)
          if (!row || !mutation.changes || typeof mutation.changes !== 'object') continue
          const requestedFields = TEMPLATE_PATCHABLE_FIELDS.filter((field) =>
            Object.prototype.hasOwnProperty.call(mutation.changes, field),
          )
          if (requestedFields.length === 0) continue
          const normalized = sanitizeTaskTemplate(
            { ...rowToTaskTemplate(row), ...mutation.changes },
            now(),
            row.position,
          )
          if (!normalized) continue
          if (requestedFields.includes('tagId')) {
            normalized.tagId = knownTagId(database, profileId, normalized.tagId)
          }
          const assignments = requestedFields.map((field) => `${TEMPLATE_COLUMN_BY_FIELD[field]} = ?`)
          const values = requestedFields.map((field) => sqliteValue(field, normalized[field]))
          const updated = Number(database.prepare(`
            UPDATE task_templates
            SET ${assignments.join(', ')}, row_version = row_version + 1
            WHERE id = ? AND profile_id = ?
          `).run(...values, mutation.id, profileId).changes)
          if (updated > 0) affectedTemplates.set(mutation.id, 'upsert')
          continue
        }

        if (mutation.type === 'template:delete' && typeof mutation.id === 'string') {
          const deleted = Number(database.prepare('DELETE FROM task_templates WHERE id = ? AND profile_id = ?')
            .run(mutation.id, profileId).changes)
          if (deleted > 0) affectedTemplates.set(mutation.id, 'delete')
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

      // Referenced tag rows must reach a future server before tasks/templates that use them.
      for (const [tagId, operation] of affectedTags) {
        if (operation !== 'upsert') continue
        const row = selectTaskTag.get(tagId, profileId)
        enqueueSyncMutation('task_tag', tagId, 'upsert', row ? rowToTaskTag(row) : null, null)
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
      for (const [templateId, operation] of affectedTemplates) {
        const row = selectTaskTemplate.get(templateId, profileId)
        enqueueSyncMutation(
          'task_template',
          templateId,
          operation,
          row ? rowToTaskTemplate(row) : null,
          null,
        )
      }
      // Tag deletes follow all payloads that clear their references.
      for (const [tagId, operation] of affectedTags) {
        if (operation === 'delete') enqueueSyncMutation('task_tag', tagId, 'delete', null, null)
      }
      if (settingsAffected) {
        enqueueSyncMutation(
          'app_settings',
          profileId,
          'upsert',
          rowToSettings(selectSettings.get(profileId)),
          null,
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
    recordUpdateConsent,
    reconcileUpdateHistory,
    saveInstalledReleaseNotes,
    readInstalledReleaseHistory,
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
