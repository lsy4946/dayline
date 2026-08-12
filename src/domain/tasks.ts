import type { Task } from '../types'
import {
  addDaysKey,
  dateRangeContains,
  dateRangesOverlap,
  inclusiveDateKeys,
  isDateKey,
} from './date'

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
    if (a.position !== b.position) return a.position - b.position
    if (Boolean(a.dueTime) !== Boolean(b.dueTime)) return a.dueTime ? -1 : 1
    if (a.dueTime && b.dueTime && a.dueTime !== b.dueTime) {
      return a.dueTime.localeCompare(b.dueTime)
    }
    const createdOrder = a.createdAt.localeCompare(b.createdAt)
    return createdOrder !== 0 ? createdOrder : a.id.localeCompare(b.id)
  })
}

export function taskOccursOnDate(task: Task, dateKey: string): boolean {
  return dateRangeContains(task.startDate, task.dueDate, dateKey)
}

export function taskOverlapsRange(task: Task, startDate: string, endDate: string): boolean {
  return dateRangesOverlap(task.startDate, task.dueDate, startDate, endDate)
}

export function moveTaskRange(
  tasks: Task[],
  taskId: string,
  targetStart: string,
  now = new Date(),
): Task[] {
  const target = tasks.find((task) => task.id === taskId && !task.deletedAt)
  if (!target || target.startDate === targetStart || !isDateKey(targetStart)) return tasks

  const durationDays = inclusiveDateKeys(target.startDate, target.dueDate).length
  if (durationDays === 0) return tasks

  const moved: Task = {
    ...target,
    startDate: targetStart,
    dueDate: addDaysKey(targetStart, durationDays - 1),
    updatedAt: now.toISOString(),
  }
  return tasks.map((task) => task === target ? moved : task)
}

export function reorderPositioned<T extends { id: string; position: number; updatedAt: string }>(
  items: T[],
  orderedIds: string[],
  now = new Date(),
): T[] {
  const positions = new Map(orderedIds.map((id, position) => [id, position]))
  const timestamp = now.toISOString()
  return items.map((item) => {
    const position = positions.get(item.id)
    return position == null || position === item.position
      ? item
      : { ...item, position, updatedAt: timestamp }
  })
}

export function nextPosition(items: Array<{ position: number }>): number {
  return items.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1
}

export function setTaskCompleted(
  tasks: Task[],
  taskId: string,
  completed: boolean,
  now = new Date(),
): Task[] {
  const target = tasks.find((task) => task.id === taskId && !task.deletedAt)
  if (!target) return tasks
  const childrenAlreadyMatch = target.subTasks.every((subTask) => subTask.completed === completed)
  if (target.completed === completed && childrenAlreadyMatch) return tasks
  const timestamp = now.toISOString()

  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          completed,
          completedAt: completed ? timestamp : null,
          updatedAt: timestamp,
          subTasks: task.subTasks.map((subTask) =>
            subTask.completed === completed
              ? subTask
              : {
                  ...subTask,
                  completed,
                  completedAt: completed ? timestamp : null,
                  updatedAt: timestamp,
                },
          ),
        }
      : task,
  )
}

export function toggleSubTask(
  tasks: Task[],
  taskId: string,
  subTaskId: string,
  now = new Date(),
): Task[] {
  const target = tasks.find((task) => task.id === taskId && !task.deletedAt)
  if (!target || !target.subTasks.some((subTask) => subTask.id === subTaskId)) return tasks

  const timestamp = now.toISOString()
  return tasks.map((task) => {
    if (task.id !== taskId) return task

    const subTasks = task.subTasks.map((subTask) => {
      if (subTask.id !== subTaskId) return subTask
      const completed = !subTask.completed
      return {
        ...subTask,
        completed,
        completedAt: completed ? timestamp : null,
        updatedAt: timestamp,
      }
    })
    const completed = subTasks.length > 0 && subTasks.every((subTask) => subTask.completed)
    return {
      ...task,
      subTasks,
      completed,
      completedAt: completed ? timestamp : null,
      updatedAt: timestamp,
    }
  })
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
