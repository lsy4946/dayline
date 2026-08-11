export interface CalendarDay {
  key: string
  date: Date
  inCurrentMonth: boolean
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function fromDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

export function isDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const date = fromDateKey(key)
  return Number.isFinite(date.getTime()) && toDateKey(date) === key
}

export function todayKey(): string {
  return toDateKey(new Date())
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

export function addDaysKey(key: string, amount: number): string {
  return toDateKey(addDays(fromDateKey(key), amount))
}

export function inclusiveDateKeys(startDate: string, endDate: string): string[] {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) return []
  const keys: string[] = []
  for (let key = startDate; key <= endDate; key = addDaysKey(key, 1)) keys.push(key)
  return keys
}

export function dateRangeContains(startDate: string, endDate: string, dateKey: string): boolean {
  return isDateKey(startDate)
    && isDateKey(endDate)
    && isDateKey(dateKey)
    && startDate <= dateKey
    && dateKey <= endDate
}

export function dateRangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  if (
    !isDateKey(firstStart)
    || !isDateKey(firstEnd)
    || !isDateKey(secondStart)
    || !isDateKey(secondEnd)
    || firstStart > firstEnd
    || secondStart > secondEnd
  ) return false
  return firstStart <= secondEnd && secondStart <= firstEnd
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0)
}

export function shiftMonth(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12, 0, 0, 0)
}

export function calendarDays(month: Date): CalendarDay[] {
  const first = startOfMonth(month)
  const gridStart = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(gridStart, index)
    return {
      key: toDateKey(date),
      date,
      inCurrentMonth: date.getMonth() === month.getMonth(),
    }
  })
}
export function formatMonthTitle(date: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
  }).format(date)
}

export function formatFullDate(key: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(fromDateKey(key))
}

export function formatCompactDate(key: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(fromDateKey(key))
}

export function formatDayLabel(key: string): string {
  const today = todayKey()
  if (key === today) return '오늘'
  if (key === addDaysKey(today, 1)) return '내일'
  if (key === addDaysKey(today, -1)) return '어제'
  return formatCompactDate(key)
}

export function getWeekendKey(baseKey = todayKey()): string {
  const base = fromDateKey(baseKey)
  const daysUntilSaturday = (6 - base.getDay() + 7) % 7
  return addDaysKey(baseKey, daysUntilSaturday)
}

export function weekDaysAround(key = todayKey()): Array<{ key: string; weekday: string; day: number }> {
  const date = fromDateKey(key)
  const start = addDays(date, -date.getDay())
  const weekday = ['일', '월', '화', '수', '목', '금', '토']
  return Array.from({ length: 7 }, (_, index) => {
    const current = addDays(start, index)
    return { key: toDateKey(current), weekday: weekday[index], day: current.getDate() }
  })
}
