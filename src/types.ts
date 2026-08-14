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
  startDate: string
  dueDate: string
  dueTime: string | null
  color: TaskColor
  tagId: string | null
  position: number
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
  pinned: boolean
  pinnedStartDate: string | null
  pinnedEndDate: string | null
  viewPositions: Record<string, number>
  position: number
  createdAt: string
  updatedAt: string
}

export interface TaskTag {
  id: string
  name: string
  color: string
  builtIn: boolean
  legacyColor: TaskColor | null
  position: number
  createdAt: string
  updatedAt: string
}

export interface AppSettings {
  sidebarSplit: number
  widgetSplit: number
  fontScale: number
  themeColor: string
  calendarWeekScroll: boolean
}

export interface TaskTemplate {
  id: string
  title: string
  note: string
  dueTime: string | null
  tagId: string | null
  legacyColor: TaskColor
  durationDays: number
  subTaskTitles: string[]
  position: number
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
  taskTags: TaskTag[]
  settings: AppSettings
  taskTemplates: TaskTemplate[]
  migrationWarning: LegacyMigrationWarning | null
}

export type TaskPatch = Partial<Pick<
  Task,
  | 'title'
  | 'note'
  | 'startDate'
  | 'dueDate'
  | 'dueTime'
  | 'color'
  | 'tagId'
  | 'position'
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
  | 'content'
  | 'noteDate'
  | 'completed'
  | 'completedAt'
  | 'pinned'
  | 'pinnedStartDate'
  | 'pinnedEndDate'
  | 'viewPositions'
  | 'position'
  | 'updatedAt'
>>

export type TaskTagPatch = Partial<Pick<
  TaskTag,
  'name' | 'color' | 'position' | 'updatedAt'
>>

export type AppSettingsPatch = Partial<AppSettings>

export type TaskTemplatePatch = Partial<Pick<
  TaskTemplate,
  | 'title'
  | 'note'
  | 'dueTime'
  | 'tagId'
  | 'legacyColor'
  | 'durationDays'
  | 'subTaskTitles'
  | 'position'
  | 'updatedAt'
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
  | { type: 'tag:create'; tag: TaskTag }
  | { type: 'tag:patch'; id: string; changes: TaskTagPatch }
  | { type: 'tag:delete'; id: string }
  | { type: 'settings:patch'; changes: AppSettingsPatch }
  | { type: 'template:create'; template: TaskTemplate }
  | { type: 'template:patch'; id: string; changes: TaskTemplatePatch }
  | { type: 'template:delete'; id: string }

export interface WidgetState {
  bounds?: { x?: number; y?: number; width: number; height: number }
  pinned: boolean
  locked: boolean
}

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type UpdateUnsupportedReason =
  | 'qa'
  | 'development'
  | 'platform'
  | 'portable'
  | 'not-installed'

export interface InstalledReleaseHistory {
  state: 'ready' | 'no-baseline' | 'notes-unavailable'
  fromVersion: string | null
  toVersion: string
  releaseName: string | null
  releaseNotes: string | null
  recordedAt: string | null
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  installedReleaseHistory: InstalledReleaseHistory
  progress: number | null
  error: string | null
  unsupportedReason: UpdateUnsupportedReason | null
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface DaylineUpdateApi {
  getState: () => Promise<UpdateState>
  check: () => Promise<UpdateState>
  download: () => Promise<UpdateState>
  install: () => Promise<UpdateState>
  onStateChanged: (callback: (state: UpdateState) => void) => () => void
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
  updates: DaylineUpdateApi
}

declare global {
  interface Window {
    dayline?: DaylineDesktopApi
  }
}
