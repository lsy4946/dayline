import type {
  DailyNote,
  DailyNotePatch,
  DaylineStore,
  StoreMutation,
  SubTask,
  SubTaskPatch,
  Task,
  TaskColor,
  TaskPatch,
} from '../types'
import { addDaysKey, todayKey } from '../domain/date'
import { purgeExpired } from '../domain/tasks'

const BROWSER_STORAGE_KEY = 'dayline-browser-store-v1'
const TASK_COLORS = new Set<TaskColor>(['coral', 'violet', 'sage', 'blue', 'amber'])
const MUTABLE_TASK_FIELDS = [
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
] as const
const MUTABLE_DAILY_NOTE_FIELDS = [
  'content',
  'noteDate',
  'completed',
  'completedAt',
  'updatedAt',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
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

function normalizeTask(raw: unknown, fallbackTimestamp: string): Task | null {
  if (
    !isRecord(raw)
    || typeof raw.id !== 'string'
    || typeof raw.title !== 'string'
    || !isDateKey(raw.dueDate)
  ) return null

  let completed = raw.completed === true
  const createdAt = timestamp(raw.createdAt, fallbackTimestamp)
  let subTasks = Array.isArray(raw.subTasks)
    ? raw.subTasks
      .map((subTask) => normalizeSubTask(subTask, createdAt))
      .filter((subTask): subTask is SubTask => subTask !== null)
    : []
  let completedAt = completed ? nullableTimestamp(raw.completedAt) : null
  if (completed && subTasks.length > 0) {
    const completionTimestamp = completedAt ?? fallbackTimestamp
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
    completedAt = fallbackTimestamp
  }
  return {
    id: raw.id,
    title: raw.title,
    note: typeof raw.note === 'string' ? raw.note : '',
    dueDate: raw.dueDate,
    dueTime: typeof raw.dueTime === 'string' ? raw.dueTime : null,
    color: TASK_COLORS.has(raw.color as TaskColor) ? raw.color as TaskColor : 'coral',
    completed,
    completedAt,
    deletedAt: nullableTimestamp(raw.deletedAt),
    previousCompleted: typeof raw.previousCompleted === 'boolean' ? raw.previousCompleted : null,
    createdAt,
    updatedAt: timestamp(raw.updatedAt, createdAt),
    subTasks,
  }
}

function normalizeDailyNote(raw: unknown, fallbackTimestamp: string): DailyNote | null {
  if (
    !isRecord(raw)
    || typeof raw.id !== 'string'
    || typeof raw.content !== 'string'
    || !isDateKey(raw.noteDate)
  ) return null
  const completed = raw.completed === true
  const createdAt = timestamp(raw.createdAt, fallbackTimestamp)
  return {
    id: raw.id,
    content: raw.content,
    noteDate: raw.noteDate,
    completed,
    completedAt: completed ? nullableTimestamp(raw.completedAt) : null,
    createdAt,
    updatedAt: timestamp(raw.updatedAt, createdAt),
  }
}

function normalizeStore(raw: unknown): DaylineStore {
  const nowIso = new Date().toISOString()
  const value = isRecord(raw) ? raw : {}
  const tasks = Array.isArray(value.tasks)
    ? value.tasks
      .map((task) => normalizeTask(task, nowIso))
      .filter((task): task is Task => task !== null)
    : []
  const dailyNotes = Array.isArray(value.dailyNotes)
    ? value.dailyNotes
      .map((note) => normalizeDailyNote(note, nowIso))
      .filter((note): note is DailyNote => note !== null)
    : []
  return {
    version: 1,
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) > 0
      ? Number(value.revision)
      : 1,
    tasks: purgeExpired(tasks),
    dailyNotes,
    migrationWarning: null,
  }
}

