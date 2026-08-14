import {
  ArchiveRestore,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  CornerDownRight,
  Download,
  FileText,
  Filter,
  GripHorizontal,
  GripVertical,
  History,
  Lock,
  Maximize2,
  MonitorUp,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Repeat2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Tags,
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
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  addDaysKey,
  calendarDays,
  calendarDaysFromStart,
  dateRangeContains,
  formatCompactDate,
  formatFullDate,
  formatMonthTitle,
  fromDateKey,
  getWeekendKey,
  inclusiveDateKeys,
  shiftMonth,
  startOfMonth,
  todayKey,
  weekDaysAround,
} from './domain/date'
import { layoutCalendarTaskSegments, type CalendarTaskSegment } from './domain/calendarLayout'
import {
  dailyNotesForDate,
  reorderDailyNotesForDate,
  toggleDailyNoteCompleted,
  toggleDailyNotePin,
} from './domain/dailyNotes'
import { getCalendarDayTone, getKoreanHoliday } from './domain/koreanHolidays'
import { parseReleaseNotes } from './domain/releaseNotes'
import {
  advanceTaskState,
  deletedTasks,
  moveTaskRange,
  remainingRetentionDays,
  restoreTask,
  setTaskCompleted,
  softDeleteTask,
  sortTasks,
  nextPosition,
  reorderPositioned,
  taskOccursOnDate,
  taskOverlapsRange,
  toggleSubTask,
  visibleTasks,
} from './domain/tasks'
import {
  applyTaskEditChanges,
  createTaskFromTemplate,
  getTaskEditChanges,
  type TaskDraft,
  type TaskEditChanges,
} from './domain/taskDraft'
import { loadStore, saveStore, subscribeToStore } from './lib/storage'
import { HelpTour, type HelpTourStep } from './components/HelpTour'
import type {
  AppSettings,
  DailyNote,
  DaylineStore,
  LegacyMigrationWarning,
  SubTask,
  Task,
  TaskColor,
  TaskTag,
  TaskTemplate,
  UpdateState,
  WidgetState,
} from './types'

type AppMode = 'main' | 'widget'

interface ToastMessage {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const TAG_PALETTE = ['#ef6f61', '#8b6fd6', '#6f9f7d', '#4f86c6', '#d99a32', '#d66787', '#3f9b96', '#5c6ac4', '#718096']
const LEGACY_COLORS: Record<TaskColor, string> = {
  coral: '#ec6d5c',
  violet: '#8e73b3',
  sage: '#609078',
  blue: '#6385a8',
  amber: '#bd8236',
}
const UNTAGGED_FILTER = '__untagged__'
const TEMPLATE_COPY_MIME = 'application/x-dayline-template'
const TEMPLATE_ORDER_MIME = 'application/x-dayline-template-order'
const CALENDAR_ORDER_MIME = 'application/x-dayline-calendar-task'
const TASK_DATE_MOVE_MIME = 'application/x-dayline-task-date'

type RailPanel = 'templates' | 'filters' | 'tags' | 'appearance' | 'updates' | null
type ReorderDirection = -1 | 1

const UNSUPPORTED_UPDATE_STATE: UpdateState = {
  status: 'unsupported',
  currentVersion: '',
  availableVersion: null,
  releaseName: null,
  releaseNotes: null,
  installedReleaseHistory: {
    state: 'no-baseline',
    fromVersion: null,
    toVersion: '',
    releaseName: null,
    releaseNotes: null,
    recordedAt: null,
  },
  progress: null,
  error: null,
  unsupportedReason: 'development',
  canCheck: false,
  canDownload: false,
  canInstall: false,
}

function getRendererUpdatesApi() {
  return window.dayline?.updates
}

interface TaskDateDragPayload {
  taskId: string
  grabDate: string
}

interface TemplateDraft {
  title: string
  note: string
  dueTime: string | null
  tagId: string | null
  legacyColor: TaskColor
  durationDays: number
  subTaskTitles: string[]
}

const MAIN_HELP_STEPS: HelpTourStep[] = [
  {
    eyebrow: 'DAYLINE 둘러보기',
    title: '일정과 메모를 한 화면에서 정리해요',
    description: '기간 일정, 세부 할 일, 퀵 노트와 반복 일정까지 새로 확장된 Dayline을 실제 화면과 함께 안내할게요. 약 3분이면 충분합니다.',
    example: (
      <div className="help-example-welcome">
        <BrandMark compact />
        <div><strong>SQLite로 이 PC에 안전하게 저장</strong><span>인터넷 없이도 일정·메모·설정이 자동 보관돼요.</span></div>
      </div>
    ),
    tips: ['도움말은 왼쪽 메뉴 맨 아래의 ? 버튼에서 언제든 다시 열 수 있어요.'],
  },
  {
    target: 'month-navigation',
    eyebrow: '날짜 이동',
    title: '원하는 연도와 달로 바로 이동하세요',
    description: '화살표와 오늘 버튼뿐 아니라 연도·월 선택 메뉴로 먼 날짜까지 빠르게 이동할 수 있어요.',
    example: (
      <div className="help-example-actions">
        <span>‹</span><strong>오늘</strong><span>›</span><small>2027년 · 3월</small>
      </div>
    ),
    tips: ['일요일과 대한민국 공휴일은 빨간색, 토요일은 파란색으로 표시돼요.'],
  },
  {
    target: 'calendar',
    eyebrow: '기간 선택과 월간 일정',
    title: '날짜를 드래그해 일정 기간을 잡아보세요',
    description: '캘린더 빈 영역을 누른 채 끌면 시작일과 마감일이 선택됩니다. 여러 날 일정은 주를 넘어도 이어지는 하나의 바로 표시돼요.',
    example: (
      <div className="help-example-range">
        <span>12</span><i /><i /><i /><strong>15</strong>
        <small>3박 4일 출장 준비</small>
      </div>
    ),
    tips: ['날짜를 한 번 클릭하면 그날을 선택하고, 더블클릭하면 바로 새 일정을 만들어요.'],
  },
  {
    target: 'calendar-order',
    eyebrow: '캘린더 일정 순서',
    title: '캘린더 안에서 일정 바의 순서를 바꿔요',
    description: '캘린더에 표시된 일정 바 오른쪽 손잡이를 끌어 다른 일정 위에 놓으면 월간 화면의 위아래 표시 순서가 바뀝니다.',
    example: (
      <div className="help-example-reorder"><GripVertical size={15} /><div><strong>오후 보고서 검토</strong><span>캘린더에서 드래그 또는 Alt + ↑/↓</span></div><b>⋮⋮</b></div>
    ),
    tips: [
      '일정 바 본문을 다른 날짜로 끌면 기간은 그대로 유지한 채 날짜를 옮길 수 있어요.',
      '오른쪽 손잡이에 키보드 포커스를 둔 뒤 Alt + ↑/↓를 누르면 표시 순서만 바뀝니다.',
    ],
  },
  {
    target: 'create-task',
    eyebrow: '일정 만들기와 상세',
    title: '큰 일정을 세부 할 일로 나눠 관리해요',
    description: '제목과 기간은 필수이고 시간·메모·태그·세부 할 일은 선택이에요. 세부 할 일을 모두 끝내면 상위 일정도 자동으로 비활성화됩니다.',
    example: (
      <div className="help-example-subtasks">
        <strong>발표 준비</strong><span><i className="is-done">✓</i> 자료 조사</span><span><i /> 슬라이드 검토</span><small>1 / 2 완료</small>
      </div>
    ),
    tips: ['기존 일정의 내용과 상태 변경은 상세 화면에서 변경 저장을 눌러야 반영돼요.'],
  },
  {
    target: 'search',
    eyebrow: '검색',
    title: '제목과 메모에서 빠르게 찾아요',
    description: '돋보기를 눌러 입력하면 월간 캘린더와 선택한 날짜 목록이 동시에 필터링됩니다. 태그 필터와도 함께 사용할 수 있어요.',
    example: <div className="help-example-search"><Search size={14} /><strong>프로젝트</strong><span>제목 + 메모 검색</span></div>,
  },
  {
    target: 'widget-launch',
    eyebrow: '데스크톱 위젯',
    title: '일정과 퀵 노트를 작은 창에 띄워두세요',
    description: '위젯에서도 주간 탐색, 빠른 일정 추가, 세부 할 일과 퀵 노트 관리가 가능하며 메인 창과 실시간으로 동기화됩니다.',
    example: <div className="help-example-widget"><MonitorUp size={18} /><div><strong>일정 + 퀵 노트 분할 화면</strong><span>항상 위 · 잠금 · 크기 복원</span></div></div>,
    tips: ['위젯 상단의 ? 버튼에서는 작은 창 전용 조작법을 볼 수 있어요.'],
  },
  {
    target: 'quick-notes',
    eyebrow: '퀵 노트',
    title: '형식 없는 메모는 퀵 노트에 바로 적어요',
    description: '제목이나 마감일이 필요 없는 생각은 선택한 날짜의 퀵 노트로 남기세요. 핀으로 모든 날짜에 고정하고, 다른 날짜에서도 손잡이를 끌어 일반 노트 사이에 배치할 수 있어요.',
    example: (
      <div className="help-example-note"><FileText size={15} /><div><strong>회의 전에 질문 목록 확인</strong><span>Ctrl + Enter로 저장</span></div></div>
    ),
    tips: [
      '고정을 해제하면 시작일과 해제일에 기록이 남고, 실수로 같은 날 다시 고정하면 기존 시작일을 이어갑니다.',
      '고정된 퀵 노트를 완료하면 해당 날짜에 기록을 남긴 채 자동으로 고정이 해제돼요.',
    ],
  },
  {
    target: 'schedule-list',
    eyebrow: '선택 날짜의 일정',
    title: '오른쪽 아래에서 일정과 세부 할 일을 확인해요',
    description: '선택한 날짜의 일정을 모아 보고 세부 할 일을 바로 완료할 수 있어요. 하위 태스크는 처음에 펼쳐지며, 상위 일정 오른쪽의 간략히/상세히 버튼으로 접거나 다시 펼칠 수 있습니다.',
    example: (
      <div className="help-example-subtasks">
        <div className="help-example-subtask-head"><strong>발표 준비</strong><span>간략히 <ChevronUp size={11} /></span></div>
        <span><i className="is-done">✓</i> 자료 조사</span><span><i /> 슬라이드 검토</span><small>기본 펼침 · 1 / 2 완료</small>
      </div>
    ),
    tips: [
      '간략히를 누르면 하위 목록이 접히고 버튼이 상세히로 바뀌어요. 상세히를 누르면 목록이 다시 펼쳐집니다.',
      '퀵 노트와 일정 사이 구분선을 드래그하거나 키보드로 움직여 두 영역의 높이를 조절할 수 있어요.',
    ],
  },
  {
    target: 'templates',
    eyebrow: '반복 일정',
    title: '자주 쓰는 일정은 템플릿으로 저장하세요',
    description: '추가 버튼으로 양식을 열어 반복 일정을 만들고, 카드 본문을 캘린더로 끌거나 오른쪽 손잡이로 목록 순서를 바꿀 수 있어요.',
    example: (
      <div className="help-example-template"><Repeat2 size={16} /><div><strong>주간 회고 · 1일</strong><span>캘린더로 드래그해 생성</span></div><b>추가</b></div>
    ),
  },
  {
    target: 'filters',
    eyebrow: '태그 필터',
    title: '보고 싶은 태그만 골라보세요',
    description: '여러 태그를 동시에 선택하면 하나라도 해당하는 일정을 캘린더와 오른쪽 목록에서 함께 보여줍니다.',
    example: (
      <div className="help-example-tags"><span className="tag-coral">업무 ✓</span><span className="tag-blue">개인 ✓</span><span>태그 없음</span></div>
    ),
    tips: ['필터가 적용되면 왼쪽 아이콘에 선택한 태그 개수가 표시돼요.'],
  },
  {
    target: 'tags',
    eyebrow: '태그 설정',
    title: '태그의 이름과 색상을 내 방식대로',
    description: '9개의 기본 태그 이름과 색상을 바꾸거나 사용자 태그를 새로 만들어 일정에 재사용할 수 있어요.',
    example: (
      <div className="help-example-tag-editor"><i style={{ background: '#d66787' }} /><strong>집중 업무</strong><span>#D66787</span></div>
    ),
    tips: ['사용자 태그는 삭제할 수 있고, 기본 태그는 이름과 색상만 변경할 수 있어요.'],
  },
  {
    target: 'appearance',
    eyebrow: '일반 설정',
    title: '화면과 달력 탐색 방식을 조절해요',
    description: '화면 배율과 테마 색상을 바꾸고, 달력 위에서 스크롤할 때 한 주씩 이동할지 선택할 수 있습니다.',
    example: (
      <div className="help-example-appearance"><span>A</span><i><b /></i><strong>110%</strong><em style={{ background: '#4f86c6' }} /></div>
    ),
  },
  {
    target: 'recovery',
    eyebrow: '최근 삭제',
    title: '삭제한 일정은 30일 동안 복구할 수 있어요',
    description: '원래 기간과 활성·비활성 상태, 세부 할 일을 함께 보존하고 그대로 되돌립니다.',
    example: <div className="help-example-recovery"><History size={16} /><div><strong>분기 계획 정리</strong><span>비활성 · 28일 남음</span></div><b>복구</b></div>,
    tips: ['우클릭 상태 변경 직후에는 화면 아래 알림에서 즉시 되돌릴 수도 있어요.'],
  },
  {
    target: 'help-menu',
    eyebrow: '자동 저장',
    title: '준비가 끝났어요',
    description: '모든 변경은 내장 SQLite에 자동 저장되고, 기존 JSON 일정이 있다면 첫 실행 때 백업 후 이전됩니다. 이제 원하는 날짜에서 시작해 보세요.',
    example: <div className="help-example-ready"><Check size={18} /><div><strong>오프라인 저장 중</strong><span>도움말은 왼쪽 맨 아래에서 다시 열 수 있어요.</span></div></div>,
  },
]

const WIDGET_HELP_STEPS: HelpTourStep[] = [
  {
    eyebrow: '위젯 둘러보기',
    title: '일정과 퀵 노트를 바탕화면 가까이에',
    description: '작은 위젯에서도 날짜 선택, 일정·세부 할 일, 퀵 노트를 함께 관리할 수 있어요.',
    example: <div className="help-example-widget"><BrandMark compact /><div><strong>Dayline 0.3.41 위젯</strong><span>메인 캘린더와 실시간 동기화</span></div></div>,
  },
  {
    target: 'widget-controls',
    eyebrow: '창 조작',
    title: '위치와 표시 방식을 원하는 대로',
    description: '상단 손잡이로 이동하고 자물쇠로 위치·크기를 잠그세요. 핀은 항상 위, 모서리 아이콘은 기본 크기 복원입니다.',
    tips: ['캘린더 아이콘은 메인 창을 열고 ×는 위젯만 닫아요.'],
  },
  {
    target: 'widget-week',
    eyebrow: '주간 탐색',
    title: '이번 주 일정을 날짜별로 넘겨봐요',
    description: '요일을 누르면 그날의 일정과 퀵 노트가 함께 바뀝니다. 점이 있는 날짜에는 아직 활성 일정이 있어요.',
    example: <div className="help-example-week"><span>월<strong>10</strong></span><span className="is-selected">화<strong>11</strong><i>•</i></span><span>수<strong>12</strong></span></div>,
  },
  {
    target: 'widget-schedule',
    eyebrow: '일정',
    title: '제목만 입력해 빠르게 추가하세요',
    description: '입력칸에서 Enter를 누르면 선택 날짜에 일정이 생깁니다. 목록에서는 상세 보기, 우클릭 상태 변경과 세부 할 일 완료가 가능해요.',
    example: <div className="help-example-quick"><Plus size={14} /><strong>회의 자료 정리</strong><span>Enter</span></div>,
  },
  {
    target: 'widget-splitter',
    eyebrow: '분할 영역',
    title: '일정과 퀵 노트의 높이를 조절해요',
    description: '가운데 구분선을 드래그하거나 방향키로 이동하세요. 더블클릭하면 두 영역이 다시 같은 높이가 됩니다.',
    example: <div className="help-example-split"><span>일정</span><i><b /></i><span>퀵 노트</span></div>,
  },
  {
    target: 'widget-notes',
    eyebrow: '퀵 노트',
    title: '작은 메모도 놓치지 마세요',
    description: '+를 눌러 형식 없이 기록하고, 핀으로 모든 날짜에 고정하거나 완료 처리해 자동으로 고정을 해제할 수 있어요.',
    example: <div className="help-example-note"><FileText size={15} /><div><strong>퇴근 전에 전화하기</strong><span>선택 날짜에 바로 저장</span></div></div>,
    tips: ['시간·기간·태그가 필요하면 일정으로 추가하세요.'],
  },
]

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizedHex(value: string, fallback = '#255f4b') {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

function colorChannels(value: string) {
  const safe = normalizedHex(value, '#000000').slice(1)
  return [0, 2, 4].map((offset) => Number.parseInt(safe.slice(offset, offset + 2), 16))
}

function mixHex(foreground: string, background: string, foregroundWeight: number) {
  const front = colorChannels(foreground)
  const back = colorChannels(background)
  const weight = clamp(foregroundWeight, 0, 1)
  return `#${front.map((channel, index) => Math.round(channel * weight + back[index] * (1 - weight))
    .toString(16).padStart(2, '0')).join('')}`
}

function relativeLuminance(color: string) {
  const channels = colorChannels(color).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrastRatio(first: string, second: string) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function accessibleAccent(value: string) {
  const raw = normalizedHex(value)
  if (contrastRatio(raw, '#ffffff') >= 4.5) return raw
  for (let rawWeight = 0.9; rawWeight >= 0.2; rawWeight -= 0.05) {
    const candidate = mixHex(raw, '#000000', rawWeight)
    if (contrastRatio(candidate, '#ffffff') >= 4.5) return candidate
  }
  return '#343b37'
}

function taskColor(task: Pick<Task, 'tagId' | 'color'>, tags: TaskTag[]) {
  return tags.find((tag) => tag.id === task.tagId)?.color ?? LEGACY_COLORS[task.color]
}

function taskVisualStyle(task: Pick<Task, 'tagId' | 'color'>, tags: TaskTag[]): CSSProperties {
  const rawColor = normalizedHex(taskColor(task, tags), LEGACY_COLORS[task.color])
  const color = accessibleAccent(rawColor)
  return {
    '--task-color': color,
    '--task-raw': rawColor,
    '--task-bg': mixHex(rawColor, '#ffffff', 0.14),
    '--task-soft': mixHex(rawColor, '#ffffff', 0.07),
  } as CSSProperties
}

function themeVariables(settings: AppSettings): Record<string, string> {
  const rawTheme = normalizedHex(settings.themeColor)
  const theme = accessibleAccent(rawTheme)
  const fontScale = clamp(settings.fontScale, 0.85, 1.5)
  const fontVariables = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => {
      const size = index + 1
      return [`--font-${size}`, `${Number((size * fontScale).toFixed(2))}px`]
    }),
  )
  return {
    ...fontVariables,
    '--theme-color': rawTheme,
    '--green': theme,
    '--green-deep': mixHex(theme, '#000000', 0.82),
    '--green-soft': mixHex(rawTheme, '#ffffff', 0.13),
  }
}

function sortedPositioned<T extends { position: number; createdAt: string; id: string }>(items: T[]) {
  return [...items].sort((left, right) => left.position - right.position
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id))
}

function movedIds(ids: string[], id: string, direction: ReorderDirection) {
  const from = ids.indexOf(id)
  const to = clamp(from + direction, 0, ids.length - 1)
  if (from < 0 || from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

function droppedIds(ids: string[], draggedId: string, targetId: string) {
  const from = ids.indexOf(draggedId)
  const target = ids.indexOf(targetId)
  if (from < 0 || target < 0 || from === target) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(target, 0, draggedId)
  return next
}

function useVisibleDailyNotes(
  dailyNotes: DailyNote[],
  selectedDate: string,
  onToggle: (id: string, selectedDate: string) => void,
  onPinToggle: (id: string, selectedDate: string) => void,
) {
  const visibleNotes = useMemo(
    () => dailyNotesForDate(dailyNotes, selectedDate),
    [dailyNotes, selectedDate],
  )

  const toggleNote = useCallback((id: string) => {
    onToggle(id, selectedDate)
  }, [onToggle, selectedDate])

  const togglePin = useCallback((id: string) => {
    onPinToggle(id, selectedDate)
  }, [onPinToggle, selectedDate])

  return { visibleNotes, toggleNote, togglePin }
}

function parseTaskDateDragPayload(raw: string): TaskDateDragPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<TaskDateDragPayload>
    return typeof value.taskId === 'string' && typeof value.grabDate === 'string'
      ? { taskId: value.taskId, grabDate: value.grabDate }
      : null
  } catch {
    return null
  }
}

