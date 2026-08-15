import type { SubTask, SubTaskPatch, Task, TaskColor, TaskTemplate } from '../types'
import { addDaysKey } from './date'

export interface TaskDraft {
  title: string
  note: string
  startDate: string
  dueDate: string
  dueTime: string | null
  color: TaskColor
  tagId: string | null
  subTasks: SubTask[]
}

export type TaskDraftChanges = Partial<TaskDraft>
export type ScalarTaskDraftChanges = Partial<Omit<TaskDraft, 'subTasks'>>

export interface SubTaskEditChanges {
  created: SubTask[]
  patched: Array<{ id: string; changes: SubTaskPatch }>
  deletedIds: string[]
}

export interface TaskEditChanges {
  draft: ScalarTaskDraftChanges
  subTasks?: SubTaskEditChanges
  completed?: boolean
  cascadeSubTasks?: boolean
}

const SUBTASK_EDITABLE_FIELDS = ['title', 'completed', 'completedAt', 'updatedAt'] as const

export function getTaskEditChanges(
  task: Task,
  draft: TaskDraft,
  completed: boolean,
  cascadeSubTasks = false,
): TaskEditChanges {
  const previousSubTasks = new Map(task.subTasks.map((subTask) => [subTask.id, subTask]))
  const nextIds = new Set(draft.subTasks.map((subTask) => subTask.id))
  const created: SubTask[] = []
  const patched: SubTaskEditChanges['patched'] = []

  for (const subTask of draft.subTasks) {
    const previous = previousSubTasks.get(subTask.id)
    if (!previous) {
      created.push(subTask)
      continue
    }
    const changes: SubTaskPatch = {}
    for (const field of SUBTASK_EDITABLE_FIELDS) {
      if (!Object.is(previous[field], subTask[field])) {
        Object.assign(changes, { [field]: subTask[field] })
      }
    }
    if (Object.keys(changes).length > 0) patched.push({ id: subTask.id, changes })
  }

  const deletedIds = task.subTasks
    .filter((subTask) => !nextIds.has(subTask.id))
    .map((subTask) => subTask.id)
  const hasSubTaskChanges = created.length > 0 || patched.length > 0 || deletedIds.length > 0

  return {
    draft: {
      ...(draft.title !== task.title ? { title: draft.title } : {}),
      ...(draft.note !== task.note ? { note: draft.note } : {}),
      ...(draft.startDate !== task.startDate ? { startDate: draft.startDate } : {}),
      ...(draft.dueDate !== task.dueDate ? { dueDate: draft.dueDate } : {}),
      ...(draft.dueTime !== task.dueTime ? { dueTime: draft.dueTime } : {}),
      ...(draft.color !== task.color ? { color: draft.color } : {}),
      ...(draft.tagId !== task.tagId ? { tagId: draft.tagId } : {}),
    },
    ...(hasSubTaskChanges ? { subTasks: { created, patched, deletedIds } } : {}),
    ...(completed !== task.completed
      ? { completed, ...(cascadeSubTasks ? { cascadeSubTasks: true } : {}) }
      : {}),
  }
}

export function createTaskFromTemplate(
  template: TaskTemplate,
  startDate: string,
  position: number,
  now = new Date(),
  createId: () => string = () => crypto.randomUUID(),
): Task {
  const timestamp = now.toISOString()
  return {
    id: createId(),
    title: template.title,
    note: template.note,
    startDate,
    dueDate: addDaysKey(startDate, Math.max(1, template.durationDays) - 1),
    dueTime: template.dueTime,
    color: template.legacyColor,
    tagId: template.tagId,
    position,
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    subTasks: template.subTaskTitles.map((title) => ({
      id: createId(),
      title,
      completed: false,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  }
}

/**
 * Applies modal changes captured against an old snapshot onto the newest task.
 * Concurrent changes to unrelated child IDs and fields are retained.
 */
export function applyTaskEditChanges(
  latestTask: Task,
  changes: TaskEditChanges,
): TaskDraftChanges {
  if (!changes.subTasks) return changes.draft

  const deletedIds = new Set(changes.subTasks.deletedIds)
  const patches = new Map(changes.subTasks.patched.map((patch) => [patch.id, patch.changes]))
  const subTasks = latestTask.subTasks
    .filter((subTask) => !deletedIds.has(subTask.id))
    .map((subTask) => {
      const patch = patches.get(subTask.id)
      return patch ? { ...subTask, ...patch } : subTask
    })
  const existingIds = new Set(subTasks.map((subTask) => subTask.id))
  for (const subTask of changes.subTasks.created) {
    if (!existingIds.has(subTask.id)) {
      subTasks.push(subTask)
      existingIds.add(subTask.id)
    }
  }
  return { ...changes.draft, subTasks }
}
