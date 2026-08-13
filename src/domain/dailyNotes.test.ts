import { describe, expect, it } from 'vitest'
import type { DailyNote } from '../types'
import { dailyNotesForDate, shouldLingerAfterForeignUnpin } from './dailyNotes'

const DATE_A = '2026-08-10'
const DATE_B = '2026-08-11'

function note(id: string, overrides: Partial<DailyNote> = {}): DailyNote {
  return {
    id,
    content: id,
    noteDate: DATE_A,
    completed: false,
    completedAt: null,
    pinned: false,
    position: 0,
    createdAt: `2026-08-10T00:00:0${id.length}.000Z`,
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('daily note pin visibility', () => {
  it('combines native notes with active pinned notes without duplicating a native pinned note', () => {
    const native = note('native', { noteDate: DATE_B, position: 1 })
    const nativePinned = note('native-pinned', { noteDate: DATE_B, pinned: true, position: 0 })
    const foreignPinned = note('foreign-pinned', { pinned: true })
    const foreignPlain = note('foreign-plain')
    const foreignCompletedPinned = note('foreign-completed', {
      pinned: true,
      completed: true,
      completedAt: '2026-08-10T01:00:00.000Z',
    })

    expect(dailyNotesForDate([
      native,
      nativePinned,
      foreignPinned,
      foreignPlain,
      foreignCompletedPinned,
    ], DATE_B).map((value) => value.id)).toEqual([
      'foreign-pinned',
      'foreign-completed',
      'native-pinned',
      'native',
    ])
  })

  it('keeps pinned notes at the top on their own date regardless of completion or saved position', () => {
    const nativePlain = note('native-plain', { noteDate: DATE_B, position: 0 })
    const nativeCompletedPin = note('native-completed-pin', {
      noteDate: DATE_B,
      pinned: true,
      completed: true,
      completedAt: '2026-08-11T01:00:00.000Z',
      position: 1,
    })
    const nativeActivePin = note('native-active-pin', {
      noteDate: DATE_B,
      pinned: true,
      position: 99,
    })

    expect(dailyNotesForDate([
      nativePlain,
      nativeCompletedPin,
      nativeActivePin,
    ], DATE_B).map((value) => value.id)).toEqual([
      'native-completed-pin',
      'native-active-pin',
      'native-plain',
    ])
  })

  it('keeps a completed pinned note globally visible until it is unpinned', () => {
    const completedPin = note('completed-pin', {
      pinned: true,
      completed: true,
      completedAt: '2026-08-10T01:00:00.000Z',
    })

    expect(dailyNotesForDate([completedPin], DATE_B)).toEqual([completedPin])
    expect(dailyNotesForDate([{ ...completedPin, pinned: false }], DATE_B)).toEqual([])
  })

  it('keeps a changed foreign note only on the date where the change occurred', () => {
    const foreign = note('foreign', { pinned: false, completed: true })
    const lingerDates = new Map([[foreign.id, DATE_B]])

    expect(dailyNotesForDate([foreign], DATE_B, lingerDates)).toEqual([foreign])
    expect(dailyNotesForDate([foreign], '2026-08-12', lingerDates)).toEqual([])
    expect(dailyNotesForDate([foreign], DATE_A, lingerDates)).toEqual([foreign])
  })

  it('retains stable source-date and per-date ordering for foreign pinned notes', () => {
    const values = [
      note('later-position', { pinned: true, position: 2 }),
      note('later-date', { pinned: true, noteDate: '2026-08-09', position: 5 }),
      note('earlier-position', { pinned: true, position: 1 }),
    ]

    expect(dailyNotesForDate(values, DATE_B).map((value) => value.id)).toEqual([
      'later-date',
      'earlier-position',
      'later-position',
    ])
  })

  it('lingers only when a visible pin is unpinned from a foreign date', () => {
    expect(shouldLingerAfterForeignUnpin(note('active-pin', { pinned: true }), DATE_B)).toBe(true)
    expect(shouldLingerAfterForeignUnpin(note('native-pin', { noteDate: DATE_B, pinned: true }), DATE_B)).toBe(false)
    expect(shouldLingerAfterForeignUnpin(note('plain'), DATE_B)).toBe(false)
    expect(shouldLingerAfterForeignUnpin(note('completed-pin', { pinned: true, completed: true }), DATE_B)).toBe(true)
  })
})