function reorderTaskSubset(tasks: Task[], orderedIds: string[], now = new Date()) {
  const selectedIds = new Set(orderedIds)
  const availablePositions = tasks
    .filter((task) => selectedIds.has(task.id))
    .map((task) => task.position)
    .sort((left, right) => left - right)
  if (availablePositions.length !== orderedIds.length) return tasks
  const nextPositions = new Map(orderedIds.map((id, index) => [id, availablePositions[index]]))
  const timestamp = now.toISOString()
  return tasks.map((task) => {
    const position = nextPositions.get(task.id)
    return position == null || position === task.position
      ? task
      : { ...task, position, updatedAt: timestamp }
  })
}

function normalizedRange(first: string, second: string) {
  return first <= second
    ? { startDate: first, endDate: second }
    : { startDate: second, endDate: first }
}

function taskRangeLabel(task: Pick<Task, 'startDate' | 'dueDate'>) {
  return task.startDate === task.dueDate
    ? formatCompactDate(task.dueDate)
    : `${formatCompactDate(task.startDate)} – ${formatCompactDate(task.dueDate)}`
}
const DIALOG_FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function trapDialogFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)]
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
  if (focusable.length === 0) {
    event.preventDefault()
    event.currentTarget.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function makeOutsideInert(element: HTMLElement): () => void {
  const previous = new Map<HTMLElement, boolean>()
  let current: HTMLElement | null = element
  while (current?.parentElement) {
    const parent: HTMLElement = current.parentElement
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === current || previous.has(sibling)) continue
      previous.set(sibling, sibling.inert)
      sibling.inert = true
    }
    if (parent === document.body) break
    current = parent
  }
  return () => {
    for (const [sibling, wasInert] of previous) sibling.inert = wasInert
  }
}

function useTaskStore() {
  const [store, setStore] = useState<DaylineStore>({
    version: 1,
    revision: 0,
    tasks: [],
    dailyNotes: [],
    taskTags: [],
    settings: {
      sidebarSplit: 50,
      widgetSplit: 58,
      fontScale: 1,
      themeColor: '#255f4b',
      calendarWeekScroll: false,
    },
    taskTemplates: [],
    migrationWarning: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const storeRef = useRef<DaylineStore>(store)
  const revisionRef = useRef(0)

  const acceptStore = useCallback((store: Awaited<ReturnType<typeof loadStore>>) => {
    if (store.revision < revisionRef.current) return false
    revisionRef.current = store.revision
    storeRef.current = store
    setStore(store)
    return true
  }, [])

  useEffect(() => {
    let active = true
    loadStore()
      .then((store) => {
        if (!active) return
        acceptStore(store)
      })
      .catch(() => {
        if (active) setError('로컬 데이터를 불러오지 못했어요.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    const unsubscribe = subscribeToStore((store) => {
      if (!active) return
      acceptStore(store)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [acceptStore])

  const commit = useCallback((updater: (current: DaylineStore) => DaylineStore) => {
    const previous = storeRef.current
    const next = updater(previous)
    setError(null)
    try {
      const store = saveStore(previous, next)
      acceptStore(store)
      return true
    } catch {
      setError('저장하지 못했어요. 다시 시도해 주세요.')
      return false
    }
  }, [acceptStore])

  return { store, storeRef, loading, error, commit }
}

function IconButton({
  label,
  children,
  onClick,
  className = '',
  active = false,
  disabled = false,
  id,
  controls,
  expanded,
  railAction,
  autoFocus = false,
  dataHelpId,
  dataQa,
}: {
  label: string
  children: ReactNode
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  className?: string
  active?: boolean
  disabled?: boolean
  id?: string
  controls?: string
  expanded?: boolean
  railAction?: 'templates' | 'filters' | 'tags' | 'appearance' | 'updates' | 'recovery' | 'help'
  autoFocus?: boolean
  dataHelpId?: string
  dataQa?: string
}) {
  return (
    <button
      type="button"
      id={id}
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      aria-controls={controls}
      aria-expanded={expanded}
      data-rail-action={railAction}
      data-help-id={dataHelpId}
      data-qa={dataQa}
      title={label}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
    >
      {children}
    </button>
  )
}

function ReorderHandle({
  kind,
  id,
  label,
  onMove,
}: {
  kind: 'task' | 'daily-note' | 'calendar-task' | 'template-order'
  id: string
  label: string
  onMove: (id: string, direction: ReorderDirection) => void
}) {
  return (
    <button
      type="button"
      className="reorder-handle"
      draggable
      data-reorder-kind={kind}
      data-reorder-id={id}
      data-qa={kind === 'calendar-task' ? 'calendar-task-reorder-handle' : undefined}
      aria-label={`${label} 순서 이동`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      title="드래그하여 순서 변경 · Alt+↑/↓"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragStart={(event) => {
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(
          kind === 'template-order' ? TEMPLATE_ORDER_MIME : `application/x-dayline-${kind}`,
          id,
        )
      }}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        event.stopPropagation()
        onMove(id, event.key === 'ArrowUp' ? -1 : 1)
      }}
    >
      <GripVertical size={15} />
    </button>
  )
}

function SplitHandle({
  qa,
  value,
  onPreview,
  onCommit,
}: {
  qa: 'sidebar-splitter' | 'widget-splitter'
  value: number
  onPreview: (value: number) => void
  onCommit: (value: number) => void
}) {
  const calculate = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.closest<HTMLElement>('[data-split-container]')
    if (!container) return value
    const bounds = container.getBoundingClientRect()
    return clamp(((event.clientY - bounds.top) / bounds.height) * 100, 20, 80)
  }

  const changeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowUp') next = value - (event.shiftKey ? 10 : 2)
    if (event.key === 'ArrowDown') next = value + (event.shiftKey ? 10 : 2)
    if (event.key === 'Home') next = 20
    if (event.key === 'End') next = 80
    if (next == null) return
    event.preventDefault()
    const safe = clamp(next, 20, 80)
    onPreview(safe)
    onCommit(safe)
  }

  return (
    <div
      className="split-handle"
      data-qa={qa}
      data-help-id={qa === 'widget-splitter' ? 'widget-splitter' : 'sidebar-splitter'}
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(value)}
      aria-label={qa === 'sidebar-splitter' ? '퀵 노트와 일정 영역 크기 조절' : '위젯 일정과 퀵 노트 영역 크기 조절'}
      onDoubleClick={() => {
        onPreview(50)
        onCommit(50)
      }}
      onKeyDown={changeByKeyboard}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        onPreview(calculate(event))
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        onPreview(calculate(event))
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const next = calculate(event)
        event.currentTarget.releasePointerCapture(event.pointerId)
        onPreview(next)
        onCommit(next)
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        onPreview(value)
      }}
    >
      <span />
    </div>
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
  tags,
  segment,
  onOpen,
  onSecondaryAction,
  onMove,
  onDropTask,
  onDropTemplate,
  onBeginDateDrag,
  onEndDateDrag,
  onDropDateMove,
}: {
  task: Task
  tags: TaskTag[]
  segment: CalendarTaskSegment
  onOpen: (task: Task) => void
  onSecondaryAction: (id: string) => void
  onMove: (id: string, direction: ReorderDirection) => void
  onDropTask: (draggedId: string, targetId: string) => void
  onDropTemplate: (templateId: string, clientX: number, clientY: number) => void
  onBeginDateDrag: (taskId: string, fallbackDate: string, clientX: number, clientY: number, transfer: DataTransfer) => void
  onEndDateDrag: () => void
  onDropDateMove: (payload: TaskDateDragPayload, clientX: number, clientY: number) => void
}) {
  const suppressOpenRef = useRef(false)
  const segmentStyle = {
    ...taskVisualStyle(task, tags),
    gridColumn: `${segment.startColumn + 1} / ${segment.endColumn + 2}`,
    gridRow: segment.weekRow + 1,
    '--calendar-task-lane': segment.lane,
  } as CSSProperties

  return (
    <div
      data-task-id={task.id}
      data-qa="calendar-task-segment"
      data-task-start={task.startDate}
      data-task-end={task.dueDate}
      data-segment-start={segment.segmentStart}
      data-segment-end={segment.segmentEnd}
      data-week-row={segment.weekRow}
      data-lane={segment.lane}
      data-continues-before={String(segment.continuesBefore)}
      data-continues-after={String(segment.continuesAfter)}
      className={`calendar-task-segment task-chip color-${task.color} ${task.completed ? 'is-completed' : ''} ${segment.continuesBefore ? 'is-continues-before' : ''} ${segment.continuesAfter ? 'is-continues-after' : ''}`}
      style={segmentStyle}
      onDragOver={(event) => {
        const types = event.dataTransfer.types
        if (types.includes(TASK_DATE_MOVE_MIME)) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        } else if (types.includes(CALENDAR_ORDER_MIME)) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        } else if (types.includes(TEMPLATE_COPY_MIME)) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        const dateMove = parseTaskDateDragPayload(event.dataTransfer.getData(TASK_DATE_MOVE_MIME))
        if (dateMove) {
          event.preventDefault()
          event.stopPropagation()
          onDropDateMove(dateMove, event.clientX, event.clientY)
          return
        }
        const draggedTaskId = event.dataTransfer.getData(CALENDAR_ORDER_MIME)
        if (draggedTaskId) {
          event.preventDefault()
          event.stopPropagation()
          onDropTask(draggedTaskId, task.id)
          return
        }
        const templateId = event.dataTransfer.getData(TEMPLATE_COPY_MIME)
        if (!templateId) return
        event.preventDefault()
        event.stopPropagation()
        onDropTemplate(templateId, event.clientX, event.clientY)
      }}
      title={`${task.title} · 좌클릭 상세 보기 · 우클릭 ${task.completed ? '최근 삭제로 이동' : '비활성화'}`}
    >
      <button
        type="button"
        className="calendar-task-main"
        data-qa="calendar-task-date-drag"
        draggable
        aria-label={`${task.title}, ${formatCompactDate(segment.segmentStart)}${segment.segmentStart === segment.segmentEnd ? '' : `부터 ${formatCompactDate(segment.segmentEnd)}까지`}, ${task.completed ? '비활성' : '활성'} 일정. 상세 보기`}
        onClick={(event) => {
          event.stopPropagation()
          if (suppressOpenRef.current) return
          onOpen(task)
        }}
        onDragStart={(event) => {
          event.stopPropagation()
          suppressOpenRef.current = true
          event.dataTransfer.effectAllowed = 'move'
          onBeginDateDrag(task.id, segment.segmentStart, event.clientX, event.clientY, event.dataTransfer)
        }}
        onDragEnd={(event) => {
          event.stopPropagation()
          onEndDateDrag()
          window.setTimeout(() => { suppressOpenRef.current = false }, 0)
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
      >
        <span className="task-chip-dot">{task.completed && <Check size={9} strokeWidth={3} />}</span>
        {task.dueTime && <span className="task-chip-time">{task.dueTime}</span>}
        <span className="task-chip-title">{task.title}</span>
      </button>
      <ReorderHandle kind="calendar-task" id={task.id} label={task.title} onMove={onMove} />
    </div>
  )
}

