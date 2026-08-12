import type {
  AppSettings,
  AppSettingsPatch,
  DailyNote,
  DailyNotePatch,
  DaylineStore,
  StoreMutation,
  SubTask,
  SubTaskPatch,
  Task,
  TaskColor,
  TaskPatch,
  TaskTag,
  TaskTagPatch,
  TaskTemplate,
  TaskTemplatePatch,
} from '../types'
import { addDaysKey, isDateKey, todayKey } from '../domain/date'
import { purgeExpired } from '../domain/tasks'

const BROWSER_STORAGE_KEY = 'dayline-browser-store-v1'
const TASK_COLORS = new Set<TaskColor>(['coral', 'violet', 'sage', 'blue', 'amber'])

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sidebarSplit: 50,
  widgetSplit: 50,
  fontScale: 1,
  themeColor: '#255F4B',
}

const BUILT_IN_TAG_DEFINITIONS: Array<Pick<TaskTag, 'id' | 'name' | 'color' | 'legacyColor'>> = [
  { id: 'builtin-coral', name: '코랄', color: '#EF6F61', legacyColor: 'coral' },
  { id: 'builtin-violet', name: '바이올렛', color: '#8B6FD6', legacyColor: 'violet' },
  { id: 'builtin-sage', name: '세이지', color: '#6F9F7D', legacyColor: 'sage' },
  { id: 'builtin-blue', name: '블루', color: '#4F86C6', legacyColor: 'blue' },
  { id: 'builtin-amber', name: '앰버', color: '#D99A32', legacyColor: 'amber' },
  { id: 'builtin-rose', name: '로즈', color: '#D66787', legacyColor: null },
  { id: 'builtin-teal', name: '틸', color: '#3F9B96', legacyColor: null },
  { id: 'builtin-indigo', name: '인디고', color: '#5C6AC4', legacyColor: null },
  { id: 'builtin-slate', name: '슬레이트', color: '#718096', legacyColor: null },
]

export const LEGACY_TAG_ID_BY_COLOR: Record<TaskColor, string> = {
  coral: 'builtin-coral',
  violet: 'builtin-violet',
  sage: 'builtin-sage',
  blue: 'builtin-blue',
  amber: 'builtin-amber',
}

const MUTABLE_TASK_FIELDS = [
  'title', 'note', 'startDate', 'dueDate', 'dueTime', 'color', 'tagId', 'position',
  'completed', 'completedAt', 'deletedAt', 'previousCompleted', 'updatedAt',
] as const
const MUTABLE_DAILY_NOTE_FIELDS = [
  'content', 'noteDate', 'completed', 'completedAt', 'position', 'updatedAt',
] as const
const MUTABLE_TAG_FIELDS = ['name', 'color', 'position', 'updatedAt'] as const
const MUTABLE_TEMPLATE_FIELDS = [
  'title', 'note', 'dueTime', 'tagId', 'legacyColor', 'durationDays', 'position', 'updatedAt',
] as const

