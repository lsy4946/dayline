import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import {
  applyTaskEditChanges,
  createTaskFromTemplate,
  createTaskTemplateFromTask,
  getTaskEditChanges,
  type TaskDraft,
} from './taskDraft'

const task: Task = {
  id: 'task-1',
  title: '기존 제목',
  note: '다른 창에서 유지할 메모',
  startDate: '2026-08-11',
  dueDate: '2026-08-11',
  dueTime: null,
  color: 'coral',
  tagId: 'builtin-coral',
  position: 0,
  completed: false,
  completedAt: null,
  deletedAt: null,
  previousCompleted: null,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
  subTasks: [
    {
      id: 'sub-1',
      title: '기존 하위 일정',
      completed: false,
      completedAt: null,
      createdAt: '2026-08-11T00:01:00.000Z',
      updatedAt: '2026-08-11T00:01:00.000Z',
    },
  ],
}

const draft: TaskDraft = {
  title: task.title,
  note: task.note,
  startDate: task.startDate,
  dueDate: task.dueDate,
  dueTime: task.dueTime,
  color: task.color,
  tagId: task.tagId,
  subTasks: task.subTasks,
}

describe('getTaskEditChanges', () => {
  it('returns no fields when the modal was saved without edits', () => {
    expect(getTaskEditChanges(task, draft, false)).toEqual({ draft: {} })
  })

  it('returns only fields and status actually changed in the modal', () => {
    expect(getTaskEditChanges(
      task,
      { ...draft, dueDate: '2026-08-12', color: 'blue' },
      true,
    )).toEqual({
      draft: { dueDate: '2026-08-12', color: 'blue' },
      completed: true,
    })
  })

  it('returns child-id deltas instead of a stale whole-array replacement', () => {
    const changedChild = {
      ...task.subTasks[0],
      title: '수정한 하위 일정',
      updatedAt: '2026-08-11T01:00:00.000Z',
    }
    const createdChild = {
      ...task.subTasks[0],
      id: 'sub-2',
      title: '새 하위 일정',
    }
    const changes = getTaskEditChanges(task, {
      ...draft,
      subTasks: [changedChild, createdChild],
    }, false)
    expect(changes.subTasks).toEqual({
      created: [createdChild],
      patched: [{
        id: 'sub-1',
        changes: { title: '수정한 하위 일정', updatedAt: '2026-08-11T01:00:00.000Z' },
      }],
      deletedIds: [],
    })
  })

  it('merges modal child edits onto latest concurrent child state', () => {
    const modalDraft = {
      ...draft,
      subTasks: [{ ...task.subTasks[0], title: '모달에서 바꾼 제목' }],
    }
    const changes = getTaskEditChanges(task, modalDraft, false)
    const latestTask = {
      ...task,
      subTasks: [
        {
          ...task.subTasks[0],
          completed: true,
          completedAt: '2026-08-11T02:00:00.000Z',
          updatedAt: '2026-08-11T02:00:00.000Z',
        },
        {
          ...task.subTasks[0],
          id: 'concurrent-child',
          title: '다른 창에서 추가',
        },
      ],
    }
    const merged = applyTaskEditChanges(latestTask, changes)
    expect(merged.subTasks).toHaveLength(2)
    expect(merged.subTasks?.[0]).toMatchObject({
      id: 'sub-1',
      title: '모달에서 바꾼 제목',
      completed: true,
      completedAt: '2026-08-11T02:00:00.000Z',
    })
    expect(merged.subTasks?.[1].id).toBe('concurrent-child')
  })

  it('marks only an explicit parent-state command for child cascading', () => {
    const completedTask: Task = {
      ...task,
      completed: true,
      completedAt: '2026-08-11T02:00:00.000Z',
      subTasks: [
        {
          ...task.subTasks[0],
          completed: true,
          completedAt: '2026-08-11T02:00:00.000Z',
        },
        {
          ...task.subTasks[0],
          id: 'sub-2',
          title: '완료 상태를 유지할 형제',
          completed: true,
          completedAt: '2026-08-11T02:00:00.000Z',
        },
      ],
    }
    const childDerivedDraft: TaskDraft = {
      title: completedTask.title,
      note: completedTask.note,
      startDate: completedTask.startDate,
      dueDate: completedTask.dueDate,
      dueTime: completedTask.dueTime,
      color: completedTask.color,
      tagId: completedTask.tagId,
      subTasks: completedTask.subTasks.map((subTask, index) => index === 0
        ? { ...subTask, completed: false, completedAt: null }
        : subTask),
    }

    const childDerived = getTaskEditChanges(completedTask, childDerivedDraft, false, false)
    expect(childDerived.completed).toBe(false)
    expect(childDerived.cascadeSubTasks).toBeUndefined()
    expect(childDerived.subTasks?.patched).toHaveLength(1)

    const explicitParent = getTaskEditChanges(completedTask, {
      ...childDerivedDraft,
      subTasks: completedTask.subTasks.map((subTask) => ({
        ...subTask,
        completed: false,
        completedAt: null,
      })),
    }, false, true)
    expect(explicitParent).toMatchObject({ completed: false, cascadeSubTasks: true })
  })
})

describe('createTaskFromTemplate', () => {
  it('creates an inclusive duration and fresh child rows at the requested position', () => {
    const ids = ['task-from-template', 'child-one', 'child-two']
    const created = createTaskFromTemplate({
      id: 'template-1',
      title: '주간 계획',
      note: '템플릿 메모',
      dueTime: '09:30',
      tagId: 'builtin-blue',
      legacyColor: 'blue',
      durationDays: 3,
      subTaskTitles: ['첫 단계', '둘째 단계'],
      scheduleType: 'monthly-last',
      businessDay: true,
      position: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }, '2026-08-11', 4, new Date('2026-08-11T03:00:00.000Z'), () => ids.shift()!)

    expect(created).toMatchObject({
      id: 'task-from-template',
      startDate: '2026-08-11',
      dueDate: '2026-08-13',
      tagId: 'builtin-blue',
      color: 'blue',
      position: 4,
      scheduleType: 'monthly-last',
      businessDay: true,
    })
    expect(created.subTasks.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'child-one', title: '첫 단계' },
      { id: 'child-two', title: '둘째 단계' },
    ])
  })

  it('captures the whole task form as a reusable template', () => {
    const template = createTaskTemplateFromTask({
      ...task,
      startDate: '2026-08-11',
      dueDate: '2026-08-13',
      scheduleType: 'monthly-weekday',
      businessDay: false,
    }, 5, new Date('2026-08-14T00:00:00.000Z'), () => 'copied-template')

    expect(template).toMatchObject({
      id: 'copied-template',
      title: task.title,
      note: task.note,
      durationDays: 3,
      subTaskTitles: ['기존 하위 일정'],
      scheduleType: 'monthly-weekday',
      businessDay: false,
      position: 5,
    })
  })
})