function TaskRow({
  task,
  tags,
  onOpen,
  onSecondaryAction,
  onSubTaskToggle,
  onMove,
  onDropTask,
  compact = false,
  showSubTasks = false,
  subTasksExpanded = true,
  onToggleSubTasksVisibility,
  reorderable = false,
}: {
  task: Task
  tags: TaskTag[]
  onOpen: (task: Task) => void
  onSecondaryAction: (id: string) => void
  onSubTaskToggle?: (taskId: string, subTaskId: string) => void
  onMove?: (id: string, direction: ReorderDirection) => void
  onDropTask?: (draggedId: string, targetId: string) => void
  compact?: boolean
  showSubTasks?: boolean
  subTasksExpanded?: boolean
  onToggleSubTasksVisibility?: () => void
  reorderable?: boolean
}) {
  const tag = tags.find((item) => item.id === task.tagId)
  const hasVisibleSubTasks = showSubTasks && task.subTasks.length > 0
  const subTaskListId = `task-subtasks-${task.id}`
  return (
    <article
      data-task-id={task.id}
      className={`task-row color-${task.color} ${task.completed ? 'is-completed' : ''} ${compact ? 'is-compact' : ''} ${hasVisibleSubTasks && !subTasksExpanded ? 'is-subtasks-collapsed' : ''}`}
      style={taskVisualStyle(task, tags)}
      onDragOver={(event) => {
        if (!reorderable || !event.dataTransfer.types.includes('application/x-dayline-task')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!reorderable) return
        const draggedId = event.dataTransfer.getData('application/x-dayline-task')
        if (!draggedId) return
        event.preventDefault()
        onDropTask?.(draggedId, task.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onSecondaryAction(task.id)
      }}
    >
      <div className="task-row-head">
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
            <span className="task-row-labels">
              {tag && <span className="task-tag-label">{tag.name}</span>}
              {task.startDate !== task.dueDate && <span>{taskRangeLabel(task)}</span>}
              {hasVisibleSubTasks && (
                <span className="task-subtask-summary">
                  {task.subTasks.filter((subTask) => subTask.completed).length}/{task.subTasks.length} 완료
                </span>
              )}
            </span>
          </span>
          {task.dueTime && (
            <span className="task-due-time"><Clock3 size={12} /> {task.dueTime}</span>
          )}
        </button>
        {hasVisibleSubTasks && onToggleSubTasksVisibility && (
          <button
            type="button"
            className="task-subtask-disclosure"
            aria-controls={subTaskListId}
            aria-expanded={subTasksExpanded}
            aria-label={`${task.title} 하위 태스크 ${subTasksExpanded ? '간략히 보기' : '상세히 보기'}`}
            title={subTasksExpanded ? '간략히 보기' : '상세히 보기'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleSubTasksVisibility()
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <span>{subTasksExpanded ? '간략히' : '상세히'}</span>
            {subTasksExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        {reorderable && onMove && (
          <ReorderHandle kind="task" id={task.id} label={task.title} onMove={onMove} />
        )}
      </div>
      {hasVisibleSubTasks && (
        <div
          id={subTaskListId}
          className="sidebar-subtask-list"
          aria-label={`${task.title}의 세부 할 일`}
          hidden={!subTasksExpanded}
        >
          {task.subTasks.map((subTask) => (
            <div
              key={subTask.id}
              data-subtask-id={subTask.id}
              className={`sidebar-subtask ${subTask.completed ? 'is-completed' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onSubTaskToggle?.(task.id, subTask.id)
              }}
            >
              <button
                type="button"
                className="subtask-toggle"
                onClick={() => onSubTaskToggle?.(task.id, subTask.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault()
                  onSubTaskToggle?.(task.id, subTask.id)
                }}
                aria-label={`${subTask.title} ${subTask.completed ? '활성화' : '완료'}`}
                aria-pressed={subTask.completed}
                title="클릭 또는 우클릭으로 완료 상태 전환"
              >
                {subTask.completed && <Check size={11} strokeWidth={3} />}
              </button>
              <span>{subTask.title}</span>
            </div>
          ))}
        </div>
      )}
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

function DailyNotesSection({
  helpId,
  selectedDate,
  notes,
  composerOpen,
  createRequest,
  onComposerOpenChange,
  onCreate,
  onUpdate,
  onToggle,
  onPinToggle,
  onDelete,
  onMove,
  onDropNote,
  reorderable = true,
  showHeaderAdd = false,
}: {
  helpId?: string
  selectedDate: string
  notes: DailyNote[]
  composerOpen: boolean
  createRequest: number
  onComposerOpenChange: (open: boolean) => void
  onCreate: (noteDate: string, content: string) => boolean
  onUpdate: (id: string, content: string) => boolean
  onToggle: (id: string) => void
  onPinToggle: (id: string) => void
  onDelete: (id: string) => void
  onMove?: (id: string, direction: ReorderDirection) => void
  onDropNote?: (draggedId: string, targetId: string) => void
  reorderable?: boolean
  showHeaderAdd?: boolean
}) {
  const [content, setContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!composerOpen) return
    const timer = window.setTimeout(() => editorRef.current?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [composerOpen, editingId])

  useEffect(() => {
    if (createRequest === 0) return
    setContent('')
    setEditingId(null)
    onComposerOpenChange(true)
  }, [createRequest, onComposerOpenChange])

  useEffect(() => {
    setContent('')
    setEditingId(null)
    onComposerOpenChange(false)
  }, [selectedDate, onComposerOpenChange])

  const closeEditor = () => {
    setContent('')
    setEditingId(null)
    onComposerOpenChange(false)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextContent = content.trim()
    if (!nextContent) return
    const saved = editingId
      ? onUpdate(editingId, nextContent)
      : onCreate(selectedDate, nextContent)
    if (saved) closeEditor()
  }

  const editNote = (note: DailyNote) => {
    setEditingId(note.id)
    setContent(note.content)
    onComposerOpenChange(true)
  }

  return (
    <section className="daily-notes-section" data-help-id={helpId} data-qa="quick-note-section" aria-labelledby="daily-notes-title">
      <div className="panel-section-heading">
        <div>
          <span className="eyebrow">QUICK NOTE</span>
          <div className="section-heading-title">
            <strong id="daily-notes-title">퀵 노트</strong>
            <span className="section-count" data-qa="quick-note-count" aria-label={`퀵 노트 ${notes.length}개`}>{notes.length}</span>
          </div>
        </div>
        {showHeaderAdd && (
          <IconButton
            label="선택한 날짜에 퀵 노트 추가"
            className="section-add-button"
            dataQa="quick-note-add"
            onClick={() => {
              setContent('')
              setEditingId(null)
              onComposerOpenChange(true)
            }}
          >
            <Plus size={14} />
          </IconButton>
        )}
      </div>

      {composerOpen && (
        <form className="daily-note-composer" onSubmit={submit}>
          <textarea
            ref={editorRef}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeEditor()
              }
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="형식 없이 바로 적어두세요…"
            aria-label={editingId ? '퀵 노트 수정' : '새 퀵 노트'}
            maxLength={4000}
          />
          <div>
            <span>Ctrl + Enter로 저장</span>
            <div>
              <button type="button" className="note-cancel" onClick={closeEditor}>취소</button>
              <button type="submit" className="note-save" disabled={!content.trim()}>
                <Save size={13} /> {editingId ? '수정' : '기록'}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="daily-note-list">
        {notes.length === 0 && !composerOpen ? (
          <button type="button" className="daily-note-empty" onClick={() => onComposerOpenChange(true)}>
            <FileText size={23} />
            <strong>떠오른 일을 바로 적어보세요</strong>
            <span>제목이나 마감일 없이 선택한 날짜의 메모로 남아요.</span>
          </button>
        ) : (
          notes.map((note) => {
            const canReorder = reorderable
            const pinStartDate = note.pinnedStartDate ?? note.noteDate
            const pinTitle = note.pinned ? `${formatCompactDate(pinStartDate)}에 고정됨` : '고정하기'
            const pinHistory = !note.pinned
              && note.pinnedStartDate
              && note.pinnedEndDate
              && note.pinnedStartDate !== note.pinnedEndDate
              ? `${formatCompactDate(note.pinnedStartDate)} ~ ${formatCompactDate(note.pinnedEndDate)} 고정`
              : null
            return (
            <article
              key={note.id}
              data-daily-note-id={note.id}
              data-note-date={note.noteDate}
              data-note-pinned={note.pinned || undefined}
              data-note-pin-start-date={note.pinnedStartDate || undefined}
              data-note-pin-end-date={note.pinnedEndDate || undefined}
              className={`daily-note-item ${note.completed ? 'is-completed' : ''} ${note.pinned ? 'is-pinned' : ''} ${canReorder ? 'has-reorder' : ''}`}
              onDragOver={(event) => {
                if (!canReorder || !event.dataTransfer.types.includes('application/x-dayline-daily-note')) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                if (!canReorder) return
                const draggedId = event.dataTransfer.getData('application/x-dayline-daily-note')
                if (!draggedId) return
                event.preventDefault()
                onDropNote?.(draggedId, note.id)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                if ((event.target as HTMLElement).closest('.note-delete, .note-pin, .reorder-handle')) return
                onToggle(note.id)
              }}
            >
              <button
                type="button"
                className="note-check"
                onClick={() => onToggle(note.id)}
                aria-label={`${note.completed ? '완료 취소' : '완료'}: ${note.content}`}
                aria-pressed={note.completed}
              >
                {note.completed && <Check size={11} strokeWidth={3} />}
              </button>
              <div className="note-copy">
                <button
                  type="button"
                  className="note-content"
                  onClick={() => editNote(note)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    onToggle(note.id)
                  }}
                  title="클릭하여 수정 · 우클릭하여 완료 상태 전환"
                >
                  {note.content}
                </button>
                {pinHistory && <span className="note-pin-history" data-qa="quick-note-pin-history">{pinHistory}</span>}
              </div>
              <IconButton label="퀵 노트 삭제" className="note-delete" onClick={() => onDelete(note.id)}>
                <Trash2 size={13} />
              </IconButton>
              <button
                type="button"
                className={`icon-button note-pin ${note.pinned ? 'is-active' : ''}`}
                data-qa="quick-note-pin"
                data-note-id={note.id}
                aria-label={`${note.pinned ? '퀵 노트 고정 해제' : '퀵 노트 고정'}: ${note.content}`}
                aria-pressed={note.pinned}
                title={pinTitle}
                onClick={() => onPinToggle(note.id)}
              >
                <Pin size={13} fill={note.pinned ? 'currentColor' : 'none'} />
              </button>
              {canReorder && onMove && (
                <ReorderHandle kind="daily-note" id={note.id} label="퀵 노트" onMove={onMove} />
              )}
            </article>
            )
          })
        )}
      </div>
    </section>
  )
}

function TaskModal({
  open,
  initialStartDate,
  initialEndDate,
  task,
  tags,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  initialStartDate: string
  initialEndDate: string
  task: Task | null
  tags: TaskTag[]
  onClose: () => void
  onSave: (
    draft: TaskDraft,
    taskId?: string,
    changes?: TaskEditChanges,
  ) => boolean
  onDelete: (id: string) => boolean
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [startDate, setStartDate] = useState(initialStartDate)
  const [dueDate, setDueDate] = useState(initialEndDate)
  const [timeEnabled, setTimeEnabled] = useState(false)
  const [dueTime, setDueTime] = useState('09:00')
  const [color, setColor] = useState<TaskColor>('coral')
  const [tagId, setTagId] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const [parentStateTouched, setParentStateTouched] = useState(false)
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [newSubTaskTitle, setNewSubTaskTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmUnsaved, setConfirmUnsaved] = useState(false)
  const defaultTagId = tags[0]?.id ?? null
  const titleInputRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const unsavedContinueRef = useRef<HTMLButtonElement>(null)
  const unsavedReturnFocusRef = useRef<HTMLElement | null>(null)
  const saveInProgressRef = useRef(false)
  const draftBaselineRef = useRef<TaskDraft & { completed: boolean }>({
    title: '',
    note: '',
    startDate: initialStartDate,
    dueDate: initialEndDate,
    dueTime: null,
    color: 'coral' as TaskColor,
    tagId: defaultTagId,
    subTasks: [],
    completed: false,
  })
  const editorSession = open ? task?.id ?? '__new-task__' : null

  useEffect(() => {
    if (!open || !backdropRef.current) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const releaseInert = makeOutsideInert(backdropRef.current)
    return () => {
      releaseInert()
      const previousFocus = returnFocusRef.current
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus()
        else document.querySelector<HTMLElement>('.header-add, .quick-add input, .round-add')?.focus()
      }, 0)
    }
  }, [open])

  useEffect(() => {
    if (!editorSession) return
    const openingSubTasks = (task?.subTasks ?? []).map((subTask) => ({ ...subTask }))
    const openingDraft: TaskDraft & { completed: boolean } = {
      title: task?.title ?? '',
      note: task?.note ?? '',
      startDate: task?.startDate ?? initialStartDate,
      dueDate: task?.dueDate ?? initialEndDate,
      dueTime: task?.dueTime ?? null,
      color: task?.color ?? 'coral',
      tagId: task?.tagId ?? defaultTagId,
      subTasks: openingSubTasks,
      completed: task?.completed ?? false,
    }
    setTitle(openingDraft.title)
    setNote(openingDraft.note)
    setStartDate(openingDraft.startDate)
    setDueDate(openingDraft.dueDate)
    setTimeEnabled(Boolean(openingDraft.dueTime))
    setDueTime(openingDraft.dueTime ?? '09:00')
    setColor(openingDraft.color)
    setTagId(openingDraft.tagId)
    setCompleted(openingDraft.completed)
    setParentStateTouched(false)
    setSubTasks(openingSubTasks)
    setNewSubTaskTitle('')
    setConfirmDelete(false)
    setConfirmUnsaved(false)
    saveInProgressRef.current = false
    draftBaselineRef.current = openingDraft
    const timer = window.setTimeout(() => titleInputRef.current?.focus(), 90)
    return () => window.clearTimeout(timer)
    // Initialize once per open editor session. Store broadcasts for the same task
    // must not replace a draft while the user is composing it.
  }, [editorSession])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmUnsaved) {
        setConfirmUnsaved(false)
        window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
      } else if (confirmDelete) {
        setConfirmDelete(false)
        window.setTimeout(() => deleteTriggerRef.current?.focus(), 0)
      } else onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [confirmDelete, confirmUnsaved, open, onClose])

  if (!open) return null

  const validDraft = Boolean(
    title.trim()
    && startDate
    && dueDate
    && dueDate >= startDate
    && subTasks.every((subTask) => subTask.title.trim()),
  )
  const baseline = draftBaselineRef.current
  const baselineSubTasksById = new Map(baseline.subTasks.map((subTask) => [subTask.id, subTask]))
  const subTasksDirty = subTasks.length !== baseline.subTasks.length
    || subTasks.some((subTask) => {
      const openingSubTask = baselineSubTasksById.get(subTask.id)
      return !openingSubTask
        || subTask.title.trim() !== openingSubTask.title
        || subTask.completed !== openingSubTask.completed
    })
  const draftDirty = (
    title.trim() !== baseline.title.trim()
    || note.trim() !== baseline.note.trim()
    || startDate !== baseline.startDate
    || dueDate !== baseline.dueDate
    || (timeEnabled ? dueTime : null) !== baseline.dueTime
    || color !== baseline.color
    || tagId !== baseline.tagId
    || completed !== baseline.completed
    || subTasksDirty
    || Boolean(newSubTaskTitle.trim())
  )

  const saveDraft = () => {
    if (!validDraft || saveInProgressRef.current) return false
    saveInProgressRef.current = true
    const pendingTitle = newSubTaskTitle.trim()
    const pendingTimestamp = new Date().toISOString()
    const nextSubTasks = pendingTitle
      ? [...subTasks, {
          id: crypto.randomUUID(),
          title: pendingTitle,
          completed: false,
          completedAt: null,
          createdAt: pendingTimestamp,
          updatedAt: pendingTimestamp,
        }]
      : subTasks
    const draft: TaskDraft = {
      title: title.trim(),
      note: note.trim(),
      startDate,
      dueDate,
      dueTime: timeEnabled ? dueTime : null,
      color,
      tagId,
      subTasks: nextSubTasks.map((subTask) => ({ ...subTask, title: subTask.title.trim() })),
    }
    const editChanges = task
      ? getTaskEditChanges(task, draft, completed, parentStateTouched)
      : null
    try {
      const saved = onSave(
        draft,
        task?.id,
        editChanges ?? undefined,
      )
      if (!saved) saveInProgressRef.current = false
      return saved
    } catch (error) {
      saveInProgressRef.current = false
      throw error
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    saveDraft()
  }

  const requestBackdropClose = () => {
    if (!draftDirty) {
      onClose()
      return
    }
    unsavedReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : titleInputRef.current
    setConfirmUnsaved(true)
    window.setTimeout(() => unsavedContinueRef.current?.focus(), 0)
  }

  const quickDates = [
    { label: '오늘', value: todayKey() },
    { label: '내일', value: addDaysKey(todayKey(), 1) },
    { label: '이번 주말', value: getWeekendKey() },
  ]

  const setParentState = (nextCompleted: boolean) => {
    const timestamp = new Date().toISOString()
    setParentStateTouched(true)
    setCompleted(nextCompleted)
    setSubTasks((current) => current.map((subTask) => ({
      ...subTask,
      completed: nextCompleted,
      completedAt: nextCompleted ? (subTask.completedAt ?? timestamp) : null,
      updatedAt: timestamp,
    })))
  }

  const closeDeleteConfirm = () => {
    setConfirmDelete(false)
    window.setTimeout(() => deleteTriggerRef.current?.focus(), 0)
  }

  const addSubTask = () => {
    const title = newSubTaskTitle.trim()
    if (!title) return
    const timestamp = new Date().toISOString()
    setSubTasks((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        title,
        completed: false,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])
    setParentStateTouched(false)
    setCompleted(false)
    setNewSubTaskTitle('')
  }

  const toggleDraftSubTask = (id: string) => {
    const timestamp = new Date().toISOString()
    setParentStateTouched(false)
    setSubTasks((current) => {
      const next = current.map((subTask) => subTask.id === id
        ? {
            ...subTask,
            completed: !subTask.completed,
            completedAt: subTask.completed ? null : timestamp,
            updatedAt: timestamp,
          }
        : subTask)
      setCompleted(next.length > 0 && next.every((subTask) => subTask.completed))
      return next
    })
  }

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      data-qa="task-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestBackdropClose()
      }}
    >
      <section
        className="task-modal"
        data-qa="task-modal"
        data-mode={task ? 'edit' : 'create'}
        data-dirty={draftDirty}
        role="dialog"
        aria-modal="true"
        aria-hidden={confirmDelete || confirmUnsaved || undefined}
        aria-labelledby="task-modal-title"
        inert={confirmDelete || confirmUnsaved}
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
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

        <form data-qa="task-form" onSubmit={submit}>
          <label className="field-group task-title-field">
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

          <section className="subtask-editor" aria-labelledby="subtask-editor-title">
            <div className="subtask-editor-heading">
              <div>
                <span className="field-label" id="subtask-editor-title">
                  <CornerDownRight size={15} /> 세부 할 일 <span className="optional-label">선택</span>
                </span>
                <small>세부 할 일은 캘린더가 아닌 우측 일정 목록에만 보여요.</small>
              </div>
              {subTasks.length > 0 && (
                <span>{subTasks.filter((subTask) => subTask.completed).length}/{subTasks.length} 완료</span>
              )}
            </div>

            {subTasks.length > 0 && (
              <div className="subtask-edit-list">
                {subTasks.map((subTask) => (
                  <div
                    className={`subtask-edit-row ${subTask.completed ? 'is-completed' : ''}`}
                    data-subtask-id={subTask.id}
                    key={subTask.id}
                  >
                    <button
                      type="button"
                      className="subtask-toggle"
                      onClick={() => toggleDraftSubTask(subTask.id)}
                      aria-label={`${subTask.title} ${subTask.completed ? '활성화' : '완료'}`}
                      aria-pressed={subTask.completed}
                    >
                      {subTask.completed && <Check size={11} strokeWidth={3} />}
                    </button>
                    <input
                      value={subTask.title}
                      onChange={(event) => {
                        const timestamp = new Date().toISOString()
                        setSubTasks((current) => current.map((item) => item.id === subTask.id
                          ? { ...item, title: event.target.value, updatedAt: timestamp }
                          : item))
                      }}
                      maxLength={240}
                      aria-label="세부 할 일 내용"
                    />
                    <IconButton
                      label={`${subTask.title || '세부 할 일'} 삭제`}
                      className="subtask-delete"
                      onClick={() => {
                        setParentStateTouched(false)
                        setSubTasks((current) => {
                          const next = current.filter((item) => item.id !== subTask.id)
                          if (next.length > 0) setCompleted(next.every((item) => item.completed))
                          return next
                        })
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}

            <div className="subtask-add-row">
              <Plus size={15} aria-hidden="true" />
              <input
                value={newSubTaskTitle}
                onChange={(event) => setNewSubTaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addSubTask()
                }}
                placeholder="세부 할 일을 입력하고 Enter"
                maxLength={240}
                aria-label="subtask 추가"
              />
              <button type="button" onClick={addSubTask} disabled={!newSubTaskTitle.trim()}>
                추가
              </button>
            </div>
          </section>

          <section className="date-range-card" data-qa="date-range-fields" aria-labelledby="date-range-title">
            <div className="date-range-heading">
              <span className="field-label" id="date-range-title">
                <CalendarRange size={15} /> 일정 기간 <span className="required-pill">필수</span>
              </span>
              <small>{inclusiveDateKeys(startDate, dueDate).length}일</small>
            </div>
            <div className="date-range-inputs">
              <label>
                <span>시작일</span>
                <input
                  type="date"
                  value={startDate}
                  onInput={(event) => {
                    const next = event.currentTarget.value
                    setStartDate(next)
                    if (dueDate < next) setDueDate(next)
                  }}
                  aria-label="시작 날짜"
                  required
                />
              </label>
              <span aria-hidden="true">→</span>
              <label>
                <span>마감일</span>
                <input
                  type="date"
                  value={dueDate}
                  min={startDate}
                  onInput={(event) => setDueDate(event.currentTarget.value < startDate ? startDate : event.currentTarget.value)}
                  aria-label="마감 날짜"
                  required
                />
              </label>
            </div>
            <div className="quick-date-row">
              {quickDates.map((quick) => (
                <button
                  type="button"
                  key={quick.label}
                  className={startDate === quick.value && dueDate === quick.value ? 'is-selected' : ''}
                  onClick={() => {
                    setStartDate(quick.value)
                    setDueDate(quick.value)
                  }}
                >
                  {quick.label}
                </button>
              ))}
            </div>
          </section>

          {task && (
            <section className="task-state-card" aria-label="일정 상태 관리">
              <div className="task-state-heading">
                <div><span>일정 상태</span><small>변경 저장을 눌러야 반영돼요.</small></div>
                <strong className={completed ? 'is-inactive' : 'is-active'}>{completed ? '비활성' : '활성'}</strong>
              </div>
              <div className="task-state-controls" role="group" aria-label="활성 상태 선택">
                <button type="button" className={!completed ? 'is-selected' : ''} aria-pressed={!completed} onClick={() => setParentState(false)}>
                  <RotateCcw size={14} /> 활성
                </button>
                <button type="button" className={completed ? 'is-selected' : ''} aria-pressed={completed} onClick={() => setParentState(true)}>
                  <Check size={14} /> 비활성
                </button>
                <button type="button" className="task-remove-button" ref={deleteTriggerRef} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> 제거
                </button>
              </div>
            </section>
          )}

          <div className={`optional-time modal-time-card ${timeEnabled ? 'is-open' : ''}`}>
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
              <span><strong>마감 시간도 지정</strong><small>필요할 때만 추가하세요</small></span>
              <Clock3 size={17} />
            </button>
            {timeEnabled && (
              <label className="time-input-wrap">
                <span>마감 시간</span>
                <input type="time" value={dueTime} onInput={(event) => setDueTime(event.currentTarget.value)} aria-label="마감 시간" />
              </label>
            )}
          </div>

          <label className="field-group task-note-field">
            <span className="field-label">메모 <span className="optional-label">선택</span></span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="필요한 맥락이나 준비물을 적어두세요."
              aria-label="일정 메모"
              rows={3}
              maxLength={2000}
            />
          </label>

          <fieldset className="tag-picker" data-qa="task-tag-picker">
            <legend>일정 태그</legend>
            <div className="tag-picker-options" role="radiogroup" aria-label="일정 태그">
              <button type="button" className={tagId === null ? 'is-selected' : ''} onClick={() => setTagId(null)} aria-pressed={tagId === null}>
                <span className="tag-swatch is-neutral" /> 없음
              </button>
              {sortedPositioned(tags).map((tag) => (
                <button
                  type="button"
                  key={tag.id}
                  data-tag-id={tag.id}
                  className={tagId === tag.id ? 'is-selected' : ''}
                  onClick={() => {
                    setTagId(tag.id)
                    if (tag.legacyColor) setColor(tag.legacyColor)
                  }}
                  aria-pressed={tagId === tag.id}
                >
                  <span className="tag-swatch" style={{ background: tag.color }} /> {tag.name}
                </button>
              ))}
            </div>
          </fieldset>

          <footer className="modal-footer">
            <span>{task ? '내용과 상태 변경은 저장 버튼을 눌러 반영해요.' : '날짜만 선택해도 바로 저장할 수 있어요.'}</span>
            <div>
              <button type="button" className="secondary-button" onClick={onClose}>취소</button>
              <button
                type="submit"
                className="primary-button"
                disabled={!validDraft}
              >
                {task ? '변경 저장' : '일정 추가'}
              </button>
            </div>
          </footer>
        </form>
      </section>

      {confirmUnsaved && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            event.stopPropagation()
            if (event.target !== event.currentTarget) return
            setConfirmUnsaved(false)
            window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
          }}
        >
          <section
            className="delete-confirm-dialog unsaved-task-dialog"
            data-qa="unsaved-task-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-task-title"
            aria-describedby="unsaved-task-description"
            tabIndex={-1}
            onKeyDown={trapDialogFocus}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">UNSAVED SCHEDULE</span>
                <h3 id="unsaved-task-title">저장하지 않은 변경 사항</h3>
              </div>
              <button
                ref={unsavedContinueRef}
                type="button"
                className="icon-button"
                aria-label="계속 작성"
                title="계속 작성"
                onClick={() => {
                  setConfirmUnsaved(false)
                  window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
                }}
              >
                <X size={17} />
              </button>
            </header>
            <p id="unsaved-task-description">변경 사항이 있습니다. 저장하시겠습니까?</p>
            <div className="delete-confirm-actions">
              <button
                type="button"
                className="secondary-button"
                data-qa="unsaved-task-discard"
                onClick={onClose}
              >
                저장하지 않고 닫기
              </button>
              <button
                type="button"
                className="primary-button"
                data-qa="unsaved-task-save"
                disabled={!validDraft}
                onClick={saveDraft}
              >
                <Save size={14} /> {task ? '변경 저장' : '일정 추가'}
              </button>
            </div>
          </section>
        </div>
      )}

      {task && confirmDelete && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            event.stopPropagation()
            if (event.target === event.currentTarget) closeDeleteConfirm()
          }}
        >
          <section
            className="delete-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            aria-describedby="delete-confirm-description"
            tabIndex={-1}
            onKeyDown={trapDialogFocus}
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
                onClick={closeDeleteConfirm}
              >
                취소
              </button>
              <button
                type="button"
                className="delete-confirm-button"
                onClick={() => {
                  if (onDelete(task.id)) {
                    setConfirmDelete(false)
                    onClose()
                  }
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
  const layerRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open || !layerRef.current || !panelRef.current) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const releaseInert = makeOutsideInert(layerRef.current)
    const focusInitialControl = () => {
      const initialFocus = panelRef.current?.querySelector<HTMLElement>('header .icon-button')
      if (initialFocus) initialFocus.focus({ preventScroll: true })
      else panelRef.current?.focus({ preventScroll: true })
    }
    focusInitialControl()
    const focusFrame = window.requestAnimationFrame(focusInitialControl)
    const focusTimer = window.setTimeout(focusInitialControl, 80)
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.cancelAnimationFrame(focusFrame)
      window.clearTimeout(focusTimer)
      releaseInert()
      const previousFocus = returnFocusRef.current
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus()
      })
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={layerRef}
      className="recovery-layer is-open"
    >
      <div
        className="recovery-scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        id="recovery-panel"
        className="recovery-panel"
        data-qa="recovery-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
      >
        <header>
          <div className="recovery-icon"><ArchiveRestore size={21} /></div>
          <div>
            <span className="eyebrow">RECOVERY</span>
            <h2 id="recovery-title">최근 삭제</h2>
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
                <button
                  type="button"
                  className="restore-button"
                  onClick={() => {
                    onRestore(task.id)
                    window.setTimeout(() => {
                      const nextFocus = panelRef.current?.querySelector<HTMLElement>('.restore-button')
                        ?? panelRef.current?.querySelector<HTMLElement>('header .icon-button')
                      nextFocus?.focus()
                    })
                  }}
                >
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

function versionLabel(version: string | null | undefined) {
  if (!version) return '확인되지 않음'
  return version.toLocaleLowerCase().startsWith('v') ? version : `v${version}`
}

function updateStatusCopy(state: UpdateState) {
  switch (state.status) {
    case 'unsupported':
      return {
        title: '이 실행 방식에서는 자동 업데이트를 사용할 수 없어요',
        description: '설치(Setup) 버전에서만 앱 안에서 업데이트할 수 있어요.',
      }
    case 'checking':
      return { title: '새 버전을 확인하고 있어요', description: 'GitHub Releases에 연결하는 중입니다.' }
    case 'available':
      return {
        title: `${versionLabel(state.availableVersion)} 업데이트를 사용할 수 있어요`,
        description: '업데이트를 누르면 다운로드 후 자동으로 설치하고 다시 시작합니다.',
      }
    case 'not-available':
      return { title: '현재 최신 버전을 사용하고 있어요', description: `${versionLabel(state.currentVersion)}이 최신 버전입니다.` }
    case 'downloading':
      return { title: '업데이트를 다운로드하고 있어요', description: '작업을 계속해도 괜찮아요.' }
    case 'downloaded':
      return { title: '업데이트를 설치할 준비가 됐어요', description: '자동 설치가 이어지지 않았다면 아래 버튼으로 설치하고 다시 시작하세요.' }
    case 'installing':
      return { title: '업데이트를 설치하고 있어요', description: '잠시 후 앱이 새 버전으로 다시 시작됩니다.' }
    case 'error':
      return { title: '업데이트를 확인하지 못했어요', description: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' }
    default:
      return { title: '업데이트를 확인해 보세요', description: 'GitHub Releases에서 최신 설치 버전을 확인합니다.' }
  }
}

function updateErrorCopy(code: string) {
  switch (code) {
    case 'UPDATE_NETWORK_UNAVAILABLE':
      return '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
    case 'UPDATE_ACCESS_DENIED':
      return 'GitHub 릴리스에 접근하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    case 'UPDATE_INTEGRITY_FAILED':
      return '다운로드한 파일의 무결성을 확인하지 못했습니다. 다시 다운로드해 주세요.'
    case 'UPDATE_DOWNLOAD_FAILED':
      return '업데이트 다운로드에 실패했습니다. 다시 시도해 주세요.'
    case 'UPDATE_INSTALL_FAILED':
      return '설치 프로그램을 시작하지 못했습니다. 다시 시도해 주세요.'
    default:
      return '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
  }
}

function unsupportedUpdateCopy(state: UpdateState) {
  if (state.unsupportedReason === 'portable') {
    return {
      title: 'Portable 버전을 사용 중이에요',
      description: '자동 업데이트는 NSIS Setup으로 설치한 Dayline에서만 지원합니다. Portable 버전은 GitHub Releases에서 새 파일을 받아 교체해 주세요.',
    }
  }
  if (state.unsupportedReason === 'platform') {
    return {
      title: 'Windows 설치형에서 사용할 수 있어요',
      description: 'Dayline의 앱 내 자동 업데이트는 Windows NSIS Setup 설치형을 지원합니다.',
    }
  }
  return {
    title: '설치형 앱에서 사용할 수 있어요',
    description: '개발 실행과 QA 환경에서는 네트워크 업데이트를 비활성화합니다. NSIS Setup으로 설치한 Dayline에서 확인해 주세요.',
  }
}

function ReleaseNotesContent({
  notes,
  dataQa = 'update-release-notes',
  ariaLabel = '릴리스 노트 상세',
}: {
  notes: string
  dataQa?: string
  ariaLabel?: string
}) {
  const blocks = useMemo(() => parseReleaseNotes(notes), [notes])
  if (blocks.length === 0) return null
  return (
    <div
      className="update-release-notes"
      data-qa={dataQa}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
    >
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`
        if (block.kind === 'heading') {
          return block.level === 2
            ? <h4 key={key} data-release-note-kind="heading">{block.text}</h4>
            : <h5 key={key} data-release-note-kind="heading">{block.text}</h5>
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List key={key} data-release-note-kind="list">
              {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{item}</li>)}
            </List>
          )
        }
        return <p key={key} data-release-note-kind="paragraph">{block.text}</p>
      })}
    </div>
  )
}

function InstalledReleaseHistoryCard({ history }: { history: UpdateState['installedReleaseHistory'] }) {
  if (history.state === 'no-baseline') return null

  const releaseTitle = history.releaseName?.trim()
    || `${versionLabel(history.toVersion)} 업데이트 변경 사항`
  const fromVersion = versionLabel(history.fromVersion)
  const toVersion = versionLabel(history.toVersion)
  const notes = history.releaseNotes?.trim()

  return (
    <section
      className="update-release-card update-installed-history-card"
      data-qa="update-installed-release-history"
      data-history-state={history.state}
      aria-labelledby="update-installed-release-title"
    >
      <span className="eyebrow">INSTALLED UPDATE</span>
      <h3 id="update-installed-release-title" data-qa="update-installed-release-title">{releaseTitle}</h3>
      <p className="update-history-range" data-qa="update-installed-release-range">
        {history.fromVersion ? `${fromVersion} 이후 ${toVersion}까지의 변경 사항` : `${toVersion} 변경 사항`}
      </p>
      {history.state === 'ready' && notes ? (
        <ReleaseNotesContent
          notes={notes}
          dataQa="update-installed-release-notes"
          ariaLabel="설치된 업데이트의 릴리스 노트 상세"
        />
      ) : (
        <p className="update-history-unavailable" data-qa="update-installed-release-unavailable">
          설치된 버전 범위의 릴리스 노트를 불러오지 못했어요. 인터넷 연결 후 업데이트 확인을 다시 눌러 주세요.
        </p>
      )}
    </section>
  )
}

function UpdatePanel({
  state,
  onCheck,
  onDownload,
  onInstall,
  onClose,
}: {
  state: UpdateState
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
  onClose: () => void
}) {
  const statusCopy = updateStatusCopy(state)
  const progress = clamp(Math.round(state.progress ?? 0), 0, 100)
  const busy = state.status === 'checking' || state.status === 'downloading'
  const releaseTitle = state.releaseName?.trim()
  const unsupportedCopy = unsupportedUpdateCopy(state)

  return (
    <aside
      id="rail-panel-updates"
      className="rail-flyout is-wide update-panel"
      data-qa="update-panel"
      data-state={state.status}
      aria-labelledby="rail-action-updates"
    >
      <header className="flyout-header">
        <div><span className="eyebrow">APP UPDATE</span><h2>업데이트</h2></div>
        <IconButton label="업데이트 닫기" onClick={onClose} autoFocus><X size={17} /></IconButton>
      </header>
      <p className="flyout-intro">앱을 실행할 때마다 새 릴리스를 확인하며, 여기서 언제든 다시 확인할 수 있어요.</p>

      <div className="update-panel-scroll">
        <section className={`update-status-card status-${state.status}`} data-qa="update-status" aria-live="polite">
          <span className="update-status-icon" aria-hidden="true">
            {state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'
              ? <RefreshCw size={19} />
              : state.status === 'downloaded' || state.status === 'not-available'
                ? <Check size={19} />
                : state.status === 'available'
                  ? <Download size={19} />
                  : <MonitorUp size={19} />}
          </span>
          <div>
            <strong>{statusCopy.title}</strong>
            <span>{statusCopy.description}</span>
          </div>
        </section>

        <dl className="update-version-grid">
          <div><dt>현재 버전</dt><dd>{versionLabel(state.currentVersion)}</dd></div>
          <div><dt>최신 버전</dt><dd>{versionLabel(state.availableVersion ?? (state.status === 'not-available' ? state.currentVersion : null))}</dd></div>
        </dl>

        {state.status === 'downloading' && (
          <div className="update-progress-wrap">
            <div><span>다운로드</span><strong>{progress}%</strong></div>
            <div
              className="update-progress"
              data-qa="update-progress"
              role="progressbar"
              aria-label="업데이트 다운로드"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {state.error && (
          <div className="update-error" data-qa="update-error" role="alert">
            <strong>업데이트 오류</strong>
            <span>{updateErrorCopy(state.error)}</span>
          </div>
        )}

        {state.status === 'unsupported' && (
          <div className="update-portable-note" data-qa="update-unsupported-note">
            <strong>{unsupportedCopy.title}</strong>
            <span>{unsupportedCopy.description}</span>
          </div>
        )}

        {(releaseTitle || state.releaseNotes) && state.availableVersion && (
          <section
            className="update-release-card"
            data-qa="update-available-release"
            aria-labelledby="update-release-title"
          >
            <span className="eyebrow">RELEASE NOTES</span>
            <h3 id="update-release-title">{releaseTitle || `${versionLabel(state.availableVersion)} 변경 사항`}</h3>
            {state.releaseNotes && <ReleaseNotesContent notes={state.releaseNotes} />}
          </section>
        )}

        <InstalledReleaseHistoryCard history={state.installedReleaseHistory} />

        <div className="update-actions">
          <button
            type="button"
            className="secondary-button"
            data-qa="update-check"
            disabled={!state.canCheck || busy}
            onClick={onCheck}
          >
            <RefreshCw size={14} /> {state.status === 'checking' ? '확인 중…' : '업데이트 확인'}
          </button>
          {(state.status === 'available' || (state.status === 'error' && state.availableVersion)) && (
            <button
              type="button"
              className="primary-button"
              data-qa="update-download"
              disabled={!state.canDownload}
              onClick={onDownload}
            >
              <Download size={14} /> {state.error ? '다운로드 다시 시도' : '업데이트'}
            </button>
          )}
          {state.status === 'downloaded' && (
            <button
              type="button"
              className="primary-button"
              data-qa="update-install"
              disabled={!state.canInstall}
              onClick={onInstall}
            >
              <RefreshCw size={14} /> 설치하고 다시 시작
            </button>
          )}
        </div>
        <p className="update-data-note">업데이트 중에도 일정과 설정은 기기의 기존 SQLite 데이터베이스에 그대로 보존됩니다.</p>
      </div>
    </aside>
  )
}

function UpdateAvailableDialog({
  open,
  state,
  onLater,
  onDownload,
  onInstall,
}: {
  open: boolean
  state: UpdateState
  onLater: () => void
  onDownload: () => void
  onInstall: () => void
}) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const progress = clamp(Math.round(state.progress ?? 0), 0, 100)

  useEffect(() => {
    if (!open || !layerRef.current || !dialogRef.current) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseInert = makeOutsideInert(layerRef.current)
    const focusDialog = () => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>('[data-qa="update-dialog-primary"]:not([disabled])')
        ?? dialogRef.current?.querySelector<HTMLElement>('[data-qa="update-dialog-later"]')
      preferred?.focus({ preventScroll: true })
    }
    const focusFrame = window.requestAnimationFrame(focusDialog)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      releaseInert()
      const previousFocus = returnFocusRef.current
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus()
        else document.getElementById('rail-action-updates')?.focus()
      }, 0)
    }
  }, [open])

  if (!open) return null

  const downloading = state.status === 'downloading'
  const downloaded = state.status === 'downloaded'
  const installing = state.status === 'installing'
  const failed = Boolean(state.error)

  return (
    <div
      ref={layerRef}
      className="update-dialog-layer"
      data-qa="update-available-dialog"
      data-state={state.status}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onLater()
      }}
    >
      <section
        ref={dialogRef}
        className="update-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        aria-describedby="update-dialog-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            event.nativeEvent.stopImmediatePropagation()
            onLater()
            return
          }
          trapDialogFocus(event)
        }}
      >
        <span className="update-dialog-icon" aria-hidden="true">
          {downloaded ? <Check size={24} /> : downloading || installing ? <RefreshCw size={24} /> : <Download size={24} />}
        </span>
        <div className="update-dialog-copy">
          <span className="eyebrow">NEW DAYLINE RELEASE</span>
          <h2 id="update-dialog-title">
            {installing ? '업데이트를 설치하고 있어요' : downloaded ? '업데이트 설치 준비가 끝났어요' : `${versionLabel(state.availableVersion)} 업데이트가 있어요`}
          </h2>
          <p id="update-dialog-description">
            {installing
              ? '잠시 후 앱이 새 버전으로 다시 시작됩니다. 창을 강제로 닫지 마세요.'
              : downloaded
              ? '자동 설치가 이어지지 않았다면 아래 버튼으로 설치하고 다시 시작하세요. 일정과 설정은 그대로 유지됩니다.'
              : downloading
                ? '업데이트를 다운로드하고 있어요. 완료되면 자동으로 설치하고 다시 시작합니다.'
                : failed
                  ? '다운로드하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
                  : '업데이트를 누르면 다운로드 후 자동으로 설치하고 다시 시작합니다.'}
          </p>
          {state.releaseName && <strong className="update-dialog-release-name">{state.releaseName}</strong>}
          {state.releaseNotes && <ReleaseNotesContent notes={state.releaseNotes} />}
          {downloading && (
            <div
              className="update-progress"
              data-qa="update-dialog-progress"
              role="progressbar"
              aria-label="업데이트 다운로드"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <i style={{ width: `${progress}%` }} />
            </div>
          )}
          {failed && state.error && <span className="update-dialog-error" role="alert">{updateErrorCopy(state.error)}</span>}
        </div>
        <div className="update-dialog-actions">
          <button type="button" className="secondary-button" data-qa="update-dialog-later" onClick={onLater}>
            {downloading || installing ? '백그라운드에서 계속' : '나중에'}
          </button>
          {!downloading && !downloaded && !installing && (
            <button
              type="button"
              className="primary-button"
              data-qa="update-dialog-primary"
              disabled={!state.canDownload}
              onClick={onDownload}
            >
              <Download size={14} /> {failed ? '다시 시도' : '업데이트'}
            </button>
          )}
          {downloaded && (
            <button
              type="button"
              className="primary-button"
              data-qa="update-dialog-primary"
              disabled={!state.canInstall}
              onClick={onInstall}
            >
              <RefreshCw size={14} /> 설치하고 다시 시작
            </button>
          )}
        </div>
      </section>
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