export function createBuiltInTaskTags(timestamp = new Date().toISOString()): TaskTag[] {
  return BUILT_IN_TAG_DEFINITIONS.map((tag, position) => ({
    ...tag,
    builtIn: true,
    position,
    createdAt: timestamp,
    updatedAt: timestamp,
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function validPosition(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : fallback
}

function nullableTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : null
}

function normalizeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : fallback
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback
}

function normalizeSettings(raw: unknown): AppSettings {
  const value = isRecord(raw) ? raw : {}
  return {
    sidebarSplit: clampNumber(value.sidebarSplit, 20, 80, DEFAULT_APP_SETTINGS.sidebarSplit),
    widgetSplit: clampNumber(value.widgetSplit, 20, 80, DEFAULT_APP_SETTINGS.widgetSplit),
    fontScale: clampNumber(value.fontScale, 0.85, 1.5, DEFAULT_APP_SETTINGS.fontScale),
    themeColor: normalizeHex(value.themeColor, DEFAULT_APP_SETTINGS.themeColor),
  }
}

function normalizeSubTask(raw: unknown, fallbackTimestamp: string): SubTask | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  const completed = raw.completed === true
  return {
    id: raw.id,
    title: raw.title,
    completed,
    completedAt: completed ? nullableTimestamp(raw.completedAt) : null,
    createdAt: timestamp(raw.createdAt, fallbackTimestamp),
    updatedAt: timestamp(raw.updatedAt, fallbackTimestamp),
  }
}

function normalizeTag(raw: unknown, fallbackTimestamp: string, fallbackPosition: number): TaskTag | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const definition = BUILT_IN_TAG_DEFINITIONS.find((tag) => tag.id === raw.id)
  return {
    id: raw.id,
    name: raw.name.trim() || definition?.name || '태그',
    color: normalizeHex(raw.color, definition?.color || '#718096'),
    builtIn: Boolean(definition),
    legacyColor: definition?.legacyColor ?? null,
    position: validPosition(raw.position, fallbackPosition),
    createdAt: timestamp(raw.createdAt, fallbackTimestamp),
    updatedAt: timestamp(raw.updatedAt, fallbackTimestamp),
  }
}

function normalizeTags(raw: unknown, fallbackTimestamp: string): TaskTag[] {
  const supplied = Array.isArray(raw)
    ? raw.map((tag, index) => normalizeTag(tag, fallbackTimestamp, index)).filter((tag): tag is TaskTag => tag !== null)
    : []
  const byId = new Map(supplied.map((tag) => [tag.id, tag]))
  for (const builtIn of createBuiltInTaskTags(fallbackTimestamp)) {
    if (!byId.has(builtIn.id)) byId.set(builtIn.id, builtIn)
  }
  return [...byId.values()].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

function normalizeTagId(
  raw: Record<string, unknown>,
  knownTagIds: Set<string>,
  legacyColor: TaskColor,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(raw, 'tagId')) return LEGACY_TAG_ID_BY_COLOR[legacyColor]
  return typeof raw.tagId === 'string' && knownTagIds.has(raw.tagId) ? raw.tagId : null
}

function normalizeTask(
  raw: unknown,
  fallbackTimestamp: string,
  fallbackPosition: number,
  knownTagIds: Set<string>,
): Task | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !isDateKey(String(raw.dueDate))) return null
  const dueDate = String(raw.dueDate)
  const requestedStart = typeof raw.startDate === 'string' && isDateKey(raw.startDate) ? raw.startDate : dueDate
  const startDate = requestedStart <= dueDate ? requestedStart : dueDate
  const color = TASK_COLORS.has(raw.color as TaskColor) ? raw.color as TaskColor : 'coral'
  let completed = raw.completed === true
  const createdAt = timestamp(raw.createdAt, fallbackTimestamp)
  let subTasks = Array.isArray(raw.subTasks)
    ? raw.subTasks.map((subTask) => normalizeSubTask(subTask, createdAt)).filter((subTask): subTask is SubTask => subTask !== null)
    : []
  let completedAt = completed ? nullableTimestamp(raw.completedAt) : null
  if (completed && subTasks.length > 0) {
    const completionTimestamp = completedAt ?? fallbackTimestamp
    completedAt = completionTimestamp
    subTasks = subTasks.map((subTask) => subTask.completed ? subTask : {
      ...subTask,
      completed: true,
      completedAt: completionTimestamp,
      updatedAt: completionTimestamp,
    })
  } else if (!completed && subTasks.length > 0 && subTasks.every((subTask) => subTask.completed)) {
    completed = true
    completedAt = fallbackTimestamp
  }
  return {
    id: raw.id,
    title: raw.title,
    note: typeof raw.note === 'string' ? raw.note : '',
    startDate,
    dueDate,
    dueTime: typeof raw.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.dueTime)
      ? raw.dueTime
      : null,
    color,
    tagId: normalizeTagId(raw, knownTagIds, color),
    position: validPosition(raw.position, fallbackPosition),
    completed,
    completedAt,
    deletedAt: nullableTimestamp(raw.deletedAt),
    previousCompleted: typeof raw.previousCompleted === 'boolean' ? raw.previousCompleted : null,
    createdAt,
    updatedAt: timestamp(raw.updatedAt, createdAt),
    subTasks,
  }
}

