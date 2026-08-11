import type { Task } from '../types'
import { addDaysKey, isDateKey } from './date'
import { sortTasks, taskOccursOnDate, taskOverlapsRange } from './tasks'

export interface CalendarTaskSegment {
  taskId: string
  weekRow: number
  lane: number
  startColumn: number
  endColumn: number
  segmentStart: string
  segmentEnd: string
  continuesBefore: boolean
  continuesAfter: boolean
}

export interface CalendarTaskDayCount {
  total: number
  visible: number
  hidden: number
}

export interface CalendarTaskLayout {
  segments: CalendarTaskSegment[]
  dayCounts: Record<string, CalendarTaskDayCount>
}

function laterKey(left: string, right: string) {
  return left > right ? left : right
}

function earlierKey(left: string, right: string) {
  return left < right ? left : right
}

function columnForDate(weekStart: string, dateKey: string) {
  let current = weekStart
  for (let column = 0; column < 7; column += 1) {
    if (current === dateKey) return column
    current = addDaysKey(current, 1)
  }
  return -1
}

interface CalendarTaskRange {
  start: string
  end: string
}

function rangesOverlap(left: CalendarTaskRange, right: CalendarTaskRange) {
  return left.start <= right.end && right.start <= left.end
}

export function layoutCalendarTaskSegments(
  tasks: Task[],
  gridStart: string,
  dayCount = 42,
  maxLanes = 3,
): CalendarTaskLayout {
  if (!isDateKey(gridStart) || !Number.isInteger(dayCount) || dayCount <= 0) {
    return { segments: [], dayCounts: {} }
  }

  const safeMaxLanes = Number.isFinite(maxLanes)
    ? Math.max(1, Math.floor(maxLanes))
    : 3
  const gridEnd = addDaysKey(gridStart, dayCount - 1)
  const relevantTasks = sortTasks(tasks.filter((task) => taskOverlapsRange(task, gridStart, gridEnd)))
  const segments: CalendarTaskSegment[] = []
  const visibleTaskIdsByDate = new Map<string, Set<string>>()
  const occupiedRangesByLane: CalendarTaskRange[][] = Array.from(
    { length: safeMaxLanes },
    () => [],
  )
  const laneByTaskId = new Map<string, number>()

  for (const task of relevantTasks) {
    const clippedRange = {
      start: laterKey(task.startDate, gridStart),
      end: earlierKey(task.dueDate, gridEnd),
    }
    const lane = occupiedRangesByLane.findIndex((ranges) =>
      ranges.every((range) => !rangesOverlap(range, clippedRange)),
    )
    if (lane < 0) continue
    occupiedRangesByLane[lane].push(clippedRange)
    laneByTaskId.set(task.id, lane)
  }

  for (let weekRow = 0; weekRow < Math.ceil(dayCount / 7); weekRow += 1) {
    const weekStart = addDaysKey(gridStart, weekRow * 7)
    const remainingDays = dayCount - weekRow * 7
    const weekEnd = addDaysKey(weekStart, Math.min(6, remainingDays - 1))

    for (const task of relevantTasks) {
      const lane = laneByTaskId.get(task.id)
      if (lane == null) continue
      if (!taskOverlapsRange(task, weekStart, weekEnd)) continue
      const segmentStart = laterKey(task.startDate, weekStart)
      const segmentEnd = earlierKey(task.dueDate, weekEnd)

      const startColumn = columnForDate(weekStart, segmentStart)
      const endColumn = columnForDate(weekStart, segmentEnd)
      if (startColumn < 0 || endColumn < startColumn) continue
      const segment: CalendarTaskSegment = {
        taskId: task.id,
        weekRow,
        lane,
        startColumn,
        endColumn,
        segmentStart,
        segmentEnd,
        continuesBefore: task.startDate < segmentStart,
        continuesAfter: task.dueDate > segmentEnd,
      }
      segments.push(segment)

      for (let key = segmentStart; key <= segmentEnd; key = addDaysKey(key, 1)) {
        const visible = visibleTaskIdsByDate.get(key) ?? new Set<string>()
        visible.add(task.id)
        visibleTaskIdsByDate.set(key, visible)
      }
    }
  }

  const dayCounts: Record<string, CalendarTaskDayCount> = {}
  for (let offset = 0; offset < dayCount; offset += 1) {
    const dateKey = addDaysKey(gridStart, offset)
    const total = relevantTasks.filter((task) => taskOccursOnDate(task, dateKey)).length
    const visible = visibleTaskIdsByDate.get(dateKey)?.size ?? 0
    dayCounts[dateKey] = { total, visible, hidden: Math.max(0, total - visible) }
  }

  return { segments, dayCounts }
}
