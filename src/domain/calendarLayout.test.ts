import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import { layoutCalendarTaskSegments } from './calendarLayout'

const timestamp = '2026-08-01T00:00:00.000Z'

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'startDate' | 'dueDate'>): Task {
  const { id, startDate, dueDate, ...rest } = overrides
  return {
    id,
    title: id,
    note: '',
    startDate,
    dueDate,
    dueTime: null,
    color: 'coral',
    tagId: null,
    position: 0,
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    subTasks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...rest,
  }
}

describe('calendar task segment layout', () => {
  it('renders a same-week multi-day task as one spanning segment', () => {
    const task = makeTask({ id: 'span', startDate: '2026-08-03', dueDate: '2026-08-05' })
    const layout = layoutCalendarTaskSegments([task], '2026-08-02', 14)

    expect(layout.segments).toEqual([expect.objectContaining({
      taskId: 'span',
      weekRow: 0,
      lane: 0,
      startColumn: 1,
      endColumn: 3,
      segmentStart: '2026-08-03',
      segmentEnd: '2026-08-05',
      continuesBefore: false,
      continuesAfter: false,
    })])
  })

  it('splits a range only at a week boundary and marks both continuations', () => {
    const task = makeTask({ id: 'week-crossing', startDate: '2026-08-07', dueDate: '2026-08-10' })
    const layout = layoutCalendarTaskSegments([task], '2026-08-02', 14)

    expect(layout.segments).toEqual([
      expect.objectContaining({
        weekRow: 0,
        startColumn: 5,
        endColumn: 6,
        segmentStart: '2026-08-07',
        segmentEnd: '2026-08-08',
        continuesBefore: false,
        continuesAfter: true,
      }),
      expect.objectContaining({
        weekRow: 1,
        startColumn: 0,
        endColumn: 1,
        segmentStart: '2026-08-09',
        segmentEnd: '2026-08-10',
        continuesBefore: true,
        continuesAfter: false,
      }),
    ])
  })

  it('uses deterministic non-overlapping lanes and reuses a free lane', () => {
    const tasks = [
      makeTask({ id: 'a', startDate: '2026-08-02', dueDate: '2026-08-04', position: 0 }),
      makeTask({ id: 'b', startDate: '2026-08-03', dueDate: '2026-08-05', position: 1 }),
      makeTask({ id: 'c', startDate: '2026-08-05', dueDate: '2026-08-06', position: 2 }),
    ]
    const layout = layoutCalendarTaskSegments(tasks, '2026-08-02', 7)
    const byTask = new Map(layout.segments.map((segment) => [segment.taskId, segment]))

    expect(byTask.get('a')?.lane).toBe(0)
    expect(byTask.get('b')?.lane).toBe(1)
    expect(byTask.get('c')?.lane).toBe(0)
  })

  it('reports per-day hidden counts when all visible lanes are occupied', () => {
    const tasks = [
      makeTask({ id: 'visible', startDate: '2026-08-02', dueDate: '2026-08-08', position: 0 }),
      makeTask({ id: 'hidden', startDate: '2026-08-04', dueDate: '2026-08-04', position: 1 }),
    ]
    const layout = layoutCalendarTaskSegments(tasks, '2026-08-02', 7, 1)

    expect(layout.segments.map((segment) => segment.taskId)).toEqual(['visible'])
    expect(layout.dayCounts['2026-08-04']).toEqual({ total: 2, visible: 1, hidden: 1 })
    expect(layout.dayCounts['2026-08-03']).toEqual({ total: 1, visible: 1, hidden: 0 })
  })

  it('keeps lane placement independent from completion state', () => {
    const active = makeTask({ id: 'stable', startDate: '2026-08-03', dueDate: '2026-08-05' })
    const completed = { ...active, completed: true, completedAt: timestamp }

    expect(layoutCalendarTaskSegments([active], '2026-08-02', 7).segments)
      .toEqual(layoutCalendarTaskSegments([completed], '2026-08-02', 7).segments)
  })

  it('assigns one fixed lane across weeks when continuations and a new task compete', () => {
    const tasks = [
      makeTask({ id: 'first-continuing', startDate: '2026-08-07', dueDate: '2026-08-10', position: 0 }),
      makeTask({ id: 'new-next-week', startDate: '2026-08-09', dueDate: '2026-08-10', position: 1 }),
      makeTask({ id: 'last-continuing', startDate: '2026-08-07', dueDate: '2026-08-10', position: 2 }),
    ]
    const segments = layoutCalendarTaskSegments(tasks, '2026-08-02', 14, 3).segments
    const lanesFor = (taskId: string) => segments
      .filter((segment) => segment.taskId === taskId)
      .map((segment) => segment.lane)

    expect(lanesFor('first-continuing')).toEqual([0, 0])
    expect(lanesFor('new-next-week')).toEqual([1])
    expect(lanesFor('last-continuing')).toEqual([2, 2])
  })

  it('clips a task to both grid edges without changing its fixed lane', () => {
    const task = makeTask({
      id: 'outside-both-edges',
      startDate: '2026-07-30',
      dueDate: '2026-08-18',
    })
    const segments = layoutCalendarTaskSegments([task], '2026-08-02', 14).segments

    expect(segments).toEqual([
      expect.objectContaining({
        taskId: task.id,
        weekRow: 0,
        lane: 0,
        segmentStart: '2026-08-02',
        segmentEnd: '2026-08-08',
        continuesBefore: true,
        continuesAfter: true,
      }),
      expect.objectContaining({
        taskId: task.id,
        weekRow: 1,
        lane: 0,
        segmentStart: '2026-08-09',
        segmentEnd: '2026-08-15',
        continuesBefore: true,
        continuesAfter: true,
      }),
    ])
  })

  it('recomputes fixed lanes deterministically from global positions', () => {
    const first = makeTask({
      id: 'first',
      startDate: '2026-08-03',
      dueDate: '2026-08-05',
      position: 0,
    })
    const second = makeTask({
      id: 'second',
      startDate: '2026-08-03',
      dueDate: '2026-08-05',
      position: 1,
    })
    const lanes = (tasks: Task[]) => new Map(
      layoutCalendarTaskSegments(tasks, '2026-08-02', 7).segments
        .map((segment) => [segment.taskId, segment.lane]),
    )

    expect(lanes([second, first])).toEqual(new Map([['first', 0], ['second', 1]]))
    expect(lanes([
      { ...first, position: 1 },
      { ...second, position: 0 },
    ])).toEqual(new Map([['second', 0], ['first', 1]]))
  })

  it('counts a globally unassigned range as hidden on every day it occurs', () => {
    const tasks = [
      makeTask({ id: 'blocker', startDate: '2026-08-02', dueDate: '2026-08-02', position: 0 }),
      makeTask({ id: 'long-range', startDate: '2026-08-02', dueDate: '2026-08-15', position: 1 }),
    ]
    const layout = layoutCalendarTaskSegments(tasks, '2026-08-02', 14, 1)

    expect(layout.segments.map((segment) => segment.taskId)).toEqual(['blocker'])
    expect(layout.dayCounts['2026-08-02']).toEqual({ total: 2, visible: 1, hidden: 1 })
    expect(layout.dayCounts['2026-08-03']).toEqual({ total: 1, visible: 0, hidden: 1 })
    expect(layout.dayCounts['2026-08-15']).toEqual({ total: 1, visible: 0, hidden: 1 })
  })
})