function normalizeDailyNote(raw: unknown, fallbackTimestamp: string, fallbackPosition: number): DailyNote | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.content !== 'string' || !isDateKey(String(raw.noteDate))) return null
  const completed = raw.completed === true
  const createdAt = timestamp(raw.createdAt, fallbackTimestamp)
  return {
    id: raw.id,
    content: raw.content,
    noteDate: String(raw.noteDate),
    completed,
    completedAt: completed ? nullableTimestamp(raw.completedAt) : null,
    position: validPosition(raw.position, fallbackPosition),
    createdAt,
    updatedAt: timestamp(raw.updatedAt, createdAt),
  }
}

function normalizeTemplate(
  raw: unknown,
  fallbackTimestamp: string,
  fallbackPosition: number,
  knownTagIds: Set<string>,
): TaskTemplate | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !raw.title.trim()) return null
  const legacyColor = TASK_COLORS.has(raw.legacyColor as TaskColor) ? raw.legacyColor as TaskColor : 'coral'
  return {
    id: raw.id,
    title: raw.title.trim(),
    note: typeof raw.note === 'string' ? raw.note : '',
    dueTime: typeof raw.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.dueTime)
      ? raw.dueTime
      : null,
    tagId: normalizeTagId(raw, knownTagIds, legacyColor),
    legacyColor,
    durationDays: Math.max(1, validPosition(raw.durationDays, 1)),
    subTaskTitles: Array.isArray(raw.subTaskTitles)
      ? raw.subTaskTitles.filter((title): title is string => typeof title === 'string' && Boolean(title.trim())).map((title) => title.trim())
      : [],
    position: validPosition(raw.position, fallbackPosition),
    createdAt: timestamp(raw.createdAt, fallbackTimestamp),
    updatedAt: timestamp(raw.updatedAt, fallbackTimestamp),
  }
}

function normalizeStore(raw: unknown): DaylineStore {
  const nowIso = new Date().toISOString()
  const value = isRecord(raw) ? raw : {}
  const taskTags = normalizeTags(value.taskTags, nowIso)
  const knownTagIds = new Set(taskTags.map((tag) => tag.id))
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.map((task, index) => normalizeTask(task, nowIso, index, knownTagIds)).filter((task): task is Task => task !== null)
    : []
  const notePositionsByDate = new Map<string, number>()
  const dailyNotes = Array.isArray(value.dailyNotes)
    ? value.dailyNotes.map((note) => {
      const noteDate = isRecord(note) && typeof note.noteDate === 'string' ? note.noteDate : ''
      const fallbackPosition = notePositionsByDate.get(noteDate) ?? 0
      notePositionsByDate.set(noteDate, fallbackPosition + 1)
      return normalizeDailyNote(note, nowIso, fallbackPosition)
    }).filter((note): note is DailyNote => note !== null)
    : []
  const taskTemplates = Array.isArray(value.taskTemplates)
    ? value.taskTemplates.map((template, index) => normalizeTemplate(template, nowIso, index, knownTagIds)).filter((template): template is TaskTemplate => template !== null)
    : []
  return {
    version: 1,
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1,
    tasks: purgeExpired(tasks),
    dailyNotes,
    taskTags,
    settings: normalizeSettings(value.settings),
    taskTemplates,
    migrationWarning: null,
  }
}

function sameSubTaskTitles(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((title, index) => title === right[index])
}

