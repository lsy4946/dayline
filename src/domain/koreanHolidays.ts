import {
  y2018,
  y2019,
  y2020,
  y2021,
  y2022,
  y2023,
  y2024,
  y2025,
  y2026,
  y2027,
} from '@hyunbinseo/holidays-kr/all'
import { fromDateKey, isDateKey } from './date'

export type CalendarDayTone = 'red' | 'blue' | 'default'
export type KoreanHolidayKind = 'fixed' | 'lunar' | 'substitute' | 'election' | 'temporary'

export interface KoreanHolidayInfo {
  names: readonly string[]
  name: string
  kind: KoreanHolidayKind
}

type HolidayPreset = Readonly<Record<string, readonly string[]>>

// The package contains the official monthly-calendar presets published by the
// Korea AeroSpace Administration. Static imports keep the desktop app offline.
const HOLIDAY_PRESETS: Readonly<Record<number, HolidayPreset>> = {
  2018: y2018,
  2019: y2019,
  2020: y2020,
  2021: y2021,
  2022: y2022,
  2023: y2023,
  2024: y2024,
  2025: y2025,
  2026: y2026,
  2027: y2027,
}

const LUNAR_HOLIDAY_NAMES = new Set([
  '설날 전날',
  '설날',
  '설날 다음 날',
  '부처님 오신 날',
  '추석 전날',
  '추석',
  '추석 다음 날',
])

function holidayKind(names: readonly string[]): KoreanHolidayKind {
  if (names.some((name) => name.startsWith('대체공휴일'))) return 'substitute'
  if (names.some((name) => name.includes('선거'))) return 'election'
  if (names.some((name) => name.includes('임시공휴일'))) return 'temporary'
  if (names.some((name) => LUNAR_HOLIDAY_NAMES.has(name))) return 'lunar'
  return 'fixed'
}

export function getKoreanHoliday(dateKey: string): KoreanHolidayInfo | null {
  if (!isDateKey(dateKey)) return null
  const year = Number(dateKey.slice(0, 4))
  const names = HOLIDAY_PRESETS[year]?.[dateKey]
  if (!names?.length) return null
  return {
    names,
    name: names.join(' · '),
    kind: holidayKind(names),
  }
}

export function getCalendarDayTone(dateKey: string): CalendarDayTone {
  if (!isDateKey(dateKey)) return 'default'
  if (getKoreanHoliday(dateKey)) return 'red'
  const weekday = fromDateKey(dateKey).getDay()
  if (weekday === 0) return 'red'
  if (weekday === 6) return 'blue'
  return 'default'
}
