import { describe, expect, it } from 'vitest'
import { addDaysKey } from './date'
import { getCalendarDayTone, getKoreanHoliday } from './koreanHolidays'

const OFFICIAL_2026_HOLIDAYS = [
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-03-01',
  '2026-03-02',
  '2026-05-01',
  '2026-05-05',
  '2026-05-24',
  '2026-05-25',
  '2026-06-03',
  '2026-06-06',
  '2026-07-17',
  '2026-08-15',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-10-03',
  '2026-10-05',
  '2026-10-09',
  '2026-12-25',
]

function holidayKeysForYear(year: number) {
  const keys: string[] = []
  let key = `${year}-01-01`
  while (key <= `${year}-12-31`) {
    if (getKoreanHoliday(key)) keys.push(key)
    key = addDaysKey(key, 1)
  }
  return keys
}

describe('Korean calendar holidays', () => {
  it('matches the complete official 2026 holiday preset', () => {
    expect(holidayKeysForYear(2026)).toEqual(OFFICIAL_2026_HOLIDAYS)
  })

  it('recognizes newly added, lunar, election, and substitute holidays', () => {
    expect(getKoreanHoliday('2026-05-01')).toMatchObject({ name: '노동절', kind: 'fixed' })
    expect(getKoreanHoliday('2026-07-17')).toMatchObject({ name: '제헌절', kind: 'fixed' })
    expect(getKoreanHoliday('2026-02-17')).toMatchObject({ name: '설날', kind: 'lunar' })
    expect(getKoreanHoliday('2026-06-03')).toMatchObject({ name: '전국동시지방선거', kind: 'election' })
    expect(getKoreanHoliday('2026-08-17')).toMatchObject({
      name: '대체공휴일(광복절)',
      kind: 'substitute',
    })
  })

  it('gives named holidays precedence over their weekday color', () => {
    expect(getCalendarDayTone('2026-08-15')).toBe('red') // Saturday, Liberation Day
    expect(getCalendarDayTone('2026-08-22')).toBe('blue') // Ordinary Saturday
    expect(getCalendarDayTone('2026-08-16')).toBe('red') // Sunday
    expect(getCalendarDayTone('2026-08-17')).toBe('red') // Substitute holiday
    expect(getCalendarDayTone('2026-08-18')).toBe('default')
  })

  it('includes the latest known substitute holidays and safely rejects invalid keys', () => {
    expect(getKoreanHoliday('2027-05-03')?.name).toBe('대체공휴일(노동절)')
    expect(getKoreanHoliday('2027-07-19')?.name).toBe('대체공휴일(제헌절)')
    expect(getKoreanHoliday('not-a-date')).toBeNull()
    expect(getCalendarDayTone('not-a-date')).toBe('default')
  })
})