function storeMutations(previousStore: DaylineStore, nextStore: DaylineStore): StoreMutation[] {
  const mutations: StoreMutation[] = []
  const nextTagIds = new Set(nextStore.taskTags.map((tag) => tag.id))
  const deletedTagIds = new Set(
    previousStore.taskTags
      .filter((tag) => !nextTagIds.has(tag.id))
      .map((tag) => tag.id),
  )
  const previousTasks = new Map(previousStore.tasks.map((task) => [task.id, task]))
  for (const task of nextStore.tasks) {
    const previous = previousTasks.get(task.id)
    if (!previous) {
      mutations.push({ type: 'task:create', task })
      continue
    }
    const useParentCompletionCascade = previous.completed !== task.completed
      && (task.completed ? task.subTasks.every((subTask) => subTask.completed) : task.subTasks.every((subTask) => !subTask.completed))
    const childMutations: StoreMutation[] = []
    const previousSubTasks = new Map(previous.subTasks.map((subTask) => [subTask.id, subTask]))
    const nextSubTaskIds = new Set(task.subTasks.map((subTask) => subTask.id))
    for (const subTask of task.subTasks) {
      const previousSubTask = previousSubTasks.get(subTask.id)
      if (!previousSubTask) {
        childMutations.push({ type: 'subtask:create', taskId: task.id, subTask })
        continue
      }
      const changes: SubTaskPatch = {}
      for (const field of ['title', 'completed', 'completedAt', 'updatedAt'] as const) {
        if (useParentCompletionCascade && (field === 'completed' || field === 'completedAt')) continue
        if (!Object.is(previousSubTask[field], subTask[field])) Object.assign(changes, { [field]: subTask[field] })
      }
      if (useParentCompletionCascade && Object.keys(changes).length === 1 && Object.prototype.hasOwnProperty.call(changes, 'updatedAt')) delete changes.updatedAt
      if (Object.keys(changes).length > 0) childMutations.push({ type: 'subtask:patch', taskId: task.id, id: subTask.id, changes })
    }
    for (const subTask of previous.subTasks) {
      if (!nextSubTaskIds.has(subTask.id)) childMutations.push({ type: 'subtask:delete', taskId: task.id, id: subTask.id })
    }
    const changes: TaskPatch = {}
    for (const field of MUTABLE_TASK_FIELDS) {
      if (childMutations.length > 0 && !useParentCompletionCascade && (field === 'completed' || field === 'completedAt')) continue
      if (
        field === 'tagId'
        && task.tagId === null
        && previous.tagId !== null
        && deletedTagIds.has(previous.tagId)
      ) continue
      if (!Object.is(previous[field], task[field])) Object.assign(changes, { [field]: task[field] })
    }
    if (Object.keys(changes).length > 0) mutations.push({ type: 'task:patch', id: task.id, changes })
    mutations.push(...childMutations)
  }

  const previousNotes = new Map(previousStore.dailyNotes.map((note) => [note.id, note]))
  const nextNoteIds = new Set(nextStore.dailyNotes.map((note) => note.id))
  for (const note of nextStore.dailyNotes) {
    const previous = previousNotes.get(note.id)
    if (!previous) mutations.push({ type: 'daily-note:create', note })
    else {
      const changes: DailyNotePatch = {}
      for (const field of MUTABLE_DAILY_NOTE_FIELDS) {
        if (!Object.is(previous[field], note[field])) Object.assign(changes, { [field]: note[field] })
      }
      if (Object.keys(changes).length > 0) mutations.push({ type: 'daily-note:patch', id: note.id, changes })
    }
  }
  for (const note of previousStore.dailyNotes) if (!nextNoteIds.has(note.id)) mutations.push({ type: 'daily-note:delete', id: note.id })

  const previousTags = new Map(previousStore.taskTags.map((tag) => [tag.id, tag]))
  for (const tag of nextStore.taskTags) {
    const previous = previousTags.get(tag.id)
    if (!previous) mutations.push({ type: 'tag:create', tag })
    else {
      const changes: TaskTagPatch = {}
      for (const field of MUTABLE_TAG_FIELDS) if (!Object.is(previous[field], tag[field])) Object.assign(changes, { [field]: tag[field] })
      if (Object.keys(changes).length > 0) mutations.push({ type: 'tag:patch', id: tag.id, changes })
    }
  }
  for (const tag of previousStore.taskTags) if (!nextTagIds.has(tag.id)) mutations.push({ type: 'tag:delete', id: tag.id })

  const settingsChanges: AppSettingsPatch = {}
  for (const field of ['sidebarSplit', 'widgetSplit', 'fontScale', 'themeColor'] as const) {
    if (!Object.is(previousStore.settings[field], nextStore.settings[field])) Object.assign(settingsChanges, { [field]: nextStore.settings[field] })
  }
  if (Object.keys(settingsChanges).length > 0) mutations.push({ type: 'settings:patch', changes: settingsChanges })

  const previousTemplates = new Map(previousStore.taskTemplates.map((template) => [template.id, template]))
  const nextTemplateIds = new Set(nextStore.taskTemplates.map((template) => template.id))
  for (const template of nextStore.taskTemplates) {
    const previous = previousTemplates.get(template.id)
    if (!previous) mutations.push({ type: 'template:create', template })
    else {
      const changes: TaskTemplatePatch = {}
      for (const field of MUTABLE_TEMPLATE_FIELDS) {
        if (
          field === 'tagId'
          && template.tagId === null
          && previous.tagId !== null
          && deletedTagIds.has(previous.tagId)
        ) continue
        if (!Object.is(previous[field], template[field])) Object.assign(changes, { [field]: template[field] })
      }
      if (!sameSubTaskTitles(previous.subTaskTitles, template.subTaskTitles)) changes.subTaskTitles = template.subTaskTitles
      if (Object.keys(changes).length > 0) mutations.push({ type: 'template:patch', id: template.id, changes })
    }
  }
  for (const template of previousStore.taskTemplates) if (!nextTemplateIds.has(template.id)) mutations.push({ type: 'template:delete', id: template.id })
  return mutations
}

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

