import type { Task, TaskScheduleType } from '../types'
import {
  addDaysKey,
  dateRangesOverlap,
  fromDateKey,
  inclusiveDateKeys,
  isDateKey,
  toDateKey,
} from './date'
import { getKoreanHoliday } from './koreanHolidays'

export interface TaskOccurrenceRange {
  startDate: string
  dueDate: string
}

const SCHEDULE_TYPES = new Set<TaskScheduleType>([
  'normal',
  'monthly-date',
  'monthly-weekday',
  'monthly-first',
  'monthly-last',
])

export function normalizeTaskScheduleType(value: unknown): TaskScheduleType {
  return SCHEDULE_TYPES.has(value as TaskScheduleType)
    ? value as TaskScheduleType
    : 'normal'
}

export function taskUsesBusinessDay(task: Pick<Task, 'scheduleType' | 'businessDay'>): boolean {
  const scheduleType = normalizeTaskScheduleType(task.scheduleType)
  return (scheduleType === 'monthly-first' || scheduleType === 'monthly-last')
    && task.businessDay === true
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0, 12).getDate()
}

function monthSerial(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth()
}

function yearAndMonth(serial: number): { year: number; monthIndex: number } {
  const year = Math.floor(serial / 12)
  return { year, monthIndex: serial - year * 12 }
}

function isBusinessDate(dateKey: string): boolean {
  const weekday = fromDateKey(dateKey).getDay()
  return weekday !== 0 && weekday !== 6 && !getKoreanHoliday(dateKey)
}

function firstBusinessDate(year: number, monthIndex: number): string {
  const lastDay = daysInMonth(year, monthIndex)
  for (let day = 1; day <= lastDay; day += 1) {
    const key = toDateKey(new Date(year, monthIndex, day, 12))
    if (isBusinessDate(key)) return key
  }
  return toDateKey(new Date(year, monthIndex, 1, 12))
}

function lastBusinessDate(year: number, monthIndex: number): string {
  for (let day = daysInMonth(year, monthIndex); day >= 1; day -= 1) {
    const key = toDateKey(new Date(year, monthIndex, day, 12))
    if (isBusinessDate(key)) return key
  }
  return toDateKey(new Date(year, monthIndex + 1, 0, 12))
}

function occurrenceStartInMonth(task: Task, year: number, monthIndex: number): string | null {
  const scheduleType = normalizeTaskScheduleType(task.scheduleType)
  const anchor = fromDateKey(task.startDate)
  const lastDay = daysInMonth(year, monthIndex)

  if (scheduleType === 'monthly-date') {
    const day = anchor.getDate()
    return day <= lastDay ? toDateKey(new Date(year, monthIndex, day, 12)) : null
  }

  if (scheduleType === 'monthly-weekday') {
    const occurrence = Math.floor((anchor.getDate() - 1) / 7) + 1
    const weekday = anchor.getDay()
    const firstWeekday = new Date(year, monthIndex, 1, 12).getDay()
    const day = 1 + ((weekday - firstWeekday + 7) % 7) + (occurrence - 1) * 7
    return day <= lastDay ? toDateKey(new Date(year, monthIndex, day, 12)) : null
  }

  if (scheduleType === 'monthly-first') {
    return taskUsesBusinessDay(task)
      ? firstBusinessDate(year, monthIndex)
      : toDateKey(new Date(year, monthIndex, 1, 12))
  }

  if (scheduleType === 'monthly-last') {
    return taskUsesBusinessDay(task)
      ? lastBusinessDate(year, monthIndex)
      : toDateKey(new Date(year, monthIndex + 1, 0, 12))
  }

  return null
}

/**
 * Expands a task into concrete ranges only for the requested window. Monthly
 * rules start at the selected anchor date and repeat indefinitely afterwards.
 * A missing date (for example the 30th in February or a fifth weekday) is
 * intentionally skipped rather than moved to a different day.
 */
export function taskOccurrenceRanges(
  task: Task,
  rangeStart: string,
  rangeEnd: string,
): TaskOccurrenceRange[] {
  if (
    !isDateKey(task.startDate)
    || !isDateKey(task.dueDate)
    || !isDateKey(rangeStart)
    || !isDateKey(rangeEnd)
    || task.startDate > task.dueDate
    || rangeStart > rangeEnd
  ) return []

  const scheduleType = normalizeTaskScheduleType(task.scheduleType)
  if (scheduleType === 'normal') {
    return dateRangesOverlap(task.startDate, task.dueDate, rangeStart, rangeEnd)
      ? [{ startDate: task.startDate, dueDate: task.dueDate }]
      : []
  }

  const durationDays = inclusiveDateKeys(task.startDate, task.dueDate).length
  if (durationDays < 1) return []

  const anchorMonth = monthSerial(fromDateKey(task.startDate))
  const rangeStartMonth = monthSerial(fromDateKey(rangeStart))
  const rangeEndMonth = monthSerial(fromDateKey(rangeEnd))
  const lookbackMonths = Math.ceil(durationDays / 28) + 1
  const firstMonth = Math.max(anchorMonth, rangeStartMonth - lookbackMonths)
  const occurrences: TaskOccurrenceRange[] = []

  for (let serial = firstMonth; serial <= rangeEndMonth; serial += 1) {
    const { year, monthIndex } = yearAndMonth(serial)
    const startDate = occurrenceStartInMonth(task, year, monthIndex)
    if (!startDate || startDate < task.startDate) continue
    const dueDate = addDaysKey(startDate, durationDays - 1)
    if (dateRangesOverlap(startDate, dueDate, rangeStart, rangeEnd)) {
      occurrences.push({ startDate, dueDate })
    }
  }

  return occurrences
}