function FilterPanel({
  tags,
  selected,
  onToggle,
  onClear,
  onClose,
}: {
  tags: TaskTag[]
  selected: Set<string>
  onToggle: (id: string) => void
  onClear: () => void
  onClose: () => void
}) {
  return (
    <aside id="rail-panel-filters" className="rail-flyout" data-qa="filter-panel" aria-labelledby="rail-action-filters">
      <header className="flyout-header">
        <div><span className="eyebrow">FILTER</span><h2>태그 필터</h2></div>
        <IconButton label="태그 필터 닫기" onClick={onClose} autoFocus><X size={17} /></IconButton>
      </header>
      <p className="flyout-intro">선택한 태그 중 하나라도 포함된 일정만 표시해요.</p>
      <div className="filter-tag-list" role="group" aria-label="표시할 태그 복수 선택">
        {sortedPositioned(tags).map((tag) => (
          <button
            type="button"
            key={tag.id}
            data-tag-id={tag.id}
            className={selected.has(tag.id) ? 'is-selected' : ''}
            role="checkbox"
            aria-checked={selected.has(tag.id)}
            onClick={() => onToggle(tag.id)}
          >
            <span className="tag-swatch" style={{ background: tag.color }} />
            <span>{tag.name}</span>
            {selected.has(tag.id) && <Check size={14} />}
          </button>
        ))}
        <button
          type="button"
          className={selected.has(UNTAGGED_FILTER) ? 'is-selected' : ''}
          role="checkbox"
          aria-checked={selected.has(UNTAGGED_FILTER)}
          onClick={() => onToggle(UNTAGGED_FILTER)}
        >
          <span className="tag-swatch is-neutral" /><span>태그 없음</span>
          {selected.has(UNTAGGED_FILTER) && <Check size={14} />}
        </button>
      </div>
      <button type="button" className="flyout-clear" onClick={onClear} disabled={selected.size === 0}>
        필터 초기화
      </button>
    </aside>
  )
}

function TagManagerRow({
  tag,
  onUpdate,
  onDelete,
}: {
  tag: TaskTag
  onUpdate: (id: string, changes: Partial<Pick<TaskTag, 'name' | 'color'>>) => boolean
  onDelete: (id: string) => void
}) {
  const [name, setName] = useState(tag.name)
  useEffect(() => setName(tag.name), [tag.name])
  return (
    <article className="tag-manager-row" data-tag-id={tag.id}>
      <div className="tag-color-controls" role="group" aria-label={`${tag.name} 색상 선택`}>
        {TAG_PALETTE.map((color) => (
          <button
            type="button"
            key={color}
            className={normalizedHex(tag.color) === color ? 'is-selected' : ''}
            style={{ background: color }}
            aria-label={`${tag.name} 색상 ${color.toUpperCase()}`}
            onClick={() => onUpdate(tag.id, { color })}
          />
        ))}
        <input
          type="color"
          value={normalizedHex(tag.color)}
          aria-label={`${tag.name} 사용자 지정 색상`}
          onChange={(event) => onUpdate(tag.id, { color: event.target.value })}
        />
      </div>
      <input
        value={name}
        aria-label={`${tag.name} 이름`}
        maxLength={40}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const next = name.trim()
          if (!next) setName(tag.name)
          else if (next !== tag.name && !onUpdate(tag.id, { name: next })) setName(tag.name)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setName(tag.name)
            event.currentTarget.blur()
          }
        }}
      />
      <span>{tag.builtIn ? '기본' : '사용자'}</span>
      {!tag.builtIn && (
        <IconButton label={`${tag.name} 태그 삭제`} onClick={() => onDelete(tag.id)}><Trash2 size={14} /></IconButton>
      )}
    </article>
  )
}

function GeneralSettingsPanel({
  settings,
  onSettingsChange,
  onClose,
}: {
  settings: AppSettings
  onSettingsChange: (changes: Partial<AppSettings>) => boolean
  onClose: () => void
}) {
  return (
    <aside id="rail-panel-appearance" className="rail-flyout" data-qa="appearance-panel" aria-labelledby="rail-action-appearance">
      <header className="flyout-header">
        <div><span className="eyebrow">GENERAL</span><h2>일반 설정</h2></div>
        <IconButton label="일반 설정 닫기" onClick={onClose} autoFocus><X size={17} /></IconButton>
      </header>
      <div className="settings-scroll">
        <section className="settings-card">
          <button
            type="button"
            className={`settings-toggle ${settings.calendarWeekScroll ? 'is-on' : ''}`}
            role="switch"
            aria-checked={settings.calendarWeekScroll}
            data-qa="calendar-week-scroll-toggle"
            onClick={() => onSettingsChange({ calendarWeekScroll: !settings.calendarWeekScroll })}
          >
            <span className="settings-toggle-copy">
              <strong>스크롤하여 달력 내리기</strong>
              <small>달력 위에서 스크롤하면 한 번에 한 주씩 이전·다음 기간으로 이동해요.</small>
            </span>
            <span className="settings-toggle-control" aria-hidden="true">
              <span className="settings-toggle-state" data-qa="calendar-week-scroll-state">
                {settings.calendarWeekScroll ? 'ON' : 'OFF'}
              </span>
              <span className="switch-track"><span /></span>
            </span>
          </button>
        </section>
        <section className="settings-card">
          <div className="settings-heading"><span>글자·화면 배율</span><strong>{Math.round(settings.fontScale * 100)}%</strong></div>
          <input
            type="range"
            data-qa="font-scale"
            min="0.85"
            max="1.5"
            step="0.05"
            value={settings.fontScale}
            aria-label="글자 및 화면 배율"
            onChange={(event) => onSettingsChange({ fontScale: Number(event.target.value) })}
          />
        </section>
        <section className="settings-card">
          <div className="settings-heading"><span>테마 색상</span><span className="tag-swatch" style={{ background: settings.themeColor }} /></div>
          <div className="theme-palette" aria-label="테마 색상 팔레트">
            {TAG_PALETTE.map((color) => (
              <button
                type="button"
                key={color}
                style={{ background: color }}
                className={normalizedHex(settings.themeColor) === color ? 'is-selected' : ''}
                aria-label={`테마 색상 ${color.toUpperCase()}`}
                onClick={() => onSettingsChange({ themeColor: color })}
              />
            ))}
            <input
              type="color"
              data-qa="theme-color"
              value={normalizedHex(settings.themeColor)}
              aria-label="사용자 지정 테마 색상"
              onChange={(event) => onSettingsChange({ themeColor: event.target.value })}
            />
          </div>
        </section>
      </div>
    </aside>
  )
}

function TagSettingsPanel({
  tags,
  onTagCreate,
  onTagUpdate,
  onTagDelete,
  onClose,
}: {
  tags: TaskTag[]
  onTagCreate: (name: string, color: string) => boolean
  onTagUpdate: (id: string, changes: Partial<Pick<TaskTag, 'name' | 'color'>>) => boolean
  onTagDelete: (id: string) => void
  onClose: () => void
}) {
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(TAG_PALETTE[5])
  return (
    <aside id="rail-panel-tags" className="rail-flyout is-wide" data-qa="tag-settings-panel" aria-labelledby="rail-action-tags">
      <header className="flyout-header">
        <div><span className="eyebrow">TAGS</span><h2>태그 설정</h2></div>
        <IconButton label="태그 설정 닫기" onClick={onClose} autoFocus><X size={17} /></IconButton>
      </header>
      <p className="flyout-intro">일정에 사용할 태그의 이름과 색상을 관리해요.</p>
      <div className="settings-scroll">
        <section className="settings-card tag-manager">
          <div className="settings-heading"><span>태그 관리</span><strong>{tags.length}</strong></div>
          <div className="tag-manager-list">
            {sortedPositioned(tags).map((tag) => (
              <TagManagerRow key={tag.id} tag={tag} onUpdate={onTagUpdate} onDelete={onTagDelete} />
            ))}
          </div>
          <div className="tag-create-row">
            <div className="tag-color-controls" role="group" aria-label="새 태그 색상 선택">
              {TAG_PALETTE.map((color) => (
                <button
                  type="button"
                  key={color}
                  className={newTagColor === color ? 'is-selected' : ''}
                  style={{ background: color }}
                  aria-label={`새 태그 색상 ${color.toUpperCase()}`}
                  onClick={() => setNewTagColor(color)}
                />
              ))}
              <input type="color" value={newTagColor} aria-label="새 태그 사용자 지정 색상" onChange={(event) => setNewTagColor(event.target.value)} />
            </div>
            <input data-qa="new-tag-name" value={newTagName} aria-label="새 태그 이름" placeholder="새 태그 이름" maxLength={40} onChange={(event) => setNewTagName(event.target.value)} />
            <button
              type="button"
              disabled={!newTagName.trim()}
              onClick={() => {
                if (onTagCreate(newTagName.trim(), newTagColor)) setNewTagName('')
              }}
            >
              <Plus size={14} /> 추가
            </button>
          </div>
        </section>
      </div>
    </aside>
  )
}

