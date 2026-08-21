import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import { taskOccursOnDate, taskOverlapsRange } from './tasks'
import { taskOccurrenceRanges } from './taskSchedule'

const baseTask: Task = {
  id: 'monthly-task',
  title: '월간 일정',
  note: '',
  startDate: '2026-08-30',
  dueDate: '2026-08-30',
  dueTime: null,
  color: 'coral',
  tagId: null,
  scheduleType: 'normal',
  businessDay: false,
  position: 0,
  completed: false,
  completedAt: null,
  deletedAt: null,
  previousCompleted: null,
  subTasks: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

describe('monthly task schedule rules', () => {
  it('keeps normal schedules as a single inclusive range', () => {
    const task = { ...baseTask, startDate: '2026-08-30', dueDate: '2026-09-01' }
    expect(taskOccurrenceRanges(task, '2026-08-01', '2026-09-30')).toEqual([
      { startDate: '2026-08-30', dueDate: '2026-09-01' },
    ])
  })

  it('repeats a fixed day and skips months that do not contain it', () => {
    const task = { ...baseTask, scheduleType: 'monthly-date' as const }
    expect(taskOccursOnDate(task, '2026-09-30')).toBe(true)
    expect(taskOccursOnDate(task, '2027-02-28')).toBe(false)
    expect(taskOccursOnDate(task, '2027-03-30')).toBe(true)
  })

  it('repeats the same ordinal weekday and skips a missing fifth weekday', () => {
    const task = {
      ...baseTask,
      startDate: '2026-08-31',
      dueDate: '2026-08-31',
      scheduleType: 'monthly-weekday' as const,
    }
    expect(taskOccursOnDate(task, '2026-08-31')).toBe(true) // fifth Monday
    expect(taskOverlapsRange(task, '2026-09-01', '2026-09-30')).toBe(false)
    expect(taskOccursOnDate(task, '2026-11-30')).toBe(true)
  })

  it('moves first-day schedules to the first weekday that is not a holiday', () => {
    const task = {
      ...baseTask,
      startDate: '2026-04-30',
      dueDate: '2026-04-30',
      scheduleType: 'monthly-first' as const,
      businessDay: true,
    }
    expect(taskOccursOnDate(task, '2026-05-01')).toBe(false) // Labour Day
    expect(taskOccursOnDate(task, '2026-05-04')).toBe(true)
  })

  it('moves last-day schedules before a weekend', () => {
    const task = {
      ...baseTask,
      startDate: '2026-01-31',
      dueDate: '2026-01-31',
      scheduleType: 'monthly-last' as const,
      businessDay: true,
    }
    expect(taskOccursOnDate(task, '2026-02-27')).toBe(true)
    expect(taskOccursOnDate(task, '2026-02-28')).toBe(false)
  })

  it('preserves the selected duration for every monthly occurrence', () => {
    const task = {
      ...baseTask,
      startDate: '2026-08-30',
      dueDate: '2026-09-01',
      scheduleType: 'monthly-date' as const,
    }
    expect(taskOccurrenceRanges(task, '2026-09-01', '2026-10-31')).toEqual([
      { startDate: '2026-08-30', dueDate: '2026-09-01' },
      { startDate: '2026-09-30', dueDate: '2026-10-02' },
      { startDate: '2026-10-30', dueDate: '2026-11-01' },
    ])
  })
})