/** Browser-only equivalent of the SQLite row mutation transaction. */
function applyBrowserMutations(currentStore: DaylineStore, mutations: StoreMutation[]): DaylineStore {
  let tasks = [...currentStore.tasks]
  let dailyNotes = [...currentStore.dailyNotes]
  let taskTags = [...currentStore.taskTags]
  let settings = { ...currentStore.settings }
  let taskTemplates = [...currentStore.taskTemplates]
  const affectedTaskIds = new Set<string>()

  const orderedMutations = [
    ...mutations.filter((mutation) => mutation.type === 'tag:create'),
    ...mutations.filter((mutation) => mutation.type !== 'tag:create'),
  ]
  for (const mutation of orderedMutations) {
    if (mutation.type === 'task:create') {
      if (!tasks.some((task) => task.id === mutation.task.id)) tasks.push(mutation.task)
      continue
    }
    if (mutation.type === 'task:patch') {
      tasks = tasks.map((task) => {
        if (task.id !== mutation.id || (task.deletedAt && !hasOwn(mutation.changes, 'deletedAt'))) return task
        const next = { ...task, ...mutation.changes }
        if (next.startDate > next.dueDate) return task
        if (!task.deletedAt && next.deletedAt) next.previousCompleted = task.completed
        if (hasOwn(mutation.changes, 'completed')) {
          const timestamp = next.completed ? next.completedAt ?? next.updatedAt : null
          next.subTasks = next.subTasks.map((subTask) => ({
            ...subTask,
            completed: next.completed,
            completedAt: timestamp,
            updatedAt: next.updatedAt,
          }))
        }
        affectedTaskIds.add(task.id)
        return next
      })
      continue
    }
    if (mutation.type === 'subtask:create') {
      tasks = tasks.map((task) => {
        if (task.id !== mutation.taskId || task.deletedAt || task.subTasks.some((child) => child.id === mutation.subTask.id)) return task
        affectedTaskIds.add(task.id)
        return { ...task, subTasks: [...task.subTasks, mutation.subTask] }
      })
      continue
    }
    if (mutation.type === 'subtask:patch') {
      tasks = tasks.map((task) => {
        if (task.id !== mutation.taskId || task.deletedAt) return task
        let changed = false
        const subTasks = task.subTasks.map((subTask) => {
          if (subTask.id !== mutation.id) return subTask
          changed = true
          return { ...subTask, ...mutation.changes }
        })
        if (!changed) return task
        affectedTaskIds.add(task.id)
        return { ...task, subTasks }
      })
      continue
    }
    if (mutation.type === 'subtask:delete') {
      tasks = tasks.map((task) => {
        if (task.id !== mutation.taskId || task.deletedAt || !task.subTasks.some((child) => child.id === mutation.id)) return task
        affectedTaskIds.add(task.id)
        return { ...task, subTasks: task.subTasks.filter((child) => child.id !== mutation.id) }
      })
      continue
    }
    if (mutation.type === 'daily-note:create') {
      if (!dailyNotes.some((note) => note.id === mutation.note.id)) dailyNotes.push(mutation.note)
      continue
    }
    if (mutation.type === 'daily-note:patch') {
      dailyNotes = dailyNotes.map((note) => note.id === mutation.id ? { ...note, ...mutation.changes } : note)
      continue
    }
    if (mutation.type === 'daily-note:delete') {
      dailyNotes = dailyNotes.filter((note) => note.id !== mutation.id)
      continue
    }
    if (mutation.type === 'tag:create') {
      if (!taskTags.some((tag) => tag.id === mutation.tag.id) && !mutation.tag.builtIn) taskTags.push(mutation.tag)
      continue
    }
    if (mutation.type === 'tag:patch') {
      taskTags = taskTags.map((tag) => tag.id === mutation.id ? { ...tag, ...mutation.changes } : tag)
      continue
    }
    if (mutation.type === 'tag:delete') {
      const tag = taskTags.find((value) => value.id === mutation.id)
      if (!tag || tag.builtIn) continue
      taskTags = taskTags.filter((value) => value.id !== mutation.id)
      tasks = tasks.map((task) => task.tagId === mutation.id ? { ...task, tagId: null } : task)
      taskTemplates = taskTemplates.map((template) => template.tagId === mutation.id ? { ...template, tagId: null } : template)
      continue
    }
    if (mutation.type === 'settings:patch') {
      settings = normalizeSettings({ ...settings, ...mutation.changes })
      continue
    }
    if (mutation.type === 'template:create') {
      if (!taskTemplates.some((template) => template.id === mutation.template.id)) taskTemplates.push(mutation.template)
      continue
    }
    if (mutation.type === 'template:patch') {
      taskTemplates = taskTemplates.map((template) => template.id === mutation.id
        ? { ...template, ...mutation.changes }
        : template)
      continue
    }
    if (mutation.type === 'template:delete') {
      taskTemplates = taskTemplates.filter((template) => template.id !== mutation.id)
    }
  }

  const aggregateTimestamp = new Date().toISOString()
  tasks = tasks.map((task) => {
    if (!affectedTaskIds.has(task.id) || task.deletedAt || task.subTasks.length === 0) return task
    const completed = task.subTasks.every((subTask) => subTask.completed)
    if (completed === task.completed && (completed ? task.completedAt !== null : task.completedAt === null)) return task
    return {
      ...task,
      completed,
      completedAt: completed ? aggregateTimestamp : null,
      updatedAt: aggregateTimestamp,
    }
  })

  return {
    ...currentStore,
    tasks,
    dailyNotes,
    taskTags,
    settings,
    taskTemplates,
  }
}

