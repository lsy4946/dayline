import type { DaylineStore, Task } from '../types'
import { addDaysKey, todayKey } from '../domain/date'
import { purgeExpired } from '../domain/tasks'

const BROWSER_STORAGE_KEY = 'dayline-browser-store-v1'

function browserSeed(): DaylineStore {
  const now = new Date()
  const nowIso = now.toISOString()
  const deletedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const makeId = () => crypto.randomUUID()
  return {
    version: 1,
    tasks: [
      {
        id: makeId(),
        title: 'Dayline 프로토타입 살펴보기',
        note: '한 번 누르면 완료, 완료된 일정을 다시 누르면 최근 삭제로 이동해요.',
        dueDate: todayKey(),
        dueTime: null,
        color: 'coral',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: makeId(),
        title: '오늘의 우선순위 정리',
        note: '',
        dueDate: todayKey(),
        dueTime: '10:30',
        color: 'violet',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: makeId(),
        title: '오프라인 저장 동작 확인',
        note: '완료 상태도 앱을 다시 열었을 때 그대로 유지됩니다.',
        dueDate: todayKey(),
        dueTime: null,
        color: 'sage',
        completed: true,
        completedAt: nowIso,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: makeId(),
        title: '주간 계획 초안',
        note: '',
        dueDate: addDaysKey(todayKey(), 1),
        dueTime: null,
        color: 'blue',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: makeId(),
        title: '프로젝트 회고',
        note: '잘된 점과 다음 개선점을 기록하기',
        dueDate: addDaysKey(todayKey(), 3),
        dueTime: '15:00',
        color: 'amber',
        completed: false,
        completedAt: null,
        deletedAt: null,
        previousCompleted: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: makeId(),
        title: '복구 기능 예시 일정',
        note: '최근 삭제에서 복구할 수 있는 예시입니다.',
        dueDate: addDaysKey(todayKey(), -3),
        dueTime: null,
        color: 'blue',
        completed: true,
        completedAt: nowIso,
        deletedAt,
        previousCompleted: true,
        createdAt: nowIso,
        updatedAt: deletedAt,
      },
    ],
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
    const parsed = JSON.parse(raw) as DaylineStore
    return { version: 1, tasks: purgeExpired(parsed.tasks ?? []) }
  } catch {
    const seed = browserSeed()
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export async function saveStore(tasks: Task[]): Promise<DaylineStore> {
  const safeTasks = purgeExpired(tasks)
  if (window.dayline) return window.dayline.saveData(safeTasks)
  const store: DaylineStore = { version: 1, tasks: safeTasks }
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(store))
  window.dispatchEvent(new CustomEvent('dayline-browser-data', { detail: store }))
  return store
}

export function subscribeToStore(callback: (store: DaylineStore) => void): () => void {
  if (window.dayline) return window.dayline.onDataChanged(callback)
  const listener = (event: Event) => callback((event as CustomEvent<DaylineStore>).detail)
  window.addEventListener('dayline-browser-data', listener)
  return () => window.removeEventListener('dayline-browser-data', listener)
}
