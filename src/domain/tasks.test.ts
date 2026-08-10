import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import {
  isRecoverable,
  purgeExpired,
  restoreTask,
  RETENTION_MS,
  transitionTask,
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
}

describe('task lifecycle', () => {
  it('first click completes without removing the task', () => {
    const result = transitionTask([baseTask], baseTask.id, new Date('2026-08-10T03:00:00.000Z'))
    expect(result.transition).toBe('completed')
    expect(result.tasks[0].completed).toBe(true)
    expect(result.tasks[0].deletedAt).toBeNull()
  })

  it('next click on a completed task soft-deletes it', () => {
    const completed = { ...baseTask, completed: true, completedAt: '2026-08-10T03:00:00.000Z' }
    const result = transitionTask([completed], completed.id, new Date('2026-08-10T04:00:00.000Z'))
    expect(result.transition).toBe('deleted')
    expect(result.tasks[0].deletedAt).toBe('2026-08-10T04:00:00.000Z')
    expect(result.tasks[0].previousCompleted).toBe(true)
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