function browserSeed(): DaylineStore {
  const now = new Date()
  const nowIso = now.toISOString()
  const deletedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const makeId = () => crypto.randomUUID()
  const taskTags = createBuiltInTaskTags(nowIso)
  const task = (value: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'subTasks'> & { subTasks?: SubTask[] }): Task => ({
    ...value, id: makeId(), createdAt: nowIso, updatedAt: value.deletedAt ?? nowIso, subTasks: value.subTasks ?? [],
  })
  return {
    version: 1,
    revision: 1,
    tasks: [
      task({
        title: 'Dayline 프로토타입 살펴보기', note: '기간 일정과 태그, 템플릿을 확인해 보세요.',
        startDate: todayKey(), dueDate: addDaysKey(todayKey(), 1), dueTime: null,
        color: 'coral', tagId: 'builtin-coral', position: 0,
        completed: false, completedAt: null, deletedAt: null, previousCompleted: null,
        subTasks: ['캘린더에서 기간 일정 확인하기', '오른쪽 일정 영역 확인하기'].map((title) => ({
          id: makeId(), title, completed: false, completedAt: null, createdAt: nowIso, updatedAt: nowIso,
        })),
      }),
      task({
        title: '오늘의 우선순위 정리', note: '', startDate: todayKey(), dueDate: todayKey(), dueTime: '10:30',
        color: 'violet', tagId: 'builtin-violet', position: 1,
        completed: false, completedAt: null, deletedAt: null, previousCompleted: null,
      }),
      task({
        title: '복구 기능 예시 일정', note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        startDate: addDaysKey(todayKey(), -3), dueDate: addDaysKey(todayKey(), -3), dueTime: null,
        color: 'blue', tagId: 'builtin-blue', position: 2,
        completed: true, completedAt: nowIso, deletedAt, previousCompleted: true,
      }),
    ],
    dailyNotes: [{
      id: makeId(), content: '떠오른 할 일을 여기에 바로 적어 보세요.', noteDate: todayKey(), completed: false,
      completedAt: null, position: 0, createdAt: nowIso, updatedAt: nowIso,
    }],
    taskTags,
    settings: { ...DEFAULT_APP_SETTINGS },
    taskTemplates: [{
      id: makeId(), title: '주간 계획', note: '', dueTime: null, tagId: 'builtin-blue', legacyColor: 'blue',
      durationDays: 7, subTaskTitles: ['목표 정리', '진행 상황 확인'], position: 0, createdAt: nowIso, updatedAt: nowIso,
    }],
    migrationWarning: null,
  }
}

