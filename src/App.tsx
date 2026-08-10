import {
  ArchiveRestore,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GripHorizontal,
  History,
  LayoutGrid,
  Lock,
  Maximize2,
  MonitorUp,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  addDaysKey,
  calendarDays,
  formatCompactDate,
  formatFullDate,
  formatMonthTitle,
  fromDateKey,
  getWeekendKey,
  shiftMonth,
  startOfMonth,
  todayKey,
  weekDaysAround,
} from './domain/date'
import {
  advanceTaskState,
  deletedTasks,
  remainingRetentionDays,
  restoreTask,
  setTaskCompleted,
  softDeleteTask,
  sortTasks,
  visibleTasks,
} from './domain/tasks'
import { loadStore, saveStore, subscribeToStore } from './lib/storage'
import type { Task, TaskColor, WidgetState } from './types'

type AppMode = 'main' | 'widget'

interface ToastMessage {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface TaskDraft {
  title: string
  note: string
  dueDate: string
  dueTime: string | null
  color: TaskColor
}

const COLOR_OPTIONS: Array<{ value: TaskColor; label: string }> = [
  { value: 'coral', label: '코랄' },
  { value: 'violet', label: '라일락' },
  { value: 'sage', label: '세이지' },
  { value: 'blue', label: '블루' },
  { value: 'amber', label: '앰버' },
]

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function useTaskStore() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const tasksRef = useRef<Task[]>([])

  useEffect(() => {
    let active = true
    loadStore()
      .then((store) => {
        if (!active) return
        tasksRef.current = store.tasks
        setTasks(store.tasks)
      })
      .catch(() => {
        if (active) setError('로컬 데이터를 불러오지 못했어요.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    const unsubscribe = subscribeToStore((store) => {
      if (!active) return
      tasksRef.current = store.tasks
      setTasks(store.tasks)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const commit = useCallback((updater: (current: Task[]) => Task[]) => {
    const previous = tasksRef.current
    const next = updater(previous)
    tasksRef.current = next
    setTasks(next)
    setError(null)
    void saveStore(next)
      .then((store) => {
        tasksRef.current = store.tasks
        setTasks(store.tasks)
      })
      .catch(() => {
        tasksRef.current = previous
        setTasks(previous)
        setError('저장하지 못했어요. 다시 시도해 주세요.')
      })
    return next
  }, [])

  return { tasks, tasksRef, loading, error, commit }
}

function IconButton({
  label,
  children,
  onClick,
  className = '',
  active = false,
  disabled = false,
}: {
  label: string
  children: ReactNode
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  className?: string
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-mark ${compact ? 'is-compact' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}

function TaskChip({
  task,
  onOpen,
  onSecondaryAction,
}: {
  task: Task
  onOpen: (task: Task) => void
  onSecondaryAction: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`task-chip color-${task.color} ${task.completed ? 'is-completed' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(task)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onSecondaryAction(task.id)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        event.stopPropagation()
        onSecondaryAction(task.id)
      }}
      title={`${task.title} · 좌클릭 상세 보기 · 우클릭 ${task.completed ? '최근 삭제로 이동' : '비활성화'}`}
      aria-label={`${task.title}, ${task.completed ? '비활성' : '활성'} 일정. 상세 보기`}
    >
      <span className="task-chip-dot">{task.completed && <Check size={9} strokeWidth={3} />}</span>
      {task.dueTime && <span className="task-chip-time">{task.dueTime}</span>}
      <span className="task-chip-title">{task.title}</span>
    </button>
  )
}

function TaskRow({
  task,
  onOpen,
  onSecondaryAction,
  compact = false,
}: {
  task: Task
  onOpen: (task: Task) => void
  onSecondaryAction: (id: string) => void
  compact?: boolean
}) {
  return (
    <article
      className={`task-row color-${task.color} ${task.completed ? 'is-completed' : ''} ${compact ? 'is-compact' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        onSecondaryAction(task.id)
      }}
    >
      <button
        type="button"
        className="task-row-main"
        onClick={() => onOpen(task)}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          onSecondaryAction(task.id)
        }}
        aria-label={`${task.title}, ${task.completed ? '비활성' : '활성'} 일정. 상세 보기`}
        title={`좌클릭 상세 보기 · 우클릭 ${task.completed ? '최근 삭제로 이동' : '비활성화'}`}
      >
        <span className="task-status" aria-hidden="true">
          {task.completed ? <Check size={13} strokeWidth={3} /> : <span />}
        </span>
        <span className="task-copy">
          <span className="task-title">{task.title}</span>
          <span className="task-meta">
            {task.dueTime ? (
              <>
                <Clock3 size={12} /> {task.dueTime}
              </>
            ) : (
              '시간 없음'
            )}
            {task.completed && <span className="completed-label">비활성</span>}
          </span>
        </span>
      </button>
    </article>
  )
}

function EmptyState({ onAdd, compact = false }: { onAdd?: () => void; compact?: boolean }) {
  return (
    <div className={`empty-state ${compact ? 'is-compact' : ''}`}>
      <div className="empty-orbit">
        <Sparkles size={compact ? 17 : 20} />
      </div>
      <strong>여백이 있는 하루예요</strong>
      <span>{compact ? '새 일정을 가볍게 더해보세요.' : '해야 할 일이 생기면 여기에 기록해 보세요.'}</span>
      {onAdd && (
        <button type="button" className="text-button" onClick={onAdd}>
          <Plus size={14} /> 일정 추가
        </button>
      )}
    </div>
  )
}

function TaskModal({
  open,
  initialDate,
  task,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  initialDate: string
  task: Task | null
  onClose: () => void
  onSave: (draft: TaskDraft, taskId?: string, completed?: boolean) => void
  onDelete: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [dueDate, setDueDate] = useState(initialDate)
  const [timeEnabled, setTimeEnabled] = useState(false)
  const [dueTime, setDueTime] = useState('09:00')
  const [color, setColor] = useState<TaskColor>('coral')
  const [completed, setCompleted] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? '')
    setNote(task?.note ?? '')
    setDueDate(task?.dueDate ?? initialDate)
    setTimeEnabled(Boolean(task?.dueTime))
    setDueTime(task?.dueTime ?? '09:00')
    setColor(task?.color ?? 'coral')
    setCompleted(task?.completed ?? false)
    setConfirmDelete(false)
    const timer = window.setTimeout(() => titleInputRef.current?.focus(), 90)
    return () => window.clearTimeout(timer)
  }, [open, task, initialDate])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmDelete) setConfirmDelete(false)
      else onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [confirmDelete, open, onClose])

