import type { Task } from '../types'

export const RETENTION_DAYS = 30
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

export type TaskAdvanceAction = 'deactivated' | 'deleted' | 'missing'

export function isRecoverable(task: Task, now = Date.now()): boolean {
  if (!task.deletedAt) return false
  const deletedAt = new Date(task.deletedAt).getTime()
  return Number.isFinite(deletedAt) && now - deletedAt <= RETENTION_MS
}

export function purgeExpired(tasks: Task[], now = Date.now()): Task[] {
  return tasks.filter((task) => !task.deletedAt || isRecoverable(task, now))
}

export function visibleTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.deletedAt)
}

export function deletedTasks(tasks: Task[], now = Date.now()): Task[] {
  return tasks
    .filter((task) => isRecoverable(task, now))
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed)
    if (Boolean(a.dueTime) !== Boolean(b.dueTime)) return a.dueTime ? -1 : 1
    if (a.dueTime && b.dueTime && a.dueTime !== b.dueTime) {
      return a.dueTime.localeCompare(b.dueTime)
    }
    return a.createdAt.localeCompare(b.createdAt)
  })
}

export function setTaskCompleted(
  tasks: Task[],
  taskId: string,
  completed: boolean,
  now = new Date(),
): Task[] {
  const target = tasks.find((task) => task.id === taskId && !task.deletedAt)
  if (!target || target.completed === completed) return tasks
  const timestamp = now.toISOString()

  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          completed,
          completedAt: completed ? timestamp : null,
          updatedAt: timestamp,
        }
      : task,
  )
}

export function softDeleteTask(tasks: Task[], taskId: string, now = new Date()): Task[] {
  const timestamp = now.toISOString()
  return tasks.map((task) =>
    task.id === taskId && !task.deletedAt
      ? {
          ...task,
          deletedAt: timestamp,
          previousCompleted: task.completed,
          updatedAt: timestamp,
        }
      : task,
  )
}

export function advanceTaskState(
  tasks: Task[],
  taskId: string,
  now = new Date(),
): { tasks: Task[]; action: TaskAdvanceAction } {
  const target = tasks.find((task) => task.id === taskId && !task.deletedAt)
  if (!target) return { tasks, action: 'missing' }
  if (!target.completed) {
    return {
      tasks: setTaskCompleted(tasks, taskId, true, now),
      action: 'deactivated',
    }
  }
  return {
    tasks: softDeleteTask(tasks, taskId, now),
    action: 'deleted',
  }
}

export function restoreTask(tasks: Task[], taskId: string, now = new Date()): Task[] {
  const timestamp = now.toISOString()
  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          completed:
            typeof task.previousCompleted === 'boolean'
              ? task.previousCompleted
              : task.completed,
          deletedAt: null,
          previousCompleted: null,
          updatedAt: timestamp,
        }
      : task,
  )
}

export function remainingRetentionDays(task: Task, now = Date.now()): number {
  if (!task.deletedAt) return RETENTION_DAYS
  const elapsed = Math.max(0, now - new Date(task.deletedAt).getTime())
  return Math.max(0, Math.ceil((RETENTION_MS - elapsed) / (24 * 60 * 60 * 1000)))
}