export async function loadStore(): Promise<DaylineStore> {
  if (window.dayline) return window.dayline.loadData()
  const raw = localStorage.getItem(BROWSER_STORAGE_KEY)
  if (!raw) {
    const seed = browserSeed()
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    const store = normalizeStore(JSON.parse(raw))
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(store))
    return store
  } catch {
    const seed = browserSeed()
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export function saveStore(previousStore: DaylineStore, nextStore: DaylineStore): DaylineStore {
  const requestedTagIds = new Set(nextStore.taskTags.map((tag) => tag.id))
  const protectedBuiltIns = previousStore.taskTags.filter((tag) => tag.builtIn && !requestedTagIds.has(tag.id))
  const safeStore = normalizeStore({
    ...nextStore,
    taskTags: [...nextStore.taskTags, ...protectedBuiltIns],
  })
  const mutations = storeMutations(previousStore, safeStore)
  if (window.dayline) return window.dayline.applyStoreMutations(mutations)
  let currentStore = normalizeStore(previousStore)
  try {
    currentStore = normalizeStore(JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) || 'null'))
  } catch {
    // A normalized store replaces malformed browser-only data.
  }
  const mergedStore = applyBrowserMutations(currentStore, mutations)
  const store = normalizeStore({
    ...mergedStore,
    revision: currentStore.revision + 1,
    migrationWarning: null,
  })
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(store))
  window.dispatchEvent(new CustomEvent('dayline-browser-data', { detail: store }))
  return store
}

export function subscribeToStore(callback: (store: DaylineStore) => void): () => void {
  if (window.dayline) return window.dayline.onDataChanged(callback)
  const listener = (event: Event) => callback(normalizeStore((event as CustomEvent).detail))
  window.addEventListener('dayline-browser-data', listener)
  return () => window.removeEventListener('dayline-browser-data', listener)
}
