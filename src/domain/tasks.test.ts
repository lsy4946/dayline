import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaylineStore, StoreMutation, Task, TaskTag, TaskTemplate } from '../types'
import { createBuiltInTaskTags, DEFAULT_APP_SETTINGS, saveStore } from '../lib/storage'
import {
  advanceTaskState,
  isRecoverable,
  moveTaskRange,
  purgeExpired,
  reorderPositioned,
  restoreTask,
  RETENTION_MS,
  setTaskCompleted,
  softDeleteTask,
  sortTasks,
  taskOccursOnDate,
  taskOverlapsRange,
  toggleSubTask,
} from './tasks'
import { inclusiveDateKeys } from './date'

const baseTask: Task = {
  id: 'task-1',
  title: '테스트 일정',
  note: '',
  startDate: '2026-08-10',
  dueDate: '2026-08-10',
  dueTime: null,
  color: 'coral',
  tagId: 'builtin-coral',
  position: 0,
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

  it('uses manual position before every automatic tie breaker', () => {
    const tasks = [
      { ...baseTask, id: 'first', position: 0, dueTime: null },
      { ...baseTask, id: 'second', position: 1, dueTime: '08:00' },
    ]
    expect(sortTasks(tasks).map((task) => task.id)).toEqual(['first', 'second'])
  })

  it('reorders only listed rows and emits deterministic positions', () => {
    const tasks = [
      { ...baseTask, id: 'a', position: 0 },
      { ...baseTask, id: 'b', position: 1 },
      { ...baseTask, id: 'outside', position: 9 },
    ]
    const reordered = reorderPositioned(tasks, ['b', 'a'], new Date('2026-08-10T06:00:00.000Z'))
    expect(reordered.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: 'a', position: 1 },
      { id: 'b', position: 0 },
      { id: 'outside', position: 9 },
    ])
    expect(reordered[2]).toBe(tasks[2])
  })
})

