import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import {
  advanceTaskState,
  isRecoverable,
  purgeExpired,
  restoreTask,
  RETENTION_MS,
  setTaskCompleted,
  softDeleteTask,
  sortTasks,
  toggleSubTask,
} from './tasks'

const baseTask: Task = {
  id: 'task-1',
  title: '테스트 일정',
  note: '',
  dueDate: '2026-08-10',
  dueTime: null,
  color: 'coral',
  completed: false,
  completedAt: null,
  deletedAt: null,
  previousCompleted: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  subTasks: [],
}

const subTasks = [
  {
    id: 'sub-1',
    title: '첫 번째',
    completed: false,
    completedAt: null,
    createdAt: '2026-08-10T00:01:00.000Z',
    updatedAt: '2026-08-10T00:01:00.000Z',
  },
  {
    id: 'sub-2',
    title: '두 번째',
    completed: false,
    completedAt: null,
    createdAt: '2026-08-10T00:02:00.000Z',
    updatedAt: '2026-08-10T00:02:00.000Z',
  },
]

describe('task lifecycle', () => {
  it('deactivates a task without removing it', () => {
    const result = setTaskCompleted([baseTask], baseTask.id, true, new Date('2026-08-10T03:00:00.000Z'))
    expect(result[0].completed).toBe(true)
    expect(result[0].completedAt).toBe('2026-08-10T03:00:00.000Z')
    expect(result[0].deletedAt).toBeNull()
  })

  it('reactivates a task and clears its completion timestamp', () => {
    const completed = { ...baseTask, completed: true, completedAt: '2026-08-10T03:00:00.000Z' }
    const result = setTaskCompleted([completed], completed.id, false, new Date('2026-08-10T04:00:00.000Z'))
    expect(result[0].completed).toBe(false)
    expect(result[0].completedAt).toBeNull()
    expect(result[0].deletedAt).toBeNull()
  })

  it('cascades parent completion and reactivation to every subtask', () => {
    const task = { ...baseTask, subTasks }
    const completed = setTaskCompleted([task], task.id, true, new Date('2026-08-10T03:00:00.000Z'))[0]
    expect(completed.completed).toBe(true)
    expect(completed.subTasks.every((subTask) => subTask.completed)).toBe(true)

    const active = setTaskCompleted([completed], task.id, false, new Date('2026-08-10T04:00:00.000Z'))[0]
    expect(active.completed).toBe(false)
    expect(active.subTasks.every((subTask) => !subTask.completed && subTask.completedAt === null)).toBe(true)
  })

  it('toggles children independently and derives parent completion', () => {
    const task = { ...baseTask, subTasks }
    const first = toggleSubTask([task], task.id, 'sub-1', new Date('2026-08-10T03:00:00.000Z'))[0]
    expect(first.subTasks.map((subTask) => subTask.completed)).toEqual([true, false])
    expect(first.completed).toBe(false)

    const all = toggleSubTask([first], task.id, 'sub-2', new Date('2026-08-10T04:00:00.000Z'))[0]
    expect(all.completed).toBe(true)
    expect(all.completedAt).toBe('2026-08-10T04:00:00.000Z')

    const reopened = toggleSubTask([all], task.id, 'sub-1', new Date('2026-08-10T05:00:00.000Z'))[0]
    expect(reopened.subTasks.map((subTask) => subTask.completed)).toEqual([false, true])
    expect(reopened.completed).toBe(false)
    expect(reopened.completedAt).toBeNull()
  })

  it('keeps state commands idempotent and ignores deleted tasks', () => {
    const unchanged = setTaskCompleted([baseTask], baseTask.id, false)
    expect(unchanged[0]).toBe(baseTask)

    const deleted = { ...baseTask, deletedAt: '2026-08-10T04:00:00.000Z' }
    const ignored = setTaskCompleted([deleted], deleted.id, true)
    expect(ignored[0]).toBe(deleted)
  })

  it('advances an active task to inactive, then moves it to recent deletion', () => {
    const first = advanceTaskState([baseTask], baseTask.id, new Date('2026-08-10T03:00:00.000Z'))
    expect(first.action).toBe('deactivated')
    expect(first.tasks[0].completed).toBe(true)
    expect(first.tasks[0].deletedAt).toBeNull()

    const second = advanceTaskState(first.tasks, baseTask.id, new Date('2026-08-10T04:00:00.000Z'))
    expect(second.action).toBe('deleted')
    expect(second.tasks[0].deletedAt).toBe('2026-08-10T04:00:00.000Z')
    expect(second.tasks[0].previousCompleted).toBe(true)
  })

  it('restores the original completed state and date fields', () => {
    const deleted = {
      ...baseTask,
      dueTime: '14:30',
      completed: true,
      previousCompleted: true,
      deletedAt: '2026-08-10T04:00:00.000Z',
    }
    const restored = restoreTask([deleted], deleted.id, new Date('2026-08-11T04:00:00.000Z'))[0]
    expect(restored.deletedAt).toBeNull()
    expect(restored.completed).toBe(true)
    expect(restored.dueDate).toBe('2026-08-10')
    expect(restored.dueTime).toBe('14:30')
  })

  it('hides a soft-deleted parent and all nested children through parent semantics', () => {
    const task = { ...baseTask, subTasks }
    const deleted = softDeleteTask([task], task.id, new Date('2026-08-10T03:00:00.000Z'))
    expect(deleted[0].subTasks).toEqual(subTasks)
    expect(deleted[0].deletedAt).not.toBeNull()
    expect(deleted.filter((item) => !item.deletedAt)).toEqual([])
  })
})

describe('stable task order', () => {
  it('does not move a task when only completion changes', () => {
    const tasks = [
      { ...baseTask, id: 'late', dueTime: null, createdAt: '2026-08-10T00:02:00.000Z' },
      { ...baseTask, id: 'early', dueTime: '09:00', createdAt: '2026-08-10T00:03:00.000Z' },
      { ...baseTask, id: 'middle', dueTime: null, createdAt: '2026-08-10T00:01:00.000Z' },
    ]
    const before = sortTasks(tasks).map((task) => task.id)
    const changed = setTaskCompleted(tasks, 'middle', true)
    expect(sortTasks(changed).map((task) => task.id)).toEqual(before)
  })

  it('uses id as a deterministic final tie breaker', () => {
    const tasks = [
      { ...baseTask, id: 'b' },
      { ...baseTask, id: 'a' },
    ]
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['a', 'b'])
  })
})
describe('30 day recovery window', () => {
  const now = new Date('2026-09-09T04:00:00.000Z').getTime()

  it('keeps a task at exactly 30 days', () => {
    const task = { ...baseTask, deletedAt: new Date(now - RETENTION_MS).toISOString() }
    expect(isRecoverable(task, now)).toBe(true)
    expect(purgeExpired([task], now)).toHaveLength(1)
  })

  it('purges a task after more than 30 days', () => {
    const task = { ...baseTask, deletedAt: new Date(now - RETENTION_MS - 1).toISOString() }
    expect(isRecoverable(task, now)).toBe(false)
    expect(purgeExpired([task], now)).toHaveLength(0)
  })
})