  if (!open) return null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !dueDate) return
    onSave(
      {
        title: title.trim(),
        note: note.trim(),
        dueDate,
        dueTime: timeEnabled ? dueTime : null,
        color,
      },
      task?.id,
      task ? completed : undefined,
    )
  }

  const quickDates = [
    { label: '오늘', value: todayKey() },
    { label: '내일', value: addDaysKey(todayKey(), 1) },
    { label: '이번 주말', value: getWeekendKey() },
  ]

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{task ? 'SCHEDULE DETAILS' : 'NEW SCHEDULE'}</span>
            <h2 id="task-modal-title">{task ? '일정 상세 및 수정' : '새 일정 만들기'}</h2>
          </div>
          <IconButton label="닫기" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </header>

        <form onSubmit={submit}>
          {task && (
            <section className="task-state-card" aria-label="일정 상태 관리">
              <div className="task-state-heading">
                <div>
                  <span>일정 상태</span>
                  <small>변경 저장을 눌러야 반영돼요.</small>
                </div>
                <strong className={completed ? 'is-inactive' : 'is-active'}>
                  {completed ? '비활성' : '활성'}
                </strong>
              </div>
              <div className="task-state-controls" role="group" aria-label="활성 상태 선택">
                <button
                  type="button"
                  className={!completed ? 'is-selected' : ''}
                  aria-pressed={!completed}
                  onClick={() => setCompleted(false)}
                >
                  <RotateCcw size={14} /> 활성
                </button>
                <button
                  type="button"
                  className={completed ? 'is-selected' : ''}
                  aria-pressed={completed}
                  onClick={() => setCompleted(true)}
                >
                  <Check size={14} /> 비활성
                </button>
                <button
                  type="button"
                  className="task-remove-button"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} /> 제거
                </button>
              </div>
            </section>
          )}

          <label className="field-group">
            <span className="field-label">할 일</span>
            <input
              ref={titleInputRef}
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="무엇을 해야 하나요?"
              maxLength={240}
              required
            />
          </label>

          <div className="date-priority-card">
            <div className="field-group date-field">
              <span className="field-label">
                <CalendarDays size={15} /> 마감 날짜
                <span className="required-pill">필수</span>
              </span>
              <input
                type="date"
                value={dueDate}
                onInput={(event) => setDueDate(event.currentTarget.value)}
                required
                aria-label="마감 날짜"
              />
              <div className="quick-date-row">
                {quickDates.map((quick) => (
                  <button
                    type="button"
                    key={quick.label}
                    className={dueDate === quick.value ? 'is-selected' : ''}
                    onClick={() => setDueDate(quick.value)}
                  >
                    {quick.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={`optional-time ${timeEnabled ? 'is-open' : ''}`}>
              <button
                type="button"
                className="time-toggle"
                role="switch"
                aria-checked={timeEnabled}
                onClick={() => {
                  setTimeEnabled((current) => !current)
                  if (timeEnabled) setDueTime('09:00')
                }}
              >
                <span className="switch-track"><span /></span>
                <span>
                  <strong>시간도 지정</strong>
                  <small>필요할 때만 추가하세요</small>
                </span>
                <Clock3 size={17} />
              </button>
              {timeEnabled && (
                <label className="time-input-wrap">
                  <span>마감 시간</span>
                  <input
                    type="time"
                    value={dueTime}
                    onInput={(event) => setDueTime(event.currentTarget.value)}
                    aria-label="마감 시간"
                  />
                </label>
              )}
            </div>
          </div>

          <label className="field-group">
            <span className="field-label">메모 <span className="optional-label">선택</span></span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="필요한 맥락이나 준비물을 적어두세요."
              rows={3}
              maxLength={2000}
            />
          </label>

          <fieldset className="color-field">
            <legend>일정 색상</legend>
            <div className="color-options">
              {COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`color-option color-${option.value} ${color === option.value ? 'is-selected' : ''}`}
                  onClick={() => setColor(option.value)}
                  aria-label={`${option.label} 색상`}
                  aria-pressed={color === option.value}
                >
                  <span>{color === option.value && <Check size={13} strokeWidth={3} />}</span>
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <footer className="modal-footer">
            <span>{task ? '내용과 상태 변경은 저장 버튼을 눌러 반영해요.' : '날짜만 선택해도 바로 저장할 수 있어요.'}</span>
            <div>
              <button type="button" className="secondary-button" onClick={onClose}>취소</button>
              <button type="submit" className="primary-button" disabled={!title.trim() || !dueDate}>
                {task ? '변경 저장' : '일정 추가'}
              </button>
            </div>
          </footer>
        </form>
      </section>

      {task && confirmDelete && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            event.stopPropagation()
            if (event.target === event.currentTarget) setConfirmDelete(false)
          }}
        >
          <section
            className="delete-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            aria-describedby="delete-confirm-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="delete-confirm-icon" aria-hidden="true"><Trash2 size={19} /></span>
            <div>
              <h3 id="delete-confirm-title">일정을 삭제할까요?</h3>
              <p id="delete-confirm-description">
                <strong>{task.title}</strong> 일정이 캘린더에서 사라집니다. 최근 삭제에서 30일간 복구할 수 있어요.
              </p>
            </div>
            <div className="delete-confirm-actions">
              <button
                type="button"
                className="secondary-button"
                autoFocus
                onClick={() => setConfirmDelete(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="delete-confirm-button"
                onClick={() => {
                  setConfirmDelete(false)
                  onDelete(task.id)
                  onClose()
                }}
              >
                삭제
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function RecoveryPanel({
  open,
  tasks,
  onClose,
  onRestore,
}: {
  open: boolean
  tasks: Task[]
  onClose: () => void
  onRestore: (id: string) => void
}) {
  useEffect(() => {
    if (!open) return
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  return (
    <div className={`recovery-layer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <button type="button" className="recovery-scrim" aria-label="최근 삭제 닫기" onClick={onClose} />
      <aside className="recovery-panel" aria-label="최근 삭제">
        <header>
          <div className="recovery-icon"><ArchiveRestore size={21} /></div>
          <div>
            <span className="eyebrow">RECOVERY</span>
            <h2>최근 삭제</h2>
          </div>
          <IconButton label="닫기" onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="retention-note">
          <History size={17} />
          <p><strong>삭제한 날부터 30일간 보관해요.</strong><span>기간이 지나면 기기에서 자동으로 정리됩니다.</span></p>
        </div>
        <div className="recovery-list">
          {tasks.length === 0 ? (
            <div className="recovery-empty">
              <ArchiveRestore size={28} />
              <strong>최근 삭제한 일정이 없어요</strong>
              <span>삭제된 일정은 이곳에서 30일간 복구할 수 있어요.</span>
            </div>
          ) : (
            tasks.map((task) => (
              <article key={task.id} className="recovery-item">
                <span className={`recovery-color color-${task.color}`} />
                <div className="recovery-copy">
                  <strong>{task.title}</strong>
                  <span>원래 일정 · {formatCompactDate(task.dueDate)}{task.dueTime ? ` ${task.dueTime}` : ''}</span>
                  <span className="recovery-status">
                    {task.completed ? '비활성 상태' : '활성 상태'} · {remainingRetentionDays(task)}일 남음
                  </span>
                </div>
                <button type="button" className="restore-button" onClick={() => onRestore(task.id)}>
                  <RotateCcw size={14} /> 복구
                </button>
              </article>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}

function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(onClose, toast.actionLabel ? 5200 : 3400)
    return () => window.clearTimeout(timer)
  }, [toast, onClose])
  if (!toast) return null
  return (
    <div className="toast" role="status">
      <span className="toast-check"><Check size={13} strokeWidth={3} /></span>
      <span>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          onClick={() => {
            toast.onAction?.()
            onClose()
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <IconButton label="알림 닫기" onClick={onClose}><X size={14} /></IconButton>
    </div>
  )
}

interface SharedViewProps {
  tasks: Task[]
  loading: boolean
  error: string | null
  onTaskSecondaryAction: (id: string) => void
  onTaskDelete: (id: string) => void
  onTaskRestore: (id: string) => void
  onCreate: (draft: TaskDraft) => void
  onUpdate: (id: string, draft: TaskDraft, completed?: boolean) => void
}

function MainView(props: SharedViewProps) {
  const {
    tasks,
    loading,
    error,
    onTaskSecondaryAction,
    onTaskDelete,
    onTaskRestore,
    onCreate,
    onUpdate,
  } = props
  const today = todayKey()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState(today)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const active = useMemo(() => visibleTasks(tasks), [tasks])
  const deleted = useMemo(() => deletedTasks(tasks), [tasks])
  const normalizedSearch = search.trim().toLocaleLowerCase('ko-KR')
  const filtered = useMemo(
    () =>
      normalizedSearch
        ? active.filter((task) => `${task.title} ${task.note}`.toLocaleLowerCase('ko-KR').includes(normalizedSearch))
        : active,
    [active, normalizedSearch],
  )
  const days = useMemo(() => calendarDays(month), [month])
  const selectedTasks = useMemo(
    () => sortTasks(filtered.filter((task) => task.dueDate === selectedDate)),
    [filtered, selectedDate],
  )
  const monthTasks = useMemo(
    () => active.filter((task) => {
      const date = fromDateKey(task.dueDate)
      return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth()
    }),
    [active, month],
  )
  const monthCompleted = monthTasks.filter((task) => task.completed).length
  const selectedCompleted = selectedTasks.filter((task) => task.completed).length

  const openCreate = (date = selectedDate) => {
    setSelectedDate(date)
    setEditingTask(null)
    setModalOpen(true)
  }

  const openTask = (task: Task) => {
    setSelectedDate(task.dueDate)
    setEditingTask(task)
    setModalOpen(true)
  }

  const chooseDate = (key: string) => {
    setSelectedDate(key)
    const date = fromDateKey(key)
    if (date.getMonth() !== month.getMonth() || date.getFullYear() !== month.getFullYear()) {
      setMonth(startOfMonth(date))
    }
  }

  const goToday = () => {
    setSelectedDate(today)
    setMonth(startOfMonth(new Date()))
  }

  const handleCellKey = (event: KeyboardEvent<HTMLDivElement>, key: string) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      chooseDate(key)
    }
  }

  if (loading) {
    return (
      <div className="app-loading">
        <BrandMark />
        <span>캘린더를 정리하고 있어요…</span>
      </div>
    )
  }

  return (
    <div className="main-shell">
      <aside className="side-rail">
        <div className="rail-brand"><BrandMark /></div>
        <nav aria-label="주요 메뉴">
          <IconButton label="캘린더" active><LayoutGrid size={20} /></IconButton>
          <IconButton
            label={`최근 삭제 ${deleted.length}개`}
            active={recoveryOpen}
            onClick={() => setRecoveryOpen(true)}
          >
            <History size={20} />
            {deleted.length > 0 && <span className="nav-badge">{deleted.length}</span>}
          </IconButton>
        </nav>
        <div className="rail-bottom">
          <span className="offline-dot" title="오프라인 저장 사용 중" />
          <span>LOCAL</span>
        </div>
      </aside>

      <main className="calendar-workspace">
        <header className="app-header">
          <div className="header-title">
            <span className="eyebrow">CALENDAR</span>
            <div>
              <h1>{formatMonthTitle(month)}</h1>
              <span className="month-summary">{monthTasks.length}개의 일정 · {monthCompleted}개 비활성</span>
            </div>
          </div>
          <div className="header-actions">
            <div className={`search-control ${searchOpen ? 'is-open' : ''}`}>
              <Search size={17} />
              {searchOpen && (
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="일정 검색"
                  aria-label="일정 검색"
                />
              )}
              <button
                type="button"
                aria-label={searchOpen ? '검색 닫기' : '검색 열기'}
                onClick={() => {
                  if (searchOpen && search) setSearch('')
                  else setSearchOpen((current) => !current)
                }}
              >
                {searchOpen ? <X size={15} /> : <span />}
              </button>
            </div>
            <button
              type="button"
              className="widget-launch"
              onClick={() => void window.dayline?.openWidget()}
              disabled={!window.dayline}
              title={window.dayline ? '별도 위젯 창 열기' : '설치된 데스크톱 앱에서 사용할 수 있어요'}
            >
              <MonitorUp size={17} /> 위젯 띄우기
            </button>
            <button type="button" className="primary-button header-add" onClick={() => openCreate()}>
              <Plus size={17} /> 새 일정
            </button>
          </div>
        </header>

        {error && <div className="error-banner" role="alert">{error}</div>}

        <section className="calendar-card" aria-label={`${formatMonthTitle(month)} 일정 캘린더`}>
          <div className="calendar-toolbar">
            <div className="month-navigation">
              <IconButton label="이전 달" onClick={() => setMonth((current) => shiftMonth(current, -1))}>
                <ChevronLeft size={18} />
              </IconButton>
              <button type="button" className="today-button" onClick={goToday}>오늘</button>
              <IconButton label="다음 달" onClick={() => setMonth((current) => shiftMonth(current, 1))}>
                <ChevronRight size={18} />
              </IconButton>
            </div>
            <div className="calendar-hint">
              <span><i className="hint-dot active" /> 활성</span>
              <span><i className="hint-dot done" /> 비활성</span>
            </div>
          </div>

          <div className="weekday-row" aria-hidden="true">
            {WEEKDAYS.map((day, index) => <span key={day} className={index === 0 ? 'is-sunday' : index === 6 ? 'is-saturday' : ''}>{day}</span>)}
          </div>
          <div className="calendar-grid">
            {days.map((day) => {
              const dayTasks = sortTasks(filtered.filter((task) => task.dueDate === day.key))
              const hiddenCount = Math.max(0, dayTasks.length - 3)
              const selected = selectedDate === day.key
              return (
                <div
                  key={day.key}
                  className={`calendar-cell ${!day.inCurrentMonth ? 'is-outside' : ''} ${day.key === today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}`}
                  role="button"
                  tabIndex={day.inCurrentMonth ? 0 : -1}
                  aria-label={`${formatFullDate(day.key)}, 일정 ${dayTasks.length}개`}
                  onClick={() => chooseDate(day.key)}
                  onDoubleClick={() => openCreate(day.key)}
                  onKeyDown={(event) => handleCellKey(event, day.key)}
                >
                  <div className="cell-topline">
                    <span className="date-number">{day.date.getDate()}</span>
                    <button
                      type="button"
                      className="cell-add"
                      aria-label={`${formatCompactDate(day.key)}에 일정 추가`}
                      onClick={(event) => {
                        event.stopPropagation()
                        openCreate(day.key)
                      }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="cell-tasks">
                    {dayTasks.slice(0, 3).map((task) => (
                      <TaskChip key={task.id} task={task} onOpen={openTask} onSecondaryAction={onTaskSecondaryAction} />
                    ))}
                    {hiddenCount > 0 && <span className="more-tasks">+ {hiddenCount}개 더 보기</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </main>

      <aside className="day-panel">
        <header className="day-panel-header">
          <div>
            <span className="eyebrow">SELECTED DAY</span>
            <h2>{formatFullDate(selectedDate)}</h2>
          </div>
          <button type="button" className="round-add" onClick={() => openCreate()} aria-label="선택한 날짜에 일정 추가">
            <Plus size={19} />
          </button>
        </header>

        <div className="day-progress">
          <div>
            <span>오늘의 흐름</span>
            <strong>{selectedCompleted}<small> / {selectedTasks.length}</small></strong>
          </div>
          <div className="progress-track"><span style={{ width: `${selectedTasks.length ? (selectedCompleted / selectedTasks.length) * 100 : 0}%` }} /></div>
          <p>{selectedTasks.length === 0 ? '아직 등록된 일정이 없어요.' : selectedCompleted === selectedTasks.length ? '모든 일정이 비활성 상태예요.' : '좌클릭은 상세 보기, 우클릭은 즉시 상태 변경이에요.'}</p>
        </div>

        <div className="day-list-header">
          <span>일정</span>
          <span>{selectedTasks.length}</span>
        </div>
        <div className="day-task-list">
          {selectedTasks.length === 0 ? (
            <EmptyState onAdd={() => openCreate()} />
          ) : (
            selectedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={openTask}
                onSecondaryAction={onTaskSecondaryAction}
              />
            ))
          )}
        </div>

        <div className="panel-tip">
          <span className="tip-icon"><Check size={14} /></span>
          <p><strong>활성 일정은 우클릭하면 비활성으로 바뀌어요.</strong><span>비활성 일정을 다시 우클릭하면 최근 삭제로 이동합니다.</span></p>
        </div>
      </aside>

      <TaskModal
        open={modalOpen}
        initialDate={selectedDate}
        task={editingTask}
        onClose={() => {
          setModalOpen(false)
          setEditingTask(null)
        }}
        onSave={(draft, id, completed) => {
          if (id) onUpdate(id, draft, completed)
          else onCreate(draft)
          setSelectedDate(draft.dueDate)
          setMonth(startOfMonth(fromDateKey(draft.dueDate)))
          setModalOpen(false)
          setEditingTask(null)
        }}
        onDelete={onTaskDelete}
      />
      <RecoveryPanel open={recoveryOpen} tasks={deleted} onClose={() => setRecoveryOpen(false)} onRestore={onTaskRestore} />
    </div>
  )
}

function WidgetView(props: SharedViewProps) {
  const {
    tasks,
    loading,
    error,
    onTaskSecondaryAction,
    onTaskDelete,
    onCreate,
    onUpdate,
  } = props
  const today = todayKey()
  const [selectedDate, setSelectedDate] = useState(today)
  const [quickTitle, setQuickTitle] = useState('')
  const [widgetState, setWidgetState] = useState<WidgetState>({ pinned: true, locked: false })
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const active = useMemo(() => visibleTasks(tasks), [tasks])
  const selectedTasks = useMemo(
    () => sortTasks(active.filter((task) => task.dueDate === selectedDate)),
    [active, selectedDate],
  )
  const completedCount = selectedTasks.filter((task) => task.completed).length
  const week = useMemo(() => weekDaysAround(selectedDate), [selectedDate])

  useEffect(() => {
    void window.dayline?.getWidgetState().then(setWidgetState)
  }, [])

  const addQuickTask = (event: FormEvent) => {
    event.preventDefault()
    if (!quickTitle.trim()) return
    onCreate({
      title: quickTitle.trim(),
      note: '',
      dueDate: selectedDate,
      dueTime: null,
      color: 'coral',
    })
    setQuickTitle('')
  }

  const openTask = (task: Task) => {
    setSelectedDate(task.dueDate)
    setEditingTask(task)
    setModalOpen(true)
  }

  if (loading) {
    return <div className="widget-loading"><BrandMark /><span>불러오는 중…</span></div>
  }

  return (
    <>
      <div className={`widget-shell ${widgetState.locked ? 'is-locked' : ''}`}>
      <header className="widget-header">
        <div className="widget-drag-area">
          <GripHorizontal size={17} />
          <BrandMark compact />
          <span>Dayline</span>
        </div>
        <div className="widget-controls">
          <IconButton
            label={widgetState.locked ? '위치와 크기 잠금 해제' : '위치와 크기 잠금'}
            active={widgetState.locked}
            onClick={async () => {
              const next = await window.dayline?.toggleWidgetLock()
              if (next) setWidgetState((current) => ({ ...current, locked: next.locked }))
            }}
          >
            {widgetState.locked ? <Lock size={14} /> : <Unlock size={14} />}
          </IconButton>
          <IconButton
            label={widgetState.pinned ? '항상 위 해제' : '항상 위로 고정'}
            active={widgetState.pinned}
            onClick={async () => {
              const next = await window.dayline?.toggleWidgetPin()
              if (next) setWidgetState((current) => ({ ...current, pinned: next.pinned }))
            }}
          >
            {widgetState.pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </IconButton>
          <IconButton label="기본 크기로 되돌리기" onClick={() => void window.dayline?.resetWidgetBounds()}>
            <Maximize2 size={14} />
          </IconButton>
          <IconButton label="메인 캘린더 열기" onClick={() => void window.dayline?.openMainWindow()}>
            <CalendarDays size={14} />
          </IconButton>
          <IconButton label="위젯 닫기" onClick={() => void window.dayline?.closeWidget()}>
            <X size={15} />
          </IconButton>
        </div>
      </header>

      <main className="widget-content">
        <section className="widget-date-title">
          <div>
            <span className="eyebrow">{selectedDate === today ? 'TODAY' : 'SELECTED DAY'}</span>
            <h1>{formatFullDate(selectedDate)}</h1>
          </div>
          {selectedDate !== today && <button type="button" onClick={() => setSelectedDate(today)}>오늘</button>}
        </section>

        <div className="widget-week" role="group" aria-label="이번 주 날짜 선택">
          {week.map((day) => (
            <button
              type="button"
              key={day.key}
              className={`${selectedDate === day.key ? 'is-selected' : ''} ${today === day.key ? 'is-today' : ''}`}
              onClick={() => setSelectedDate(day.key)}
              aria-label={formatFullDate(day.key)}
            >
              <span>{day.weekday}</span>
              <strong>{day.day}</strong>
              <i>{active.some((task) => task.dueDate === day.key && !task.completed) ? '•' : ''}</i>
            </button>
          ))}
        </div>

        <section className="widget-progress">
          <div><span>진행</span><strong>{completedCount}/{selectedTasks.length}</strong></div>
          <div className="progress-track"><span style={{ width: `${selectedTasks.length ? (completedCount / selectedTasks.length) * 100 : 0}%` }} /></div>
        </section>

        {error && <div className="widget-error">{error}</div>}
        <section className="widget-task-list" aria-label="선택한 날짜의 일정">
          {selectedTasks.length === 0 ? (
            <EmptyState compact />
          ) : (
            selectedTasks.map((task) => (
              <TaskRow key={task.id} task={task} compact onOpen={openTask} onSecondaryAction={onTaskSecondaryAction} />
            ))
          )}
        </section>

        <form className="quick-add" onSubmit={addQuickTask}>
          <Plus size={17} />
          <input
            value={quickTitle}
            onChange={(event) => setQuickTitle(event.target.value)}
            placeholder="빠르게 일정 추가"
            aria-label="빠르게 일정 추가"
          />
          <button type="submit" disabled={!quickTitle.trim()}>추가</button>
        </form>
        <p className="widget-tip">좌클릭 상세 · 우클릭 활성 → 비활성 → 최근 삭제</p>
      </main>

      {!widgetState.locked && <span className="resize-corner" aria-hidden="true" />}
      </div>
      <TaskModal
        open={modalOpen}
        initialDate={selectedDate}
        task={editingTask}
        onClose={() => {
          setModalOpen(false)
          setEditingTask(null)
        }}
        onSave={(draft, id, completed) => {
          if (id) onUpdate(id, draft, completed)
          setSelectedDate(draft.dueDate)
          setModalOpen(false)
          setEditingTask(null)
        }}
        onDelete={onTaskDelete}
      />
    </>
  )
}

export default function App({ mode }: { mode: AppMode }) {
  const { tasks, tasksRef, loading, error, commit } = useTaskStore()
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastId = useRef(0)
  const secondaryActionGuard = useRef<Record<string, number>>({})

  const showToast = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    toastId.current += 1
    setToast({ id: toastId.current, message, actionLabel, onAction })
  }, [])

  const handleSecondaryAction = useCallback((id: string) => {
    const task = tasksRef.current.find((item) => item.id === id && !item.deletedAt)
    if (!task) return
    const now = Date.now()
    if (task.completed && (secondaryActionGuard.current[id] ?? 0) > now) {
      showToast('비활성화됐어요. 잠시 후 다시 우클릭하면 최근 삭제로 이동해요.')
      return
    }

    const result = advanceTaskState(tasksRef.current, id, new Date(now))
    commit(() => result.tasks)
    if (result.action === 'deactivated') {
      secondaryActionGuard.current[id] = now + 700
      showToast('일정을 비활성화했어요. 다시 우클릭하면 최근 삭제로 이동해요.', '활성화', () => {
        delete secondaryActionGuard.current[id]
        commit((current) => setTaskCompleted(current, id, false))
      })
    } else if (result.action === 'deleted') {
      delete secondaryActionGuard.current[id]
      showToast('일정을 최근 삭제로 옮겼어요.', '실행 취소', () => {
        commit((current) => restoreTask(current, id))
      })
    }
  }, [commit, showToast, tasksRef])

  const handleDelete = useCallback((id: string) => {
    delete secondaryActionGuard.current[id]
    commit((current) => softDeleteTask(current, id))
    showToast('일정을 최근 삭제로 옮겼어요.', '실행 취소', () => {
      commit((current) => restoreTask(current, id))
    })
  }, [commit, showToast])

  const handleRestore = useCallback((id: string) => {
    commit((current) => restoreTask(current, id))
    showToast('원래 날짜와 상태로 복구했어요.')
  }, [commit, showToast])

  const handleCreate = useCallback((draft: TaskDraft) => {
    const now = new Date().toISOString()
    const task: Task = {
      id: crypto.randomUUID(),
      ...draft,
      completed: false,
      completedAt: null,
      deletedAt: null,
      previousCompleted: null,
      createdAt: now,
      updatedAt: now,
    }
    commit((current) => [...current, task])
    showToast('새 일정을 캘린더에 추가했어요.')
  }, [commit, showToast])

  const handleUpdate = useCallback((id: string, draft: TaskDraft, completed?: boolean) => {
    const now = new Date()
    const timestamp = now.toISOString()
    delete secondaryActionGuard.current[id]
    commit((current) => {
      const withDraft = current.map((task) =>
        task.id === id && !task.deletedAt
          ? { ...task, ...draft, updatedAt: timestamp }
          : task,
      )
      return typeof completed === 'boolean'
        ? setTaskCompleted(withDraft, id, completed, now)
        : withDraft
    })
    showToast('일정 변경을 저장했어요.')
  }, [commit, showToast])

  const shared: SharedViewProps = {
    tasks,
    loading,
    error,
    onTaskSecondaryAction: handleSecondaryAction,
    onTaskDelete: handleDelete,
    onTaskRestore: handleRestore,
    onCreate: handleCreate,
    onUpdate: handleUpdate,
  }

  return (
    <>
      {mode === 'widget' ? <WidgetView {...shared} /> : <MainView {...shared} />}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  )
}
