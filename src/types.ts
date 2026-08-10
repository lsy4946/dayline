export type TaskColor = 'coral' | 'violet' | 'sage' | 'blue' | 'amber'

export interface Task {
  id: string
  title: string
  note: string
  dueDate: string
  dueTime: string | null
  color: TaskColor
  completed: boolean
  completedAt: string | null
  deletedAt: string | null
  previousCompleted: boolean | null
  createdAt: string
  updatedAt: string
}

export interface DaylineStore {
  version: 1
  tasks: Task[]
}

export interface WidgetState {
  bounds?: { x?: number; y?: number; width: number; height: number }
  pinned: boolean
  locked: boolean
}

export interface DaylineDesktopApi {
  isDesktop: true
  loadData: () => Promise<DaylineStore>
  saveData: (tasks: Task[]) => Promise<DaylineStore>
  openWidget: () => Promise<WidgetState>
  closeWidget: () => Promise<boolean>
  toggleWidgetPin: () => Promise<{ pinned: boolean } | null>
  toggleWidgetLock: () => Promise<{ locked: boolean } | null>
  resetWidgetBounds: () => Promise<WidgetState['bounds'] | null>
  openMainWindow: () => Promise<boolean>
  getWidgetState: () => Promise<WidgetState>
  onDataChanged: (callback: (store: DaylineStore) => void) => () => void
}

declare global {
  interface Window {
    dayline?: DaylineDesktopApi
  }
}