function TemplateModal({
  open,
  template,
  tags,
  onClose,
  onSave,
}: {
  open: boolean
  template: TaskTemplate | null
  tags: TaskTag[]
  onClose: () => void
  onSave: (draft: TemplateDraft, id?: string, openingSnapshot?: TaskTemplate) => boolean
}) {
  const defaultTag = tags[0] ?? null
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [subTaskText, setSubTaskText] = useState('')
  const [durationDays, setDurationDays] = useState(1)
  const [timeEnabled, setTimeEnabled] = useState(false)
  const [dueTime, setDueTime] = useState('09:00')
  const [tagId, setTagId] = useState<string | null>(defaultTag?.id ?? null)
  const [legacyColor, setLegacyColor] = useState<TaskColor>(defaultTag?.legacyColor ?? 'coral')
  const [confirmUnsaved, setConfirmUnsaved] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const unsavedContinueRef = useRef<HTMLButtonElement>(null)
  const unsavedReturnFocusRef = useRef<HTMLElement | null>(null)
  const saveInProgressRef = useRef(false)
  const draftBaselineRef = useRef<TemplateDraft>({
    title: '',
    note: '',
    dueTime: null,
    tagId: defaultTag?.id ?? null,
    legacyColor: defaultTag?.legacyColor ?? 'coral',
    durationDays: 1,
    subTaskTitles: [],
  })

  const editorSession = open ? template?.id ?? '__new-template__' : null

  useEffect(() => {
    if (!editorSession) return
    const openingDraft: TemplateDraft = {
      title: template?.title ?? '',
      note: template?.note ?? '',
      dueTime: template?.dueTime ?? null,
      tagId: template?.tagId ?? defaultTag?.id ?? null,
      legacyColor: template?.legacyColor ?? defaultTag?.legacyColor ?? 'coral',
      durationDays: clamp(Math.round(template?.durationDays ?? 1), 1, 365),
      subTaskTitles: (template?.subTaskTitles ?? []).map((item) => item.trim()).filter(Boolean),
    }
    setTitle(openingDraft.title)
    setNote(openingDraft.note)
    setSubTaskText(openingDraft.subTaskTitles.join('\n'))
    setDurationDays(openingDraft.durationDays)
    setTimeEnabled(Boolean(openingDraft.dueTime))
    setDueTime(openingDraft.dueTime ?? '09:00')
    setTagId(openingDraft.tagId)
    setLegacyColor(openingDraft.legacyColor)
    setConfirmUnsaved(false)
    saveInProgressRef.current = false
    draftBaselineRef.current = openingDraft
    const focusTimer = window.setTimeout(() => titleInputRef.current?.focus(), 60)
    return () => window.clearTimeout(focusTimer)
    // Initialize once per open editor session. Live tag/order broadcasts must
    // not erase a draft that the user is already composing.
  }, [editorSession])

  useEffect(() => {
    if (!open || !backdropRef.current) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseInert = makeOutsideInert(backdropRef.current)
    return () => {
      releaseInert()
      const previousFocus = returnFocusRef.current
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus()
        else document.getElementById('rail-action-templates')?.focus()
      }, 0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (confirmUnsaved) {
        setConfirmUnsaved(false)
        window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
      } else onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [confirmUnsaved, onClose, open])

  if (!open) return null

  const currentDraft: TemplateDraft = {
    title: title.trim(),
    note: note.trim(),
    dueTime: timeEnabled ? dueTime : null,
    tagId,
    legacyColor,
    durationDays: clamp(Math.round(durationDays), 1, 365),
    subTaskTitles: subTaskText.split('\n').map((item) => item.trim()).filter(Boolean),
  }
  const baseline = draftBaselineRef.current
  const draftDirty = currentDraft.title !== baseline.title.trim()
    || currentDraft.note !== baseline.note.trim()
    || currentDraft.dueTime !== baseline.dueTime
    || currentDraft.tagId !== baseline.tagId
    || currentDraft.legacyColor !== baseline.legacyColor
    || currentDraft.durationDays !== baseline.durationDays
    || currentDraft.subTaskTitles.length !== baseline.subTaskTitles.length
    || currentDraft.subTaskTitles.some((item, index) => item !== baseline.subTaskTitles[index])
  const validDraft = Boolean(currentDraft.title)

  const saveDraft = () => {
    if (!validDraft || saveInProgressRef.current) return false
    saveInProgressRef.current = true
    try {
      const saved = onSave(currentDraft, template?.id, template ?? undefined)
      if (saved) onClose()
      else saveInProgressRef.current = false
      return saved
    } catch (error) {
      saveInProgressRef.current = false
      throw error
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    saveDraft()
  }

  const requestBackdropClose = () => {
    if (!draftDirty) {
      onClose()
      return
    }
    unsavedReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : titleInputRef.current
    setConfirmUnsaved(true)
    window.setTimeout(() => unsavedContinueRef.current?.focus(), 0)
  }

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      data-qa="template-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestBackdropClose()
      }}
    >
      <section
        className="task-modal template-modal"
        data-qa="template-modal"
        data-mode={template ? 'edit' : 'create'}
        data-dirty={draftDirty}
        role="dialog"
        aria-modal="true"
        aria-hidden={confirmUnsaved || undefined}
        aria-labelledby="template-modal-title"
        inert={confirmUnsaved}
        tabIndex={-1}
        onKeyDown={trapDialogFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">RECURRING TEMPLATE</span>
            <h2 id="template-modal-title">{template ? '반복 일정 수정' : '반복 일정 만들기'}</h2>
          </div>
          <IconButton label="반복 일정 작성 닫기" onClick={onClose}><X size={19} /></IconButton>
        </header>

        <form className="template-modal-form" data-qa="template-form" onSubmit={submit}>
          <label className="field-group task-title-field">
            <span className="field-label">할 일</span>
            <input
              ref={titleInputRef}
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="반복해서 사용할 일정 제목"
              aria-label="템플릿 제목"
              maxLength={240}
              required
            />
          </label>

          <label className="field-group template-subtasks-field">
            <span className="field-label">세부 할 일 <span className="optional-label">선택 · 한 줄에 하나</span></span>
            <textarea
              value={subTaskText}
              onChange={(event) => setSubTaskText(event.target.value)}
              placeholder={'자료 확인\n초안 작성'}
              aria-label="템플릿 세부 할 일"
              rows={4}
            />
          </label>

          <section className="template-duration-card" aria-labelledby="template-duration-title">
            <div>
              <span className="field-label" id="template-duration-title"><CalendarRange size={15} /> 일정 기간</span>
              <small>캘린더에 놓은 날짜부터 며칠간 이어질지 정해요.</small>
            </div>
            <label>
              <input
                type="number"
                min="1"
                max="365"
                value={durationDays}
                aria-label="템플릿 기간 일수"
                onChange={(event) => setDurationDays(clamp(Number(event.target.value) || 1, 1, 365))}
              />
              <span>일</span>
            </label>
          </section>

          <div className={`optional-time modal-time-card ${timeEnabled ? 'is-open' : ''}`}>
            <button
              type="button"
              className="time-toggle"
              role="switch"
              aria-checked={timeEnabled}
              onClick={() => setTimeEnabled((current) => !current)}
            >
              <span className="switch-track"><span /></span>
              <span><strong>마감 시간도 지정</strong><small>템플릿을 놓은 날짜의 시간으로 적용돼요.</small></span>
              <Clock3 size={17} />
            </button>
            {timeEnabled && (
              <label className="time-input-wrap">
                <span>마감 시간</span>
                <input type="time" value={dueTime} onInput={(event) => setDueTime(event.currentTarget.value)} aria-label="템플릿 마감 시간" />
              </label>
            )}
          </div>

          <label className="field-group task-note-field">
            <span className="field-label">메모 <span className="optional-label">선택</span></span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} aria-label="템플릿 메모" placeholder="필요한 맥락이나 준비물을 적어두세요." rows={3} maxLength={2000} />
          </label>

          <fieldset className="tag-picker">
            <legend>일정 태그</legend>
            <div className="tag-picker-options" role="radiogroup" aria-label="템플릿 태그">
              <button type="button" className={tagId === null ? 'is-selected' : ''} onClick={() => setTagId(null)} aria-pressed={tagId === null}>
                <span className="tag-swatch is-neutral" /> 없음
              </button>
              {sortedPositioned(tags).map((tag) => (
                <button
                  type="button"
                  key={tag.id}
                  data-tag-id={tag.id}
                  className={tagId === tag.id ? 'is-selected' : ''}
                  onClick={() => {
                    setTagId(tag.id)
                    if (tag.legacyColor) setLegacyColor(tag.legacyColor)
                  }}
                  aria-pressed={tagId === tag.id}
                >
                  <span className="tag-swatch" style={{ background: tag.color }} /> {tag.name}
                </button>
              ))}
            </div>
          </fieldset>

          <footer className="modal-footer">
            <span>날짜는 캘린더에 템플릿을 놓을 때 정해져요.</span>
            <div>
              <button type="button" className="secondary-button" data-qa="template-form-cancel" onClick={onClose}>취소</button>
              <button type="submit" className="primary-button" disabled={!validDraft}>
                {template ? '변경 저장' : '반복 일정 추가'}
              </button>
            </div>
          </footer>
        </form>
      </section>

      {confirmUnsaved && (
        <div
          className="delete-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            event.stopPropagation()
            if (event.target !== event.currentTarget) return
            setConfirmUnsaved(false)
            window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
          }}
        >
          <section
            className="delete-confirm-dialog unsaved-task-dialog"
            data-qa="unsaved-template-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-template-title"
            aria-describedby="unsaved-template-description"
            tabIndex={-1}
            onKeyDown={trapDialogFocus}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">UNSAVED TEMPLATE</span>
                <h3 id="unsaved-template-title">저장하지 않은 변경 사항</h3>
              </div>
              <button
                ref={unsavedContinueRef}
                type="button"
                className="icon-button"
                aria-label="계속 작성"
                title="계속 작성"
                onClick={() => {
                  setConfirmUnsaved(false)
                  window.setTimeout(() => unsavedReturnFocusRef.current?.focus(), 0)
                }}
              >
                <X size={17} />
              </button>
            </header>
            <p id="unsaved-template-description">변경 사항이 있습니다. 저장하시겠습니까?</p>
            <div className="delete-confirm-actions">
              <button
                type="button"
                className="secondary-button"
                data-qa="unsaved-template-discard"
                onClick={onClose}
              >
                저장하지 않고 닫기
              </button>
              <button
                type="button"
                className="primary-button"
                data-qa="unsaved-template-save"
                disabled={!validDraft}
                onClick={saveDraft}
              >
                <Save size={14} /> {template ? '변경 저장' : '반복 일정 추가'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function TemplatePanel({
  templates,
  tags,
  selectedDate,
  onDelete,
  onInstantiate,
  onReorder,
  calendarDragging,
  onCreateRequest,
  onEditRequest,
  onCalendarDragStart,
  onCalendarDragEnd,
  onClose,
}: {
  templates: TaskTemplate[]
  tags: TaskTag[]
  selectedDate: string
  onDelete: (id: string) => boolean
  onInstantiate: (id: string, startDate: string) => boolean
  onReorder: (orderedIds: string[]) => boolean
  calendarDragging: boolean
  onCreateRequest: () => void
  onEditRequest: (template: TaskTemplate) => void
  onCalendarDragStart: (templateId: string) => void
  onCalendarDragEnd: () => void
  onClose: () => void
}) {
  const orderedTemplates = useMemo(() => sortedPositioned(templates), [templates])
  const orderedIds = orderedTemplates.map((template) => template.id)
  return (
    <aside
      id="rail-panel-templates"
      className="rail-flyout is-wide"
      data-qa="template-panel"
      data-calendar-dragging={calendarDragging || undefined}
      aria-hidden={calendarDragging || undefined}
      aria-labelledby="rail-action-templates"
    >
      <header className="flyout-header">
        <div><span className="eyebrow">TEMPLATES</span><h2>반복 일정</h2></div>
        <div className="flyout-header-actions">
          <button
            type="button"
            className="template-create-toggle"
            data-qa="template-form-toggle"
            aria-haspopup="dialog"
            onClick={onCreateRequest}
          >
            <Plus size={14} /> 추가
          </button>
          <IconButton label="반복 일정 닫기" onClick={onClose} autoFocus><X size={17} /></IconButton>
        </div>
      </header>
      <p className="flyout-intro">카드를 날짜 칸에 놓거나 선택한 날짜에 바로 추가하세요.</p>
      <div className="template-scroll">
        <div className="template-card-list" data-qa="template-list">
          {orderedTemplates.map((template) => {
            const tag = tags.find((item) => item.id === template.tagId)
            const rawColor = normalizedHex(tag?.color ?? LEGACY_COLORS[template.legacyColor])
            return (
              <article
                key={template.id}
                className="template-card"
                data-template-id={template.id}
                data-qa="template-reorder-target"
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(TEMPLATE_ORDER_MIME)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  const draggedId = event.dataTransfer.getData(TEMPLATE_ORDER_MIME)
                  if (!draggedId) return
                  event.preventDefault()
                  event.stopPropagation()
                  onReorder(droppedIds(orderedIds, draggedId, template.id))
                }}
                style={{ '--task-color': accessibleAccent(rawColor), '--task-raw': rawColor } as CSSProperties}
              >
                <div
                  className="template-card-copy-source"
                  data-qa="template-calendar-drag-source"
                  draggable
                  title="캘린더 날짜로 드래그하여 일정 추가"
                  onDragStart={(event) => {
                    event.stopPropagation()
                    event.dataTransfer.effectAllowed = 'copy'
                    event.dataTransfer.setData(TEMPLATE_COPY_MIME, template.id)
                    onCalendarDragStart(template.id)
                  }}
                  onDragEnd={onCalendarDragEnd}
                >
                  <CalendarDays size={15} aria-hidden="true" />
                  <div><strong>{template.title}</strong><span>{template.durationDays}일{tag ? ` · ${tag.name}` : ''}{template.dueTime ? ` · ${template.dueTime}` : ''}</span></div>
                </div>
                <button type="button" onClick={() => onInstantiate(template.id, selectedDate)}>선택 날짜에 추가</button>
                <IconButton
                  label={`${template.title} 수정`}
                  onClick={() => onEditRequest(template)}
                ><Settings2 size={13} /></IconButton>
                <IconButton label={`${template.title} 삭제`} onClick={() => onDelete(template.id)}><Trash2 size={13} /></IconButton>
                <ReorderHandle
                  kind="template-order"
                  id={template.id}
                  label={template.title}
                  onMove={(id, direction) => onReorder(movedIds(orderedIds, id, direction))}
                />
              </article>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

interface SharedViewProps {
  tasks: Task[]
  dailyNotes: DailyNote[]
  taskTags: TaskTag[]
  settings: AppSettings
  taskTemplates: TaskTemplate[]
  loading: boolean
  error: string | null
  migrationWarning: LegacyMigrationWarning | null
  onTaskSecondaryAction: (id: string) => void
  onTaskDelete: (id: string) => boolean
  onTaskRestore: (id: string) => void
  onSubTaskToggle: (taskId: string, subTaskId: string) => void
  onDailyNoteCreate: (noteDate: string, content: string) => boolean
  onDailyNoteUpdate: (id: string, content: string) => boolean
  onDailyNoteToggle: (id: string, selectedDate: string) => void
  onDailyNotePinToggle: (id: string, selectedDate: string) => void
  onDailyNoteDelete: (id: string) => void
  onTaskReorder: (orderedIds: string[]) => boolean
  onTaskDateMove: (id: string, targetStart: string) => Task | null
  onDailyNoteReorder: (orderedIds: string[], selectedDate: string) => boolean
  onSettingsChange: (changes: Partial<AppSettings>) => boolean
  onTagCreate: (name: string, color: string) => boolean
  onTagUpdate: (id: string, changes: Partial<Pick<TaskTag, 'name' | 'color'>>) => boolean
  onTagDelete: (id: string) => void
  onTemplateSave: (draft: TemplateDraft, id?: string, openingSnapshot?: TaskTemplate) => boolean
  onTemplateDelete: (id: string) => boolean
  onTemplateInstantiate: (id: string, startDate: string) => boolean
  onTemplateReorder: (orderedIds: string[]) => boolean
  onCreate: (draft: TaskDraft) => boolean
  onUpdate: (id: string, changes: TaskEditChanges) => boolean
}

function MainView(props: SharedViewProps) {
  const {
    tasks,
    dailyNotes,
    taskTags,
    settings,
    taskTemplates,
    loading,
    error,
    migrationWarning,
    onTaskSecondaryAction,
    onTaskDelete,
    onTaskRestore,
    onSubTaskToggle,
    onDailyNoteCreate,
    onDailyNoteUpdate,
    onDailyNoteToggle,
    onDailyNotePinToggle,
    onDailyNoteDelete,
    onTaskReorder,
    onTaskDateMove,
    onDailyNoteReorder,
    onSettingsChange,
    onTagCreate,
    onTagUpdate,
    onTagDelete,
    onTemplateSave,
    onTemplateDelete,
    onTemplateInstantiate,
    onTemplateReorder,
    onCreate,
    onUpdate,
  } = props
  const today = todayKey()
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [calendarViewStart, setCalendarViewStart] = useState(() => calendarDays(startOfMonth(new Date()))[0].key)
  const calendarViewStartRef = useRef(calendarViewStart)
  const [selectedDate, setSelectedDate] = useState(today)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [noteComposerOpen, setNoteComposerOpen] = useState(false)
  const [railPanel, setRailPanel] = useState<RailPanel>(null)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null)
  const [templateCalendarDragging, setTemplateCalendarDragging] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>(UNSUPPORTED_UPDATE_STATE)
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false)
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set())
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => new Set())
  const [selectedRange, setSelectedRange] = useState(() => ({ startDate: today, endDate: today }))
  const [sidebarSplit, setSidebarSplit] = useState(settings.sidebarSplit)
  const [calendarMaxLanes, setCalendarMaxLanes] = useState(3)
  const [calendarWeekMotion, setCalendarWeekMotion] = useState<{
    direction: -1 | 1
    phase: 'exit' | 'enter'
    sequence: number
  } | null>(null)
  const rangeAnchorRef = useRef<string | null>(null)
  const rangeMovedRef = useRef(false)
  const calendarGridRef = useRef<HTMLDivElement | null>(null)
  const calendarWheelDeltaRef = useRef(0)
  const calendarWheelDirectionRef = useRef<-1 | 0 | 1>(0)
  const calendarWheelLastEventAtRef = useRef(0)
  const calendarWeekMotionActiveRef = useRef(false)
  const calendarWeekMotionRef = useRef<{
    direction: -1 | 1
    phase: 'exit' | 'enter'
    sequence: number
  } | null>(null)
  const calendarWeekMotionSequenceRef = useRef(0)
  const calendarWeekMotionTimersRef = useRef<number[]>([])
  const templateDragActivationTimerRef = useRef<number | null>(null)
  const promptedUpdateVersionsRef = useRef(new Set<string>())
  const updateActionInFlightRef = useRef(false)

  const shiftCalendarViewport = useCallback((direction: -1 | 1) => {
    const nextStart = addDaysKey(calendarViewStartRef.current, direction * 7)
    const centerDate = fromDateKey(addDaysKey(nextStart, 20))
    calendarViewStartRef.current = nextStart
    setCalendarViewStart(nextStart)
    setMonth(startOfMonth(centerDate))
  }, [])

  const cancelCalendarWeekMotion = useCallback(() => {
    calendarWeekMotionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    calendarWeekMotionTimersRef.current = []
    calendarWeekMotionSequenceRef.current += 1
    calendarWeekMotionActiveRef.current = false
    calendarWeekMotionRef.current = null
    setCalendarWeekMotion(null)
  }, [])

  const animateCalendarViewport = useCallback((direction: -1 | 1) => {
    const interruptedMotion = calendarWeekMotionRef.current
    calendarWeekMotionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    calendarWeekMotionTimersRef.current = []
    if (interruptedMotion?.phase === 'exit') {
      shiftCalendarViewport(interruptedMotion.direction)
    }
    calendarWeekMotionRef.current = null
    calendarWeekMotionActiveRef.current = false

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shiftCalendarViewport(direction)
      setCalendarWeekMotion(null)
      return true
    }

    const sequence = calendarWeekMotionSequenceRef.current + 1
    calendarWeekMotionSequenceRef.current = sequence
    const exitMotion = { direction, phase: 'exit' as const, sequence }
    calendarWeekMotionActiveRef.current = true
    calendarWeekMotionRef.current = exitMotion
    setCalendarWeekMotion(exitMotion)
    const exitTimer = window.setTimeout(() => {
      const currentMotion = calendarWeekMotionRef.current
      if (!currentMotion || currentMotion.sequence !== sequence || currentMotion.phase !== 'exit') return
      shiftCalendarViewport(direction)
      const enterMotion = { direction, phase: 'enter' as const, sequence }
      calendarWeekMotionRef.current = enterMotion
      setCalendarWeekMotion(enterMotion)
      const enterTimer = window.setTimeout(() => {
        if (calendarWeekMotionRef.current?.sequence !== sequence) return
        calendarWeekMotionTimersRef.current = []
        calendarWeekMotionActiveRef.current = false
        calendarWeekMotionRef.current = null
        setCalendarWeekMotion(null)
      }, 115)
      calendarWeekMotionTimersRef.current = [enterTimer]
    }, 75)
    calendarWeekMotionTimersRef.current = [exitTimer]
    return true
  }, [shiftCalendarViewport])

  const closeRailPanel = useCallback(() => {
    const panel = railPanel
    setRailPanel(null)
    if (!panel) return
    window.setTimeout(() => document.getElementById(`rail-action-${panel}`)?.focus())
  }, [railPanel])
  const closeRecovery = useCallback(() => setRecoveryOpen(false), [])
  const closeTemplateModal = useCallback(() => {
    setTemplateModalOpen(false)
    setEditingTemplate(null)
  }, [])

  useEffect(() => setSidebarSplit(settings.sidebarSplit), [settings.sidebarSplit])

  useEffect(() => {
    if (!templateCalendarDragging) return
    const restoreTemplatePanel = () => {
      if (templateDragActivationTimerRef.current !== null) {
        window.clearTimeout(templateDragActivationTimerRef.current)
        templateDragActivationTimerRef.current = null
      }
      setTemplateCalendarDragging(false)
      setRailPanel('templates')
    }
    window.addEventListener('blur', restoreTemplatePanel)
    return () => window.removeEventListener('blur', restoreTemplatePanel)
  }, [templateCalendarDragging])

  useEffect(() => () => {
    if (templateDragActivationTimerRef.current !== null) {
      window.clearTimeout(templateDragActivationTimerRef.current)
    }
  }, [])

  useEffect(() => () => {
    calendarWeekMotionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    calendarWeekMotionTimersRef.current = []
    calendarWeekMotionActiveRef.current = false
    calendarWeekMotionRef.current = null
  }, [])

  useEffect(() => {
    if (settings.calendarWeekScroll) return

    cancelCalendarWeekMotion()
    const viewportMonth = startOfMonth(fromDateKey(addDaysKey(calendarViewStartRef.current, 20)))
    const alignedStart = calendarDays(viewportMonth)[0].key
    calendarViewStartRef.current = alignedStart
    setCalendarViewStart((current) => current === alignedStart ? current : alignedStart)
    setMonth((current) => current.getFullYear() === viewportMonth.getFullYear()
      && current.getMonth() === viewportMonth.getMonth()
      ? current
      : viewportMonth)
  }, [cancelCalendarWeekMotion, settings.calendarWeekScroll])

  useEffect(() => {
    const updates = getRendererUpdatesApi()
    if (!updates) {
      setUpdateState(UNSUPPORTED_UPDATE_STATE)
      return
    }
    let disposed = false
    let receivedEvent = false
    const acceptUpdateState = (nextState: UpdateState) => {
      if (!disposed) setUpdateState(nextState)
    }
    const unsubscribe = updates.onStateChanged((nextState) => {
      receivedEvent = true
      acceptUpdateState(nextState)
    })
    void updates.getState().then((nextState) => {
      if (!receivedEvent) acceptUpdateState(nextState)
    }).catch((reason: unknown) => {
      if (receivedEvent || disposed) return
      setUpdateState({
        ...UNSUPPORTED_UPDATE_STATE,
        status: 'error',
        error: reason instanceof Error ? reason.message : '업데이트 상태를 불러오지 못했어요.',
        canCheck: true,
      })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (updateState.status !== 'available' && updateState.status !== 'downloaded') return
    if (modalOpen || templateModalOpen || recoveryOpen || helpOpen) return
    const version = updateState.availableVersion
    if (!version || promptedUpdateVersionsRef.current.has(version)) return
    promptedUpdateVersionsRef.current.add(version)
    setUpdatePromptOpen(true)
  }, [
    helpOpen,
    modalOpen,
    recoveryOpen,
    templateModalOpen,
    updateState.availableVersion,
    updateState.status,
  ])

  const runUpdateAction = useCallback(async (action: 'check' | 'download' | 'install') => {
    const updates = getRendererUpdatesApi()
    if (!updates || updateActionInFlightRef.current) return
    updateActionInFlightRef.current = true
    try {
      const nextState = await updates[action]()
      if (nextState) setUpdateState(nextState)
    } catch (reason: unknown) {
      setUpdateState((current) => ({
        ...current,
        status: 'error',
        progress: null,
        error: reason instanceof Error ? reason.message : '업데이트 서버에 연결하지 못했어요.',
        canCheck: true,
      }))
    } finally {
      updateActionInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (loading) return
    const grid = calendarGridRef.current
    if (!grid) return
    const updateLaneCapacity = () => {
      const rowHeight = (grid.getBoundingClientRect().height - 5) / 6
      const capacity = clamp(Math.floor((rowHeight - 30) / 23), 1, 3)
      setCalendarMaxLanes((current) => current === capacity ? current : capacity)
    }
    const observer = new ResizeObserver(updateLaneCapacity)
    observer.observe(grid)
    updateLaneCapacity()
    return () => observer.disconnect()
  }, [loading])

  useEffect(() => {
    const grid = calendarGridRef.current
    const resetWheelGesture = () => {
      calendarWheelDeltaRef.current = 0
      calendarWheelDirectionRef.current = 0
      calendarWheelLastEventAtRef.current = 0
    }
    if (!grid || !settings.calendarWeekScroll) {
      resetWheelGesture()
      return
    }

    const handleCalendarWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || templateCalendarDragging
        || rangeAnchorRef.current !== null
        || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('input, select, textarea, a, [contenteditable="true"]')) return

      for (let node: HTMLElement | null = target; node && node !== grid; node = node.parentElement) {
        const overflowY = window.getComputedStyle(node).overflowY
        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return
      }

      const now = performance.now()
      if (now - calendarWheelLastEventAtRef.current > 180) resetWheelGesture()
      calendarWheelLastEventAtRef.current = now

      const pageHeight = Math.max(1, grid.clientHeight)
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * pageHeight
          : event.deltaY
      if (!Number.isFinite(delta) || delta === 0) return
      const direction: -1 | 1 = delta > 0 ? 1 : -1
      if (calendarWheelDirectionRef.current !== 0 && calendarWheelDirectionRef.current !== direction) {
        calendarWheelDeltaRef.current = 0
      }
      calendarWheelDirectionRef.current = direction
      calendarWheelDeltaRef.current += delta
      if (Math.abs(calendarWheelDeltaRef.current) < 48) return

      if (!animateCalendarViewport(direction)) return
      event.preventDefault()
      resetWheelGesture()
    }

    grid.addEventListener('wheel', handleCalendarWheel, { passive: false })
    return () => {
      grid.removeEventListener('wheel', handleCalendarWheel)
      resetWheelGesture()
    }
  }, [animateCalendarViewport, loading, settings.calendarWeekScroll, templateCalendarDragging])

  useEffect(() => {
    if (!railPanel || modalOpen || templateModalOpen || updatePromptOpen) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeRailPanel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeRailPanel, modalOpen, railPanel, templateModalOpen, updatePromptOpen])

  useEffect(() => {
    const validIds = new Set(taskTags.map((tag) => tag.id))
    setSelectedTagIds((current) => {
      const next = new Set([...current].filter((id) => id === UNTAGGED_FILTER || validIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [taskTags])

  useEffect(() => {
    const collapsibleIds = new Set(tasks.filter((task) => task.subTasks.length > 0).map((task) => task.id))
    setCollapsedTaskIds((current) => {
      const next = new Set([...current].filter((id) => collapsibleIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [tasks])

  useEffect(() => {
    let resetMovedTimer: number | null = null
    const finishRange = () => {
      rangeAnchorRef.current = null
      if (!rangeMovedRef.current) return
      if (resetMovedTimer !== null) window.clearTimeout(resetMovedTimer)
      // A compatibility click may follow pointerup in the same event turn. Keep
      // the guard through that click, then guarantee it cannot eat a later click.
      resetMovedTimer = window.setTimeout(() => {
        rangeMovedRef.current = false
        resetMovedTimer = null
      }, 0)
    }
    window.addEventListener('pointerup', finishRange)
    window.addEventListener('pointercancel', finishRange)
    window.addEventListener('blur', finishRange)
    return () => {
      if (resetMovedTimer !== null) window.clearTimeout(resetMovedTimer)
      window.removeEventListener('pointerup', finishRange)
      window.removeEventListener('pointercancel', finishRange)
      window.removeEventListener('blur', finishRange)
    }
  }, [])

  const active = useMemo(() => visibleTasks(tasks), [tasks])
  const deleted = useMemo(() => deletedTasks(tasks), [tasks])
  const normalizedSearch = search.trim().toLocaleLowerCase('ko-KR')
  const filtered = useMemo(() => active.filter((task) => {
    const searchMatches = !normalizedSearch
      || `${task.title} ${task.note}`.toLocaleLowerCase('ko-KR').includes(normalizedSearch)
    const tagMatches = selectedTagIds.size === 0
      || (task.tagId ? selectedTagIds.has(task.tagId) : selectedTagIds.has(UNTAGGED_FILTER))
    return searchMatches && tagMatches
  }), [active, normalizedSearch, selectedTagIds])
  const days = useMemo(
    () => calendarDaysFromStart(fromDateKey(calendarViewStart), month),
    [calendarViewStart, month],
  )
  const calendarTasks = useMemo(() => {
    const firstDay = days[0]?.key
    const lastDay = days.at(-1)?.key
    if (!firstDay || !lastDay) return []
    return sortTasks(filtered.filter((task) => taskOverlapsRange(task, firstDay, lastDay)))
  }, [days, filtered])
  const calendarTaskLayout = useMemo(
    () => layoutCalendarTaskSegments(
      calendarTasks,
      days[0]?.key ?? today,
      days.length,
      calendarMaxLanes,
    ),
    [calendarMaxLanes, calendarTasks, days, today],
  )
  const calendarTaskById = useMemo(
    () => new Map(calendarTasks.map((task) => [task.id, task])),
    [calendarTasks],
  )
  const selectedTasks = useMemo(
    () => sortTasks(filtered.filter((task) => taskOccursOnDate(task, selectedDate))),
    [filtered, selectedDate],
  )
  const {
    visibleNotes: selectedDailyNotes,
    toggleNote: toggleVisibleDailyNote,
    togglePin: toggleVisibleDailyNotePin,
  } = useVisibleDailyNotes(dailyNotes, selectedDate, onDailyNoteToggle, onDailyNotePinToggle)
  const monthTasks = useMemo(
    () => filtered.filter((task) => taskOverlapsRange(
      task,
      `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`,
      `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()).padStart(2, '0')}`,
    )),
    [filtered, month],
  )
  const monthCompleted = monthTasks.filter((task) => task.completed).length

  const openCreate = (date?: string) => {
    if (date && !dateRangeContains(selectedRange.startDate, selectedRange.endDate, date)) {
      setSelectedRange({ startDate: date, endDate: date })
      setSelectedDate(date)
    }
    setEditingTask(null)
    setModalOpen(true)
  }

  const openTask = (task: Task) => {
    setSelectedDate(task.startDate)
    setSelectedRange({ startDate: task.startDate, endDate: task.dueDate })
    setEditingTask(task)
    setModalOpen(true)
  }

  const chooseDate = (key: string) => {
    if (calendarWeekMotionActiveRef.current) cancelCalendarWeekMotion()
    setSelectedDate(key)
    setSelectedRange({ startDate: key, endDate: key })
    const date = fromDateKey(key)
    if (date.getMonth() !== month.getMonth() || date.getFullYear() !== month.getFullYear()) {
      const nextMonth = startOfMonth(date)
      setMonth(nextMonth)
      const nextStart = calendarDays(nextMonth)[0].key
      calendarViewStartRef.current = nextStart
      setCalendarViewStart(nextStart)
    }
  }

  const goToday = () => {
    cancelCalendarWeekMotion()
    setSelectedDate(today)
    setSelectedRange({ startDate: today, endDate: today })
    const nextMonth = startOfMonth(new Date())
    setMonth(nextMonth)
    const nextStart = calendarDays(nextMonth)[0].key
    calendarViewStartRef.current = nextStart
    setCalendarViewStart(nextStart)
  }

  const jumpToMonth = (year: number, monthIndex: number) => {
    cancelCalendarWeekMotion()
    const nextMonth = new Date(year, monthIndex, 1)
    setMonth(nextMonth)
    const nextStart = calendarDays(nextMonth)[0].key
    calendarViewStartRef.current = nextStart
    setCalendarViewStart(nextStart)
    const selected = fromDateKey(selectedDate)
    const day = Math.min(selected.getDate(), new Date(year, monthIndex + 1, 0).getDate())
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    setSelectedDate(key)
    setSelectedRange({ startDate: key, endDate: key })
  }

  const navigateMonth = (offset: number) => {
    const target = shiftMonth(month, offset)
    jumpToMonth(target.getFullYear(), target.getMonth())
  }

  const handleCellKey = (event: KeyboardEvent<HTMLDivElement>, key: string) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      chooseDate(key)
    }
  }

  const beginRange = (event: ReactPointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    rangeAnchorRef.current = key
    rangeMovedRef.current = false
    setSelectedDate(key)
    setSelectedRange({ startDate: key, endDate: key })
  }

  const extendRange = (event: ReactPointerEvent<HTMLDivElement>, key: string) => {
    const anchor = rangeAnchorRef.current
    if (!anchor) return
    if ((event.buttons & 1) === 0) {
      rangeAnchorRef.current = null
      return
    }
    const next = normalizedRange(anchor, key)
    rangeMovedRef.current = rangeMovedRef.current || key !== anchor
    setSelectedDate(next.startDate)
    setSelectedRange(next)
  }

  const extendRangeFromGrid = (event: ReactPointerEvent<HTMLDivElement>) => {
    const anchor = rangeAnchorRef.current
    if (!anchor) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const column = clamp(Math.floor(((event.clientX - bounds.left) / bounds.width) * 7), 0, 6)
    const row = clamp(Math.floor(((event.clientY - bounds.top) / bounds.height) * 6), 0, 5)
    const day = days[row * 7 + column]
    if (!day) return
    const next = normalizedRange(anchor, day.key)
    rangeMovedRef.current = rangeMovedRef.current || day.key !== anchor
    setSelectedDate(next.startDate)
    setSelectedRange(next)
  }

  const reorderTasksByDrop = (draggedId: string, targetId: string) => {
    onTaskReorder(droppedIds(selectedTasks.map((task) => task.id), draggedId, targetId))
  }
  const moveTask = (id: string, direction: ReorderDirection) => {
    onTaskReorder(movedIds(selectedTasks.map((task) => task.id), id, direction))
  }
  const toggleTaskSubTasksVisibility = (id: string) => {
    setCollapsedTaskIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const reorderCalendarTasksByDrop = (draggedId: string, targetId: string) => {
    onTaskReorder(droppedIds(calendarTasks.map((task) => task.id), draggedId, targetId))
  }
  const moveCalendarTask = (id: string, direction: ReorderDirection) => {
    onTaskReorder(movedIds(calendarTasks.map((task) => task.id), id, direction))
  }
  const calendarDateAtPoint = (clientX: number, clientY: number) => {
    const grid = calendarGridRef.current
    if (!grid) return null
    const bounds = grid.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return null
    if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null
    const column = clamp(Math.floor(((clientX - bounds.left) / bounds.width) * 7), 0, 6)
    const row = clamp(Math.floor(((clientY - bounds.top) / bounds.height) * 6), 0, 5)
    return days[row * 7 + column]?.key ?? null
  }
  const instantiateTemplateAtDate = (templateId: string, date: string) => {
    const saved = onTemplateInstantiate(templateId, date)
    setTemplateCalendarDragging(false)
    setRailPanel('templates')
    if (!saved) return false
    setSelectedDate(date)
    setSelectedRange({ startDate: date, endDate: date })
    return true
  }
  const dropTemplateAtCalendarPoint = (
    templateId: string,
    clientX: number,
    clientY: number,
  ) => {
    const date = calendarDateAtPoint(clientX, clientY)
    if (date) instantiateTemplateAtDate(templateId, date)
    else {
      setTemplateCalendarDragging(false)
      setRailPanel('templates')
    }
  }
  const beginTaskDateDrag = (
    taskId: string,
    fallbackDate: string,
    clientX: number,
    clientY: number,
    transfer: DataTransfer,
  ) => {
    const task = calendarTaskById.get(taskId)
    if (!task) return
    const grabDate = calendarDateAtPoint(clientX, clientY) ?? fallbackDate
    transfer.setData(TASK_DATE_MOVE_MIME, JSON.stringify({ taskId, grabDate }))
  }
  const dropTaskDateAtCalendarPoint = (
    payload: TaskDateDragPayload,
    clientX: number,
    clientY: number,
  ) => {
    const targetDate = calendarDateAtPoint(clientX, clientY)
    const task = tasks.find((item) => item.id === payload.taskId && !item.deletedAt)
    const grabIndex = days.findIndex((day) => day.key === payload.grabDate)
    const targetIndex = days.findIndex((day) => day.key === targetDate)
    if (!targetDate || !task || grabIndex < 0 || targetIndex < 0) return
    const dayOffset = targetIndex - grabIndex
    const targetStart = addDaysKey(task.startDate, dayOffset)
    const moved = onTaskDateMove(task.id, targetStart)
    if (!moved) return
    setSelectedDate(targetDate)
    setSelectedRange({ startDate: moved.startDate, endDate: moved.dueDate })
  }
  const reorderNotesByDrop = (draggedId: string, targetId: string) => {
    onDailyNoteReorder(
      droppedIds(selectedDailyNotes.map((note) => note.id), draggedId, targetId),
      selectedDate,
    )
  }
  const moveNote = (id: string, direction: ReorderDirection) => {
    onDailyNoteReorder(movedIds(selectedDailyNotes.map((note) => note.id), id, direction), selectedDate)
  }

  const toggleRailPanel = (panel: Exclude<RailPanel, null>) => {
    setRecoveryOpen(false)
    setRailPanel((current) => current === panel ? null : panel)
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
    <>
    <div className="main-shell" data-rail-collapsed={railCollapsed || undefined}>
      <aside
        id="side-rail-navigation"
        className="side-rail"
        data-qa="side-rail"
        data-state={railCollapsed ? 'closed' : 'open'}
        hidden={railCollapsed}
      >
        <button
          type="button"
          id="rail-brand-toggle"
          className="rail-brand-toggle"
          data-qa="rail-brand-toggle"
          aria-controls="side-rail-navigation"
          aria-expanded={true}
          aria-label="좌측 메뉴 접기"
          title="좌측 메뉴 접기"
          onClick={() => {
            setRailPanel(null)
            setRecoveryOpen(false)
            setRailCollapsed(true)
            window.setTimeout(() => document.getElementById('rail-open-button')?.focus())
          }}
        >
          <BrandMark />
        </button>
        <nav aria-label="주요 메뉴">
          <IconButton
            id="rail-action-templates"
            label="반복 일정"
            controls="rail-panel-templates"
            expanded={railPanel === 'templates' && !templateCalendarDragging}
            railAction="templates"
            dataHelpId="templates"
            active={railPanel === 'templates' && !templateCalendarDragging}
            onClick={() => toggleRailPanel('templates')}
          >
            <Repeat2 size={19} />
          </IconButton>
          <IconButton
            id="rail-action-filters"
            label={`태그 필터${selectedTagIds.size ? ` ${selectedTagIds.size}개 적용 중` : ''}`}
            controls="rail-panel-filters"
            expanded={railPanel === 'filters'}
            railAction="filters"
            dataHelpId="filters"
            active={railPanel === 'filters' || selectedTagIds.size > 0}
            onClick={() => toggleRailPanel('filters')}
          >
            <Filter size={19} />
            {selectedTagIds.size > 0 && <span className="nav-badge filter-badge">{selectedTagIds.size}</span>}
          </IconButton>
          <IconButton
            id="rail-action-tags"
            label="태그 설정"
            controls="rail-panel-tags"
            expanded={railPanel === 'tags'}
            railAction="tags"
            dataHelpId="tags"
            active={railPanel === 'tags'}
            onClick={() => toggleRailPanel('tags')}
          >
            <Tags size={19} />
          </IconButton>
          <IconButton
            id="rail-action-appearance"
            label="일반 설정"
            controls="rail-panel-appearance"
            expanded={railPanel === 'appearance'}
            railAction="appearance"
            dataHelpId="appearance"
            active={railPanel === 'appearance'}
            onClick={() => toggleRailPanel('appearance')}
          >
            <Settings2 size={19} />
          </IconButton>
        </nav>
        <div className="rail-bottom" role="navigation" aria-label="앱 및 보관 메뉴">
          <IconButton
            id="rail-action-updates"
            label={updateState.status === 'available' || updateState.status === 'downloaded'
              ? `${versionLabel(updateState.availableVersion)} 업데이트 사용 가능`
              : '업데이트 확인 및 업데이트'}
            controls="rail-panel-updates"
            expanded={railPanel === 'updates'}
            railAction="updates"
            dataQa="update-menu-button"
            active={railPanel === 'updates' || updateState.status === 'available' || updateState.status === 'downloaded'}
            onClick={() => toggleRailPanel('updates')}
          >
            <MonitorUp size={20} />
            {(updateState.status === 'available' || updateState.status === 'downloaded') && (
              <span className="nav-badge update-nav-badge" aria-hidden="true">!</span>
            )}
          </IconButton>
          <IconButton
            id="rail-action-recovery"
            label="최근 삭제"
            controls="recovery-panel"
            expanded={recoveryOpen}
            railAction="recovery"
            dataHelpId="recovery"
            active={recoveryOpen}
            onClick={() => {
              setRailPanel(null)
              setRecoveryOpen(true)
            }}
          >
            <History size={20} />
          </IconButton>
          <IconButton
            id="rail-action-help"
            label="도움말 보기"
            controls="main-help-tour"
            expanded={helpOpen}
            railAction="help"
            active={helpOpen}
            dataHelpId="help-menu"
            onClick={() => {
              setRailPanel(null)
              setRecoveryOpen(false)
              setHelpOpen(true)
            }}
          >
            <CircleHelp size={20} />
          </IconButton>
        </div>
      </aside>

      {railPanel === 'updates' && (
        <UpdatePanel
          state={updateState}
          onCheck={() => void runUpdateAction('check')}
          onDownload={() => void runUpdateAction('download')}
          onInstall={() => void runUpdateAction('install')}
          onClose={closeRailPanel}
        />
      )}

      {railPanel === 'filters' && (
        <FilterPanel
          tags={taskTags}
          selected={selectedTagIds}
          onToggle={(id) => setSelectedTagIds((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })}
          onClear={() => setSelectedTagIds(new Set())}
          onClose={closeRailPanel}
        />
      )}
      {railPanel === 'templates' && (
        <TemplatePanel
          templates={taskTemplates}
          tags={taskTags}
          selectedDate={selectedDate}
          onDelete={onTemplateDelete}
          onInstantiate={onTemplateInstantiate}
          onReorder={onTemplateReorder}
          calendarDragging={templateCalendarDragging}
          onCreateRequest={() => {
            setEditingTemplate(null)
            setTemplateModalOpen(true)
          }}
          onEditRequest={(template) => {
            setEditingTemplate(template)
            setTemplateModalOpen(true)
          }}
          onCalendarDragStart={() => {
            if (templateDragActivationTimerRef.current !== null) {
              window.clearTimeout(templateDragActivationTimerRef.current)
            }
            // Chromium must finish establishing the native drag session before
            // its source panel becomes transparent and click-through.
            templateDragActivationTimerRef.current = window.setTimeout(() => {
              templateDragActivationTimerRef.current = null
              setTemplateCalendarDragging(true)
            }, 0)
          }}
          onCalendarDragEnd={() => {
            if (templateDragActivationTimerRef.current !== null) {
              window.clearTimeout(templateDragActivationTimerRef.current)
              templateDragActivationTimerRef.current = null
            }
            setTemplateCalendarDragging(false)
            setRailPanel('templates')
          }}
          onClose={closeRailPanel}
        />
      )}
      {railPanel === 'tags' && (
        <TagSettingsPanel
          tags={taskTags}
          onTagCreate={onTagCreate}
          onTagUpdate={onTagUpdate}
          onTagDelete={onTagDelete}
          onClose={closeRailPanel}
        />
      )}
      {railPanel === 'appearance' && (
        <GeneralSettingsPanel
          settings={settings}
          onSettingsChange={onSettingsChange}
          onClose={closeRailPanel}
        />
      )}

      <main className="calendar-workspace">
        <header className="app-header">
          <div className="header-leading">
            {railCollapsed && (
              <IconButton
                id="rail-open-button"
                label="좌측 메뉴 열기"
                className="header-rail-open"
                controls="side-rail-navigation"
                expanded={false}
                dataQa="rail-open-button"
                onClick={() => {
                  setRailCollapsed(false)
                  window.setTimeout(() => document.getElementById('rail-brand-toggle')?.focus())
                }}
              >
                <PanelLeftOpen size={18} />
              </IconButton>
            )}
            <div className="header-title">
              <span className="eyebrow">CALENDAR</span>
              <div>
                <h1>{formatMonthTitle(month)}</h1>
                <span className="month-summary">{monthTasks.length}개의 일정 · {monthCompleted}개 비활성</span>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <div className={`search-control ${searchOpen ? 'is-open' : ''}`} data-help-id="search">
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
              data-help-id="widget-launch"
              onClick={() => void window.dayline?.openWidget()}
              disabled={!window.dayline}
              title={window.dayline ? '별도 위젯 창 열기' : '설치된 데스크톱 앱에서 사용할 수 있어요'}
            >
              <MonitorUp size={17} /> 위젯 띄우기
            </button>
            <button
              type="button"
              className="primary-button header-add"
              data-help-id="create-task"
              onClick={() => openCreate()}
              aria-label={`${formatCompactDate(selectedRange.startDate)}부터 ${formatCompactDate(selectedRange.endDate)}까지 새 일정`}
            >
              <Plus size={17} /> 새 일정
            </button>
          </div>
        </header>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {migrationWarning && (
          <div className="migration-warning" role="alert">
            <strong>기존 일정 파일을 불러오지 못했어요.</strong>
            <span>원본은 보존했으며 다음 실행 때 다시 가져옵니다.</span>
            {migrationWarning.backupPath && <code>백업: {migrationWarning.backupPath}</code>}
          </div>
        )}

        <section className="calendar-card" data-help-id="calendar" aria-label={`${formatMonthTitle(month)} 일정 캘린더`}>
          <div className="calendar-toolbar">
            <div className="month-navigation" data-help-id="month-navigation">
              <IconButton label="이전 달" onClick={() => navigateMonth(-1)}>
                <ChevronLeft size={18} />
              </IconButton>
              <button type="button" className="today-button" onClick={goToday}>오늘</button>
              <IconButton label="다음 달" onClick={() => navigateMonth(1)}>
                <ChevronRight size={18} />
              </IconButton>
              <div className="month-jump" role="group" aria-label="연월 바로 선택">
                <CalendarDays size={14} aria-hidden="true" />
                <select
                  value={month.getFullYear()}
                  onChange={(event) => jumpToMonth(Number(event.target.value), month.getMonth())}
                  aria-label="연도 선택"
                >
                  {Array.from({ length: 201 }, (_, index) => 1900 + index).map((year) => (
                    <option value={year} key={year}>{year}년</option>
                  ))}
                </select>
                <select
                  value={month.getMonth()}
                  onChange={(event) => jumpToMonth(month.getFullYear(), Number(event.target.value))}
                  aria-label="월 선택"
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <option value={index} key={index}>{index + 1}월</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="calendar-hint">
              <span className="range-selection-summary" data-qa="range-selection-summary"><CalendarRange size={13} /> {selectedRange.startDate === selectedRange.endDate ? formatCompactDate(selectedRange.startDate) : `${formatCompactDate(selectedRange.startDate)}–${formatCompactDate(selectedRange.endDate)}`}</span>
            </div>
          </div>

          <div className="weekday-row" aria-hidden="true">
            {WEEKDAYS.map((day, index) => <span key={day} className={index === 0 ? 'is-sunday' : index === 6 ? 'is-saturday' : ''}>{day}</span>)}
          </div>
          <div
            ref={calendarGridRef}
            className={`calendar-grid${calendarWeekMotion
              ? ` is-week-motion-${calendarWeekMotion.phase} is-week-motion-${calendarWeekMotion.direction > 0 ? 'down' : 'up'} is-week-motion-cycle-${calendarWeekMotion.sequence % 2 === 1 ? 'a' : 'b'}`
              : ''}`}
            data-view-start={calendarViewStart}
            data-week-scroll-enabled={settings.calendarWeekScroll}
            data-week-motion-phase={calendarWeekMotion?.phase}
            data-week-motion-direction={calendarWeekMotion ? (calendarWeekMotion.direction > 0 ? 'down' : 'up') : undefined}
            data-week-motion-sequence={calendarWeekMotion?.sequence}
            aria-busy={calendarWeekMotion ? true : undefined}
            data-range-start={selectedRange.startDate}
            data-range-end={selectedRange.endDate}
            data-max-lanes={calendarMaxLanes}
            onPointerMove={extendRangeFromGrid}
          >
            {days.map((day) => {
              const taskCount = calendarTaskLayout.dayCounts[day.key] ?? { total: 0, visible: 0, hidden: 0 }
              const selected = selectedDate === day.key
              const inRange = dateRangeContains(selectedRange.startDate, selectedRange.endDate, day.key)
              const weekday = day.date.getDay()
              const holiday = getKoreanHoliday(day.key)
              const dayTone = getCalendarDayTone(day.key)
              return (
                <div
                  key={day.key}
                  data-date={day.key}
                  data-day-tone={dayTone}
                  data-holiday-name={holiday?.name}
                  data-task-count={taskCount.total}
                  data-hidden-count={taskCount.hidden}
                  data-template-drop-target
                  data-calendar-drop-target
                  data-range-selected={inRange || undefined}
                  className={`calendar-cell ${weekday === 0 ? 'is-sunday' : ''} ${weekday === 6 ? 'is-saturday' : ''} ${holiday ? 'is-holiday' : ''} ${!day.inCurrentMonth ? 'is-outside' : ''} ${day.key === today ? 'is-today' : ''} ${selected ? 'is-selected' : ''} ${inRange ? 'is-in-range' : ''} ${day.key === selectedRange.startDate ? 'is-range-start' : ''} ${day.key === selectedRange.endDate ? 'is-range-end' : ''}`}
                  role="button"
                  tabIndex={day.inCurrentMonth ? 0 : -1}
                  aria-pressed={inRange}
                  aria-label={`${formatFullDate(day.key)}${holiday ? `, ${holiday.name}` : ''}, 일정 ${taskCount.total}개`}
                  title={holiday?.name}
                  onPointerDown={(event) => beginRange(event, day.key)}
                  onPointerEnter={(event) => extendRange(event, day.key)}
                  onClick={() => {
                    if (rangeMovedRef.current) {
                      rangeMovedRef.current = false
                      return
                    }
                    chooseDate(day.key)
                  }}
                  onDoubleClick={() => openCreate(day.key)}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(TEMPLATE_COPY_MIME)
                      && !event.dataTransfer.types.includes(TASK_DATE_MOVE_MIME)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(TASK_DATE_MOVE_MIME) ? 'move' : 'copy'
                  }}
                  onDrop={(event) => {
                    const taskDateMove = parseTaskDateDragPayload(event.dataTransfer.getData(TASK_DATE_MOVE_MIME))
                    if (taskDateMove) {
                      event.preventDefault()
                      event.stopPropagation()
                      dropTaskDateAtCalendarPoint(taskDateMove, event.clientX, event.clientY)
                      return
                    }
                    const templateId = event.dataTransfer.getData(TEMPLATE_COPY_MIME)
                    if (!templateId) return
                    event.preventDefault()
                    event.stopPropagation()
                    instantiateTemplateAtDate(templateId, day.key)
                  }}
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
                  {taskCount.hidden > 0 && (
                    <span
                      className="calendar-task-overflow"
                      data-date={day.key}
                      data-hidden-count={taskCount.hidden}
                      aria-label={`숨겨진 일정 ${taskCount.hidden}개`}
                      title={`이 날짜에 일정 ${taskCount.hidden}개가 더 있어요`}
                    >
                      +{taskCount.hidden}
                    </span>
                  )}
                </div>
              )
            })}
            <div className="calendar-task-layout" data-help-id="calendar-order" data-qa="calendar-task-layout" role="group" aria-label="캘린더 일정 순서">
              {calendarTaskLayout.segments.map((segment) => {
                const task = calendarTaskById.get(segment.taskId)
                if (!task) return null
                return (
                  <TaskChip
                    key={`${segment.taskId}:${segment.weekRow}`}
                    task={task}
                    tags={taskTags}
                    segment={segment}
                    onOpen={openTask}
                    onSecondaryAction={onTaskSecondaryAction}
                    onMove={moveCalendarTask}
                    onDropTask={reorderCalendarTasksByDrop}
                    onDropTemplate={dropTemplateAtCalendarPoint}
                    onBeginDateDrag={beginTaskDateDrag}
                    onEndDateDrag={() => undefined}
                    onDropDateMove={dropTaskDateAtCalendarPoint}
                  />
                )
              })}
            </div>
          </div>
        </section>
      </main>

      <aside className="day-panel">
        <header className="day-panel-header">
          <div>
            <span className="eyebrow">SELECTED DAY</span>
            <h2>{formatFullDate(selectedDate)}</h2>
          </div>
        </header>

        <div
          className="day-panel-body"
          data-split-container
          style={{ gridTemplateRows: `minmax(0, ${sidebarSplit}fr) 9px minmax(0, ${100 - sidebarSplit}fr)` }}
        >
          <DailyNotesSection
            helpId="quick-notes"
            selectedDate={selectedDate}
            notes={selectedDailyNotes}
            composerOpen={noteComposerOpen}
            createRequest={0}
            onComposerOpenChange={setNoteComposerOpen}
            onCreate={onDailyNoteCreate}
            onUpdate={onDailyNoteUpdate}
            onToggle={toggleVisibleDailyNote}
            onPinToggle={toggleVisibleDailyNotePin}
            onDelete={onDailyNoteDelete}
            onMove={moveNote}
            onDropNote={reorderNotesByDrop}
            showHeaderAdd
          />

          <SplitHandle
            qa="sidebar-splitter"
            value={sidebarSplit}
            onPreview={setSidebarSplit}
            onCommit={(value) => {
              if (!onSettingsChange({ sidebarSplit: value })) setSidebarSplit(settings.sidebarSplit)
            }}
          />

          <section className="schedule-section" data-help-id="schedule-list" data-qa="schedule-section" aria-labelledby="schedule-section-title">
            <div className="panel-section-heading schedule-heading">
              <div>
                <span className="eyebrow">SCHEDULE</span>
                <div className="section-heading-title">
                  <strong id="schedule-section-title">일정</strong>
                  <span className="section-count" data-qa="schedule-count" aria-label={`일정 ${selectedTasks.length}개`}>{selectedTasks.length}</span>
                </div>
              </div>
              <IconButton
                label={`${formatCompactDate(selectedDate)}에 일정 추가`}
                className="section-add-button"
                dataQa="schedule-add"
                onClick={() => {
                  setSelectedRange({ startDate: selectedDate, endDate: selectedDate })
                  setEditingTask(null)
                  setModalOpen(true)
                }}
              >
                <Plus size={14} />
              </IconButton>
            </div>
            <div className="day-task-list">
              {selectedTasks.length === 0 ? (
                <EmptyState />
              ) : (
                selectedTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    tags={taskTags}
                    onOpen={openTask}
                    onSecondaryAction={onTaskSecondaryAction}
                    onSubTaskToggle={onSubTaskToggle}
                    onMove={moveTask}
                    onDropTask={reorderTasksByDrop}
                    showSubTasks
                    subTasksExpanded={!collapsedTaskIds.has(task.id)}
                    onToggleSubTasksVisibility={() => toggleTaskSubTasksVisibility(task.id)}
                    reorderable
                  />
                ))
              )}
            </div>
          </section>
        </div>
      </aside>

      <TaskModal
        open={modalOpen}
        initialStartDate={selectedRange.startDate}
        initialEndDate={selectedRange.endDate}
        task={editingTask}
        tags={taskTags}
        onClose={() => {
          setModalOpen(false)
          setEditingTask(null)
        }}
        onSave={(draft, id, changes) => {
          const saved = id
            ? onUpdate(id, changes ?? { draft: {} })
            : onCreate(draft)
          if (!saved) return false
          setSelectedDate(draft.startDate)
          setSelectedRange({ startDate: draft.startDate, endDate: draft.dueDate })
          const nextMonth = startOfMonth(fromDateKey(draft.startDate))
          setMonth(nextMonth)
          const nextStart = calendarDays(nextMonth)[0].key
          calendarViewStartRef.current = nextStart
          setCalendarViewStart(nextStart)
          setModalOpen(false)
          setEditingTask(null)
          return true
        }}
        onDelete={onTaskDelete}
      />
      <TemplateModal
        open={templateModalOpen}
        template={editingTemplate}
        tags={taskTags}
        onClose={closeTemplateModal}
        onSave={onTemplateSave}
      />
      <RecoveryPanel open={recoveryOpen} tasks={deleted} onClose={closeRecovery} onRestore={onTaskRestore} />
    </div>
    <UpdateAvailableDialog
      open={updatePromptOpen}
      state={updateState}
      onLater={() => setUpdatePromptOpen(false)}
      onDownload={() => void runUpdateAction('download')}
      onInstall={() => void runUpdateAction('install')}
    />
    <HelpTour id="main-help-tour" open={helpOpen} steps={MAIN_HELP_STEPS} onClose={() => setHelpOpen(false)} />
    </>
  )
}

function WidgetView(props: SharedViewProps) {
  const {
    tasks,
    dailyNotes,
    taskTags,
    settings,
    loading,
    error,
    migrationWarning,
    onTaskSecondaryAction,
    onTaskDelete,
    onSubTaskToggle,
    onDailyNoteCreate,
    onDailyNoteUpdate,
    onDailyNoteToggle,
    onDailyNotePinToggle,
    onDailyNoteDelete,
    onSettingsChange,
    onCreate,
    onUpdate,
  } = props
  const today = todayKey()
  const [selectedDate, setSelectedDate] = useState(today)
  const [quickTitle, setQuickTitle] = useState('')
  const [widgetState, setWidgetState] = useState<WidgetState>({ pinned: true, locked: false })
  const [widgetSplit, setWidgetSplit] = useState(settings.widgetSplit)
  const [noteComposerOpen, setNoteComposerOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const active = useMemo(() => visibleTasks(tasks), [tasks])
  const selectedTasks = useMemo(
    () => sortTasks(active.filter((task) => taskOccursOnDate(task, selectedDate))),
    [active, selectedDate],
  )
  const {
    visibleNotes: selectedDailyNotes,
    toggleNote: toggleVisibleDailyNote,
    togglePin: toggleVisibleDailyNotePin,
  } = useVisibleDailyNotes(dailyNotes, selectedDate, onDailyNoteToggle, onDailyNotePinToggle)
  const completedCount = selectedTasks.filter((task) => task.completed).length
  const week = useMemo(() => weekDaysAround(selectedDate), [selectedDate])

  useEffect(() => {
    void window.dayline?.getWidgetState().then(setWidgetState)
  }, [])

  useEffect(() => setWidgetSplit(settings.widgetSplit), [settings.widgetSplit])

  const addQuickTask = (event: FormEvent) => {
    event.preventDefault()
    if (!quickTitle.trim()) return
    const defaultTag = sortedPositioned(taskTags)[0]
    const saved = onCreate({
      title: quickTitle.trim(),
      note: '',
      startDate: selectedDate,
      dueDate: selectedDate,
      dueTime: null,
      color: defaultTag?.legacyColor ?? 'coral',
      tagId: defaultTag?.id ?? null,
      subTasks: [],
    })
    if (saved) setQuickTitle('')
  }

  const openTask = (task: Task) => {
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
        <div className="widget-controls" data-help-id="widget-controls">
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
          <IconButton label="위젯 도움말 보기" active={helpOpen} onClick={() => setHelpOpen(true)}>
            <CircleHelp size={14} />
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

        <div className="widget-week" data-help-id="widget-week" role="group" aria-label="이번 주 날짜 선택">
          {week.map((day) => {
            const weekday = fromDateKey(day.key).getDay()
            const holiday = getKoreanHoliday(day.key)
            const dayTone = getCalendarDayTone(day.key)
            return (
              <button
                type="button"
                key={day.key}
                data-date={day.key}
                data-day-tone={dayTone}
                data-holiday-name={holiday?.name}
                className={`${weekday === 0 ? 'is-sunday' : ''} ${weekday === 6 ? 'is-saturday' : ''} ${holiday ? 'is-holiday' : ''} ${selectedDate === day.key ? 'is-selected' : ''} ${today === day.key ? 'is-today' : ''}`}
                onClick={() => setSelectedDate(day.key)}
                aria-label={`${formatFullDate(day.key)}${holiday ? `, ${holiday.name}` : ''}`}
                title={holiday?.name}
              >
                <span>{day.weekday}</span>
                <strong>{day.day}</strong>
                <i>{active.some((task) => taskOccursOnDate(task, day.key) && !task.completed) ? '•' : ''}</i>
              </button>
            )
          })}
        </div>

        {error && <div className="widget-error">{error}</div>}
        {migrationWarning && (
          <div className="widget-error" title={migrationWarning.backupPath ?? undefined}>
            기존 일정 파일을 읽지 못했어요. 원본을 보존했고 다음 실행 때 다시 시도합니다.
          </div>
        )}

        <div
          className="widget-split-body"
          data-split-container
          style={{ gridTemplateRows: `minmax(0, ${widgetSplit}fr) 9px minmax(0, ${100 - widgetSplit}fr)` }}
        >
          <section className="widget-schedule-pane" data-help-id="widget-schedule" data-qa="widget-schedule" aria-labelledby="widget-schedule-title">
            <div className="panel-section-heading widget-pane-heading">
              <div><span className="eyebrow">SCHEDULE</span><strong id="widget-schedule-title">일정</strong></div>
              <span>{selectedTasks.length}</span>
            </div>
            <section className="widget-progress" aria-label={`완료 ${completedCount}개, 전체 ${selectedTasks.length}개`}>
              <div><span>진행</span><strong>{completedCount}/{selectedTasks.length}</strong></div>
              <div className="progress-track"><span style={{ width: `${selectedTasks.length ? (completedCount / selectedTasks.length) * 100 : 0}%` }} /></div>
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
            <div className="widget-task-list" aria-label="선택한 날짜의 일정">
              {selectedTasks.length === 0 ? (
                <EmptyState compact />
              ) : (
                selectedTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    tags={taskTags}
                    compact
                    showSubTasks
                    onOpen={openTask}
                    onSecondaryAction={onTaskSecondaryAction}
                    onSubTaskToggle={onSubTaskToggle}
                  />
                ))
              )}
            </div>
          </section>

          <SplitHandle
            qa="widget-splitter"
            value={widgetSplit}
            onPreview={setWidgetSplit}
            onCommit={(value) => {
              if (!onSettingsChange({ widgetSplit: value })) setWidgetSplit(settings.widgetSplit)
            }}
          />

          <div className="widget-quick-note-pane" data-qa="widget-quick-notes">
            <DailyNotesSection
              helpId="widget-notes"
              selectedDate={selectedDate}
              notes={selectedDailyNotes}
              composerOpen={noteComposerOpen}
              createRequest={0}
              onComposerOpenChange={setNoteComposerOpen}
              onCreate={onDailyNoteCreate}
              onUpdate={onDailyNoteUpdate}
              onToggle={toggleVisibleDailyNote}
              onPinToggle={toggleVisibleDailyNotePin}
              onDelete={onDailyNoteDelete}
              reorderable={false}
              showHeaderAdd
            />
          </div>
        </div>
      </main>

      {!widgetState.locked && <span className="resize-corner" aria-hidden="true" />}
      </div>
      <TaskModal
        open={modalOpen}
        initialStartDate={selectedDate}
        initialEndDate={selectedDate}
        task={editingTask}
        tags={taskTags}
        onClose={() => {
          setModalOpen(false)
          setEditingTask(null)
        }}
        onSave={(draft, id, changes) => {
          const saved = id
            ? onUpdate(id, changes ?? { draft: {} })
            : onCreate(draft)
          if (!saved) return false
          setSelectedDate(draft.startDate)
          setModalOpen(false)
          setEditingTask(null)
          return true
        }}
        onDelete={onTaskDelete}
      />
      <HelpTour id="widget-help-tour" open={helpOpen} steps={WIDGET_HELP_STEPS} onClose={() => setHelpOpen(false)} />
    </>
  )
}

export default function App({ mode }: { mode: AppMode }) {
  const { store, storeRef, loading, error, commit } = useTaskStore()
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastId = useRef(0)
  const secondaryActionGuard = useRef<Record<string, number>>({})

  useEffect(() => {
    const root = document.documentElement
    for (const [property, value] of Object.entries(themeVariables(store.settings))) {
      root.style.setProperty(property, value)
    }
  }, [store.settings])

  const showToast = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    toastId.current += 1
    setToast({ id: toastId.current, message, actionLabel, onAction })
  }, [])

  const handleSecondaryAction = useCallback((id: string) => {
    const task = storeRef.current.tasks.find((item) => item.id === id && !item.deletedAt)
    if (!task) return
    const now = Date.now()
    if (task.completed && (secondaryActionGuard.current[id] ?? 0) > now) {
      showToast('비활성화됐어요. 잠시 후 다시 우클릭하면 최근 삭제로 이동해요.')
      return
    }

    const result = advanceTaskState(storeRef.current.tasks, id, new Date(now))
    if (!commit((current) => ({ ...current, tasks: result.tasks }))) return
    if (result.action === 'deactivated') {
      secondaryActionGuard.current[id] = now + 700
      showToast('일정을 비활성화했어요. 다시 우클릭하면 최근 삭제로 이동해요.', '활성화', () => {
        delete secondaryActionGuard.current[id]
        commit((current) => ({ ...current, tasks: setTaskCompleted(current.tasks, id, false) }))
      })
    } else if (result.action === 'deleted') {
      delete secondaryActionGuard.current[id]
      showToast('일정을 최근 삭제로 옮겼어요.', '실행 취소', () => {
        commit((current) => ({ ...current, tasks: restoreTask(current.tasks, id) }))
      })
    }
  }, [commit, showToast, storeRef])

  const handleDelete = useCallback((id: string) => {
    delete secondaryActionGuard.current[id]
    if (!commit((current) => ({ ...current, tasks: softDeleteTask(current.tasks, id) }))) return false
    showToast('일정을 최근 삭제로 옮겼어요.', '실행 취소', () => {
      commit((current) => ({ ...current, tasks: restoreTask(current.tasks, id) }))
    })
    return true
  }, [commit, showToast])

  const handleRestore = useCallback((id: string) => {
    if (!commit((current) => ({ ...current, tasks: restoreTask(current.tasks, id) }))) return
    showToast('원래 날짜와 상태로 복구했어요.')
  }, [commit, showToast])

  const handleCreate = useCallback((draft: TaskDraft) => {
    const now = new Date().toISOString()
    const task: Task = {
      id: crypto.randomUUID(),
      ...draft,
      position: nextPosition(storeRef.current.tasks),
      completed: false,
      completedAt: null,
      deletedAt: null,
      previousCompleted: null,
      createdAt: now,
      updatedAt: now,
    }
    if (!commit((current) => ({ ...current, tasks: [...current.tasks, task] }))) return false
    showToast('새 일정을 캘린더에 추가했어요.')
    return true
  }, [commit, showToast, storeRef])

  const handleUpdate = useCallback((id: string, changes: TaskEditChanges) => {
    const now = new Date()
    const timestamp = now.toISOString()
    delete secondaryActionGuard.current[id]
    const openingLatest = storeRef.current.tasks.find((task) => task.id === id && !task.deletedAt)
    if (!openingLatest) {
      showToast('다른 창에서 이미 삭제된 일정이라 변경을 저장하지 못했어요.')
      return false
    }
    const openingStart = changes.draft.startDate ?? openingLatest.startDate
    const openingEnd = changes.draft.dueDate ?? openingLatest.dueDate
    if (openingEnd < openingStart) {
      showToast('다른 창에서 일정 기간이 바뀌었어요. 상세 창을 다시 열어 기간을 확인해 주세요.')
      return false
    }
    let dateConflict = false
    const saved = commit((current) => {
      const latestTask = current.tasks.find((task) => task.id === id && !task.deletedAt)
      if (!latestTask) return current
      const nextStart = changes.draft.startDate ?? latestTask.startDate
      const nextEnd = changes.draft.dueDate ?? latestTask.dueDate
      if (nextEnd < nextStart) {
        dateConflict = true
        return current
      }
      const draftChanges = applyTaskEditChanges(latestTask, changes)
      const withDraft = current.tasks.map((task) => task.id === id
        ? { ...task, ...draftChanges, updatedAt: timestamp }
        : task)
      return {
        ...current,
        tasks: typeof changes.completed !== 'boolean'
          ? withDraft
          : changes.cascadeSubTasks
            ? setTaskCompleted(withDraft, id, changes.completed, now)
            : withDraft.map((task) => task.id === id
              ? {
                  ...task,
                  completed: changes.completed as boolean,
                  completedAt: changes.completed ? timestamp : null,
                  updatedAt: timestamp,
                }
              : task),
      }
    })
    if (dateConflict) {
      showToast('다른 창에서 일정 기간이 바뀌었어요. 상세 창을 다시 열어 기간을 확인해 주세요.')
      return false
    }
    if (saved) showToast('일정 변경을 저장했어요.')
    return saved
  }, [commit, showToast, storeRef])

  const handleSubTaskToggle = useCallback((taskId: string, subTaskId: string) => {
    const before = storeRef.current.tasks
      .find((task) => task.id === taskId)
      ?.subTasks.find((subTask) => subTask.id === subTaskId)
    if (!before) return
    if (!commit((current) => ({
      ...current,
      tasks: toggleSubTask(current.tasks, taskId, subTaskId),
    }))) return
    showToast(before.completed ? '세부 할 일을 다시 활성화했어요.' : '세부 할 일을 완료했어요.')
  }, [commit, showToast, storeRef])

  const handleDailyNoteCreate = useCallback((noteDate: string, content: string) => {
    const timestamp = new Date().toISOString()
    const note: DailyNote = {
      id: crypto.randomUUID(),
      content,
      noteDate,
      completed: false,
      completedAt: null,
      pinned: false,
      pinnedStartDate: null,
      pinnedEndDate: null,
      viewPositions: {},
      position: nextPosition(storeRef.current.dailyNotes.filter((note) => note.noteDate === noteDate)),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (!commit((current) => ({ ...current, dailyNotes: [...current.dailyNotes, note] }))) return false
    showToast('퀵 노트를 기록했어요.')
    return true
  }, [commit, showToast, storeRef])

  const handleDailyNoteUpdate = useCallback((id: string, content: string) => {
    const timestamp = new Date().toISOString()
    const saved = commit((current) => ({
      ...current,
      dailyNotes: current.dailyNotes.map((note) => note.id === id
        ? { ...note, content, updatedAt: timestamp }
        : note),
    }))
    if (saved) showToast('퀵 노트를 수정했어요.')
    return saved
  }, [commit, showToast])

  const handleDailyNoteToggle = useCallback((id: string, selectedDate: string) => {
    const before = storeRef.current.dailyNotes.find((note) => note.id === id)
    if (!before) return
    if (!commit((current) => ({
      ...current,
      dailyNotes: toggleDailyNoteCompleted(current.dailyNotes, id, selectedDate),
    }))) return
    if (!before.completed && before.pinned) {
      showToast('퀵 노트를 비활성화하고 고정을 해제했어요.')
    }
  }, [commit, showToast, storeRef])

  const handleDailyNoteDelete = useCallback((id: string) => {
    if (!commit((current) => ({
      ...current,
      dailyNotes: current.dailyNotes.filter((note) => note.id !== id),
    }))) return
    showToast('퀵 노트를 삭제했어요.')
  }, [commit, showToast])

  const handleTaskReorder = useCallback((orderedIds: string[]) => {
    if (orderedIds.length < 2) return true
    return commit((current) => ({
      ...current,
      tasks: reorderTaskSubset(current.tasks, orderedIds),
    }))
  }, [commit])

  const handleDailyNotePinToggle = useCallback((id: string, selectedDate: string) => {
    const before = storeRef.current.dailyNotes.find((note) => note.id === id)
    if (!before) return
    if (before.completed) {
      showToast('비활성 퀵 노트는 다시 활성화한 뒤 고정할 수 있어요.')
      return
    }
    if (!commit((current) => ({
      ...current,
      dailyNotes: toggleDailyNotePin(current.dailyNotes, id, selectedDate),
    }))) return
    showToast(before.pinned ? '퀵 노트 고정을 해제했어요.' : '퀵 노트를 모든 날짜에 고정했어요.')
  }, [commit, showToast, storeRef])

  const handleTaskDateMove = useCallback((id: string, targetStart: string) => {
    const before = storeRef.current.tasks.find((task) => task.id === id && !task.deletedAt)
    if (!before) return null
    if (before.startDate === targetStart) return before
    const saved = commit((current) => ({
      ...current,
      tasks: moveTaskRange(current.tasks, id, targetStart),
    }))
    if (!saved) return null
    const moved = storeRef.current.tasks.find((task) => task.id === id && !task.deletedAt) ?? null
    if (!moved || moved.startDate !== targetStart) {
      showToast('다른 창에서 일정이 변경되어 날짜를 옮기지 못했어요.')
      return null
    }
    showToast(`${formatCompactDate(targetStart)}로 일정을 옮겼어요.`)
    return moved
  }, [commit, showToast, storeRef])

  const handleDailyNoteReorder = useCallback((orderedIds: string[], selectedDate: string) => {
    if (orderedIds.length < 2) return true
    return commit((current) => ({
      ...current,
      dailyNotes: reorderDailyNotesForDate(current.dailyNotes, orderedIds, selectedDate),
    }))
  }, [commit])

  const handleSettingsChange = useCallback((changes: Partial<AppSettings>) => {
    const safe: Partial<AppSettings> = {
      ...(typeof changes.sidebarSplit === 'number' ? { sidebarSplit: clamp(changes.sidebarSplit, 20, 80) } : {}),
      ...(typeof changes.widgetSplit === 'number' ? { widgetSplit: clamp(changes.widgetSplit, 20, 80) } : {}),
      ...(typeof changes.fontScale === 'number' ? { fontScale: clamp(changes.fontScale, 0.85, 1.5) } : {}),
      ...(changes.themeColor ? { themeColor: normalizedHex(changes.themeColor, storeRef.current.settings.themeColor) } : {}),
      ...(typeof changes.calendarWeekScroll === 'boolean' ? { calendarWeekScroll: changes.calendarWeekScroll } : {}),
    }
    return commit((current) => ({ ...current, settings: { ...current.settings, ...safe } }))
  }, [commit, storeRef])

  const handleTagCreate = useCallback((name: string, color: string) => {
    const cleanName = name.trim()
    if (!cleanName) return false
    const timestamp = new Date().toISOString()
    const tag: TaskTag = {
      id: crypto.randomUUID(),
      name: cleanName,
      color: normalizedHex(color, TAG_PALETTE[0]),
      builtIn: false,
      legacyColor: null,
      position: nextPosition(storeRef.current.taskTags),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const saved = commit((current) => ({ ...current, taskTags: [...current.taskTags, tag] }))
    if (saved) showToast('새 태그를 추가했어요.')
    return saved
  }, [commit, showToast, storeRef])

  const handleTagUpdate = useCallback((id: string, changes: Partial<Pick<TaskTag, 'name' | 'color'>>) => {
    const currentTag = storeRef.current.taskTags.find((tag) => tag.id === id)
    if (!currentTag) return false
    const nextName = typeof changes.name === 'string' ? changes.name.trim() : currentTag.name
    if (!nextName) return false
    const timestamp = new Date().toISOString()
    const saved = commit((current) => ({
      ...current,
      taskTags: current.taskTags.map((tag) => tag.id === id
        ? {
            ...tag,
            ...(typeof changes.name === 'string' ? { name: nextName } : {}),
            ...(typeof changes.color === 'string' ? { color: normalizedHex(changes.color, tag.color) } : {}),
            updatedAt: timestamp,
          }
        : tag),
    }))
    if (saved) showToast('태그 설정을 저장했어요.')
    return saved
  }, [commit, showToast, storeRef])

  const handleTagDelete = useCallback((id: string) => {
    const tag = storeRef.current.taskTags.find((item) => item.id === id)
    if (!tag || tag.builtIn) return
    if (!commit((current) => ({
      ...current,
      taskTags: current.taskTags.filter((item) => item.id !== id),
    }))) return
    showToast('사용자 태그를 삭제했어요. 기존 일정은 태그 없음으로 유지돼요.')
  }, [commit, showToast, storeRef])

  const handleTemplateSave = useCallback((draft: TemplateDraft, id?: string, openingSnapshot?: TaskTemplate) => {
    const timestamp = new Date().toISOString()
    const safeDraft = {
      ...draft,
      title: draft.title.trim(),
      note: draft.note.trim(),
      durationDays: clamp(Math.round(draft.durationDays), 1, 365),
      subTaskTitles: draft.subTaskTitles.map((title) => title.trim()).filter(Boolean),
    }
    if (!safeDraft.title) return false
    if (id && !storeRef.current.taskTemplates.some((template) => template.id === id)) {
      showToast('다른 창에서 이미 삭제된 템플릿이라 저장하지 못했어요.')
      return false
    }
    const saved = commit((current) => id
      ? {
          ...current,
          taskTemplates: current.taskTemplates.map((template) => {
            if (template.id !== id) return template
            const baseline = openingSnapshot
            const patch: Partial<TemplateDraft> = {}
            if (!baseline || safeDraft.title !== baseline.title) patch.title = safeDraft.title
            if (!baseline || safeDraft.note !== baseline.note) patch.note = safeDraft.note
            if (!baseline || safeDraft.dueTime !== baseline.dueTime) patch.dueTime = safeDraft.dueTime
            if (!baseline || safeDraft.tagId !== baseline.tagId) patch.tagId = safeDraft.tagId
            if (!baseline || safeDraft.legacyColor !== baseline.legacyColor) patch.legacyColor = safeDraft.legacyColor
            if (!baseline || safeDraft.durationDays !== baseline.durationDays) patch.durationDays = safeDraft.durationDays
            if (!baseline || safeDraft.subTaskTitles.length !== baseline.subTaskTitles.length
              || safeDraft.subTaskTitles.some((title, index) => title !== baseline.subTaskTitles[index])) {
              patch.subTaskTitles = safeDraft.subTaskTitles
            }
            return Object.keys(patch).length === 0
              ? template
              : { ...template, ...patch, updatedAt: timestamp }
          }),
        }
      : {
          ...current,
          taskTemplates: [
            ...current.taskTemplates,
            {
              id: crypto.randomUUID(),
              ...safeDraft,
              position: nextPosition(current.taskTemplates),
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        })
    if (saved) showToast(id ? '반복 일정 템플릿을 수정했어요.' : '반복 일정 템플릿을 추가했어요.')
    return saved
  }, [commit, showToast, storeRef])

  const handleTemplateDelete = useCallback((id: string) => {
    if (!commit((current) => ({
      ...current,
      taskTemplates: current.taskTemplates.filter((template) => template.id !== id),
    }))) return false
    showToast('반복 일정 템플릿을 삭제했어요.')
    return true
  }, [commit, showToast])

  const handleTemplateReorder = useCallback((orderedIds: string[]) => {
    if (orderedIds.length < 2) return true
    const currentIds = sortedPositioned(storeRef.current.taskTemplates).map((template) => template.id)
    if (currentIds.length === orderedIds.length
      && currentIds.every((id, index) => id === orderedIds[index])) return true
    const saved = commit((current) => ({
      ...current,
      taskTemplates: reorderPositioned(current.taskTemplates, orderedIds),
    }))
    if (saved) showToast('반복 일정 순서를 변경했어요.')
    return saved
  }, [commit, showToast, storeRef])

  const handleTemplateInstantiate = useCallback((id: string, startDate: string) => {
    const template = storeRef.current.taskTemplates.find((item) => item.id === id)
    if (!template) return false
    const task = createTaskFromTemplate(template, startDate, nextPosition(storeRef.current.tasks))
    if (!commit((current) => ({ ...current, tasks: [...current.tasks, task] }))) return false
    showToast(`${formatCompactDate(startDate)}에 반복 일정을 추가했어요.`)
    return true
  }, [commit, showToast, storeRef])

  const shared: SharedViewProps = {
    tasks: store.tasks,
    dailyNotes: store.dailyNotes,
    taskTags: store.taskTags,
    settings: store.settings,
    taskTemplates: store.taskTemplates,
    loading,
    error,
    migrationWarning: store.migrationWarning,
    onTaskSecondaryAction: handleSecondaryAction,
    onTaskDelete: handleDelete,
    onTaskRestore: handleRestore,
    onSubTaskToggle: handleSubTaskToggle,
    onDailyNoteCreate: handleDailyNoteCreate,
    onDailyNoteUpdate: handleDailyNoteUpdate,
    onDailyNoteToggle: handleDailyNoteToggle,
    onDailyNotePinToggle: handleDailyNotePinToggle,
    onDailyNoteDelete: handleDailyNoteDelete,
    onTaskReorder: handleTaskReorder,
    onTaskDateMove: handleTaskDateMove,
    onDailyNoteReorder: handleDailyNoteReorder,
    onSettingsChange: handleSettingsChange,
    onTagCreate: handleTagCreate,
    onTagUpdate: handleTagUpdate,
    onTagDelete: handleTagDelete,
    onTemplateSave: handleTemplateSave,
    onTemplateDelete: handleTemplateDelete,
    onTemplateInstantiate: handleTemplateInstantiate,
    onTemplateReorder: handleTemplateReorder,
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