function storeMutations(previousStore: DaylineStore, nextStore: DaylineStore): StoreMutation[] {
  const mutations: StoreMutation[] = []
  const previousTasks = new Map(previousStore.tasks.map((task) => [task.id, task]))
  for (const task of nextStore.tasks) {
    const previous = previousTasks.get(task.id)
    if (!previous) {
      mutations.push({ type: 'task:create', task })
      continue
    }
    const useParentCompletionCascade = previous.completed !== task.completed
      && (task.completed
        ? task.subTasks.every((subTask) => subTask.completed)
        : task.subTasks.every((subTask) => !subTask.completed))
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
        if (!Object.is(previousSubTask[field], subTask[field])) {
          Object.assign(changes, { [field]: subTask[field] })
        }
      }
      if (
        useParentCompletionCascade
        && Object.keys(changes).length === 1
        && Object.prototype.hasOwnProperty.call(changes, 'updatedAt')
      ) {
        delete changes.updatedAt
      }
      if (Object.keys(changes).length > 0) {
        childMutations.push({ type: 'subtask:patch', taskId: task.id, id: subTask.id, changes })
      }
    }
    for (const subTask of previous.subTasks) {
      if (!nextSubTaskIds.has(subTask.id)) {
        childMutations.push({ type: 'subtask:delete', taskId: task.id, id: subTask.id })
      }
    }

    const changes: TaskPatch = {}
    for (const field of MUTABLE_TASK_FIELDS) {
      if (
        childMutations.length > 0
        && !useParentCompletionCascade
        && (field === 'completed' || field === 'completedAt')
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
    if (!previous) {
      mutations.push({ type: 'daily-note:create', note })
      continue
    }
    const changes: DailyNotePatch = {}
    for (const field of MUTABLE_DAILY_NOTE_FIELDS) {
      if (!Object.is(previous[field], note[field])) Object.assign(changes, { [field]: note[field] })
    }
    if (Object.keys(changes).length > 0) {
      mutations.push({ type: 'daily-note:patch', id: note.id, changes })
    }
  }
  for (const note of previousStore.dailyNotes) {
    if (!nextNoteIds.has(note.id)) mutations.push({ type: 'daily-note:delete', id: note.id })
  }
  return mutations
}

function browserSeed(): DaylineStore {
  const now = new Date()
  const nowIso = now.toISOString()
  const deletedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const makeId = () => crypto.randomUUID()
  const task = (
    value: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'subTasks'> & { subTasks?: SubTask[] },
  ): Task => ({
    ...value,
    id: makeId(),
    createdAt: nowIso,
    updatedAt: value.deletedAt ?? nowIso,
    subTasks: value.subTasks ?? [],
  })
  return {
    version: 1,
    revision: 1,
    tasks: [
      task({
        title: 'Dayline 프로토타입 살펴보기',
        note: '활성 일정과 위젯, 최근 삭제 복구 기능을 확인해 보세요.',
        dueDate: todayKey(),
        dueTime: null,
        color: 'coral',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        subTasks: [
          {
            id: makeId(),
            title: '캘린더에서 오늘 일정 확인하기',
            completed: false,
            completedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: makeId(),
            title: '오른쪽 일정 영역에서 하위 일정 완료하기',
            completed: false,
            completedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      }),
      task({
        title: '오늘의 우선순위 정리',
        note: '',
        dueDate: todayKey(),
        dueTime: '10:30',
        color: 'violet',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
      }),
      task({
        title: '주간 계획 초안',
        note: '',
        dueDate: addDaysKey(todayKey(), 1),
        dueTime: null,
        color: 'blue',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
      }),
      task({
        title: '복구 기능 예시 일정',
        note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        dueDate: addDaysKey(todayKey(), -3),
        dueTime: null,
        color: 'blue',
        completed: true,
        completedAt: nowIso,
        deletedAt,
        previousCompleted: true,
      }),
    ],
    dailyNotes: [
      {
        id: makeId(),
        content: '떠오른 할 일을 여기에 바로 적어 보세요.',
        noteDate: todayKey(),
        completed: false,
        completedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ],
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
  const safeStore = normalizeStore(nextStore)
  if (window.dayline) {
    return window.dayline.applyStoreMutations(storeMutations(previousStore, safeStore))
  }
  let currentRevision = 0
  try {
    const current = JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) || 'null')
    if (Number.isSafeInteger(current?.revision) && current.revision > 0) {
      currentRevision = current.revision
    }
  } catch {
    // The normalized store below replaces malformed browser-only data.
  }
  const store: DaylineStore = {
    ...safeStore,
    revision: currentRevision + 1,
    migrationWarning: null,
  }
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