describe('inclusive task ranges', () => {
  const rangeTask = { ...baseTask, startDate: '2026-08-10', dueDate: '2026-08-12' }

  it('includes both period boundaries and every calendar day between them', () => {
    expect(inclusiveDateKeys(rangeTask.startDate, rangeTask.dueDate)).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12',
    ])
    expect(taskOccursOnDate(rangeTask, '2026-08-10')).toBe(true)
    expect(taskOccursOnDate(rangeTask, '2026-08-12')).toBe(true)
    expect(taskOccursOnDate(rangeTask, '2026-08-13')).toBe(false)
  })

  it('detects range overlap at a shared boundary', () => {
    expect(taskOverlapsRange(rangeTask, '2026-08-12', '2026-08-14')).toBe(true)
    expect(taskOverlapsRange(rangeTask, '2026-08-13', '2026-08-14')).toBe(false)
  })

  it.each([
    ['month end', '2026-01-30', '2026-02-01'],
    ['year end', '2026-12-31', '2027-01-02'],
    ['leap day', '2028-02-28', '2028-03-01'],
  ])('moves an inclusive three-day range across %s', (_boundary, targetStart, expectedDueDate) => {
    const moved = moveTaskRange(
      [rangeTask],
      rangeTask.id,
      targetStart,
      new Date('2026-08-10T06:00:00.000Z'),
    )

    expect(moved[0].startDate).toBe(targetStart)
    expect(moved[0].dueDate).toBe(expectedDueDate)
    expect(inclusiveDateKeys(moved[0].startDate, moved[0].dueDate)).toHaveLength(3)
  })

  it('changes only the date range and updated timestamp', () => {
    const peer = { ...baseTask, id: 'peer', position: 8 }
    const task = {
      ...rangeTask,
      note: '보존할 메모',
      dueTime: '14:30',
      color: 'violet' as const,
      tagId: 'builtin-violet',
      position: 7,
      completed: true,
      completedAt: '2026-08-10T04:00:00.000Z',
      previousCompleted: false,
      subTasks,
    }
    const tasks = [task, peer]
    const moved = moveTaskRange(tasks, task.id, '2026-09-20', new Date('2026-09-01T05:00:00.000Z'))
    const { startDate: _oldStart, dueDate: _oldDue, updatedAt: _oldUpdated, ...oldFields } = task
    const { startDate, dueDate, updatedAt, ...movedFields } = moved[0]

    expect(moved).not.toBe(tasks)
    expect(moved[0]).not.toBe(task)
    expect(moved[1]).toBe(peer)
    expect({ startDate, dueDate, updatedAt }).toEqual({
      startDate: '2026-09-20',
      dueDate: '2026-09-22',
      updatedAt: '2026-09-01T05:00:00.000Z',
    })
    expect(movedFields).toEqual(oldFields)
    expect(moved[0].subTasks).toBe(subTasks)
  })

  it('preserves array and row identities for same-start, missing, deleted, and invalid moves', () => {
    const tasks = [rangeTask]
    expect(moveTaskRange(tasks, rangeTask.id, rangeTask.startDate)).toBe(tasks)
    expect(moveTaskRange(tasks, 'missing', '2026-09-01')).toBe(tasks)

    const deleted = { ...rangeTask, deletedAt: '2026-08-13T00:00:00.000Z' }
    const deletedTasks = [deleted]
    expect(moveTaskRange(deletedTasks, deleted.id, '2026-09-01')).toBe(deletedTasks)
    expect(moveTaskRange(tasks, rangeTask.id, '2026-02-30')).toBe(tasks)
    expect(tasks[0]).toBe(rangeTask)
    expect(deletedTasks[0]).toBe(deleted)
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

describe('tag deletion mutation compaction', () => {
  const timestamp = '2026-08-10T00:00:00.000Z'
  const changedAt = '2026-08-10T01:00:00.000Z'

  afterEach(() => vi.unstubAllGlobals())

  function stores(taskCount: number): { previous: DaylineStore; next: DaylineStore } {
    const builtIns = createBuiltInTaskTags(timestamp)
    const customTag: TaskTag = {
      id: 'custom-shared',
      name: '공유 태그',
      color: '#123456',
      builtIn: false,
      legacyColor: null,
      position: builtIns.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const taskTemplate: TaskTemplate = {
      id: 'template-shared',
      title: '공유 템플릿',
      note: '원본 메모',
      dueTime: null,
      tagId: customTag.id,
      legacyColor: 'coral',
      durationDays: 1,
      subTaskTitles: [],
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const tasks = Array.from({ length: taskCount }, (_, position): Task => ({
      ...baseTask,
      id: `shared-task-${position}`,
      title: `공유 일정 ${position}`,
      tagId: customTag.id,
      position,
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
    const previous: DaylineStore = {
      version: 1,
      revision: 1,
      tasks,
      dailyNotes: [],
      taskTags: [...builtIns, customTag],
      settings: { ...DEFAULT_APP_SETTINGS },
      taskTemplates: [taskTemplate],
      migrationWarning: null,
    }
    return {
      previous,
      next: {
        ...previous,
        tasks: tasks.map((task, index) => ({
          ...task,
          tagId: null,
          ...(index === 0 ? { title: '함께 수정한 일정', updatedAt: changedAt } : {}),
        })),
        taskTags: builtIns,
        taskTemplates: [{
          ...taskTemplate,
          tagId: null,
          note: '함께 수정한 메모',
          updatedAt: changedAt,
        }],
      },
    }
  }

  it('delegates 1000 reference clears to one tag delete while preserving other dirty fields', () => {
    const { previous, next } = stores(1000)
    let captured: StoreMutation[] = []
    vi.stubGlobal('window', {
      dayline: {
        applyStoreMutations: (mutations: StoreMutation[]) => {
          captured = mutations
          return next
        },
      },
    })

    saveStore(previous, next)

    expect(captured).toHaveLength(3)
    const taskPatches = captured.filter((mutation) => mutation.type === 'task:patch')
    const templatePatches = captured.filter((mutation) => mutation.type === 'template:patch')
    expect(taskPatches).toHaveLength(1)
    expect(taskPatches[0]).toMatchObject({
      id: 'shared-task-0',
      changes: { title: '함께 수정한 일정', updatedAt: changedAt },
    })
    expect(taskPatches[0].changes).not.toHaveProperty('tagId')
    expect(templatePatches).toHaveLength(1)
    expect(templatePatches[0]).toMatchObject({
      id: 'template-shared',
      changes: { note: '함께 수정한 메모', updatedAt: changedAt },
    })
    expect(templatePatches[0].changes).not.toHaveProperty('tagId')
    expect(captured).toContainEqual({ type: 'tag:delete', id: 'custom-shared' })
  })

  it('returns canonical null references after the browser tag-delete cascade', () => {
    const { previous, next } = stores(2)
    const values = new Map<string, string>()
    const browserStorage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
    } satisfies Storage
    browserStorage.setItem('dayline-browser-store-v1', JSON.stringify(previous))
    vi.stubGlobal('localStorage', browserStorage)
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    const canonical = saveStore(previous, next)

    expect(canonical.tasks.every((task) => task.tagId === null)).toBe(true)
    expect(canonical.taskTemplates[0].tagId).toBeNull()
    expect(canonical.tasks[0].title).toBe('함께 수정한 일정')
    expect(canonical.taskTemplates[0].note).toBe('함께 수정한 메모')
    expect(canonical.taskTags.some((tag) => tag.id === 'custom-shared')).toBe(false)
  })
})
