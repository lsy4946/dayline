import { describe, expect, it } from 'vitest'
import {
  addDays,
  calendarDays,
  calendarDaysFromStart,
  calendarGridStart,
  startOfMonth,
} from './date'

describe('calendar viewport dates', () => {
  it('builds the standard six-week month grid from Sunday', () => {
    const month = new Date(2026, 7, 1, 12)
    const days = calendarDays(month)

    expect(calendarGridStart(month).getDay()).toBe(0)
    expect(days).toHaveLength(42)
    expect(days[0].key).toBe('2026-07-26')
    expect(days.at(-1)?.key).toBe('2026-09-05')
  })

  it('moves every visible date exactly seven days for a rolling week viewport', () => {
    const month = startOfMonth(new Date(2026, 7, 15, 12))
    const initialStart = calendarGridStart(month)
    const initial = calendarDaysFromStart(initialStart, month)
    const next = calendarDaysFromStart(addDays(initialStart, 7), month)

    expect(next.map((day) => day.key)).toEqual(initial.map((day) => {
      const date = addDays(day.date, 7)
      const year = date.getFullYear()
      const monthNumber = String(date.getMonth() + 1).padStart(2, '0')
      const dateNumber = String(date.getDate()).padStart(2, '0')
      return `${year}-${monthNumber}-${dateNumber}`
    }))
  })

  it('does not mark the same month number in another year as current', () => {
    const otherYear = calendarDaysFromStart(
      new Date(2025, 0, 1, 12),
      new Date(2026, 0, 1, 12),
    )
    const currentYear = calendarDays(new Date(2026, 0, 1, 12))

    expect(otherYear.find((day) => day.key === '2025-01-01')?.inCurrentMonth).toBe(false)
    expect(currentYear.find((day) => day.key === '2026-01-01')?.inCurrentMonth).toBe(true)
  })
})
