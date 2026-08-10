export type TaskColor = 'coral' | 'violet' | 'sage' | 'blue' | 'amber'

export interface SubTask {
  id: string
  title: string
  completed: boolean
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

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
  subTasks: SubTask[]
}

export interface DailyNote {
  id: string
  content: string
  noteDate: string
  completed: boolean
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LegacyMigrationWarning {
  reason: 'invalid-json' | 'read-error' | 'backup-error'
  backupPath: string | null
}

export interface DaylineStore {
  version: 1
  revision: number
  tasks: Task[]
  dailyNotes: DailyNote[]
  migrationWarning: LegacyMigrationWarning | null
}

export type TaskPatch = Partial<Pick<
  Task,
  | 'title'
  | 'note'
  | 'dueDate'
  | 'dueTime'
  | 'color'
  | 'completed'
  | 'completedAt'
  | 'deletedAt'
  | 'previousCompleted'
  | 'updatedAt'
>>

export type SubTaskPatch = Partial<Pick<
  SubTask,
  'title' | 'completed' | 'completedAt' | 'updatedAt'
>>

export type DailyNotePatch = Partial<Pick<
  DailyNote,
  'content' | 'noteDate' | 'completed' | 'completedAt' | 'updatedAt'
>>

export type StoreMutation =
  | { type: 'task:create'; task: Task }
  | { type: 'task:patch'; id: string; changes: TaskPatch }
  | { type: 'subtask:create'; taskId: string; subTask: SubTask }
  | { type: 'subtask:patch'; taskId: string; id: string; changes: SubTaskPatch }
  | { type: 'subtask:delete'; taskId: string; id: string }
  | { type: 'daily-note:create'; note: DailyNote }
  | { type: 'daily-note:patch'; id: string; changes: DailyNotePatch }
  | { type: 'daily-note:delete'; id: string }

export interface WidgetState {
  bounds?: { x?: number; y?: number; width: number; height: number }
  pinned: boolean
  locked: boolean
}

export interface DaylineDesktopApi {
  isDesktop: true
  loadData: () => Promise<DaylineStore>
  applyStoreMutations: (mutations: StoreMutation[]) => DaylineStore
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
