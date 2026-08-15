import { describe, expect, it } from 'vitest'
import type { DailyNote } from '../types'
import {
  dailyNotesForDate,
  reorderDailyNotesForDate,
  toggleDailyNoteCompleted,
  toggleDailyNotePin,
} from './dailyNotes'

const DATE_A = '2026-08-10'
const DATE_B = '2026-08-11'
const DATE_C = '2026-08-12'
const DATE_D = '2026-08-13'
const NOW = new Date('2026-08-12T05:00:00.000Z')

function note(id: string, overrides: Partial<DailyNote> = {}): DailyNote {
  return {
    id,
    content: id,
    noteDate: DATE_A,
    completed: false,
    completedAt: null,
    pinned: false,
    pinnedStartDate: null,
    pinnedEndDate: null,
    viewPositions: {},
    position: 0,
    createdAt: `2026-08-10T00:00:0${id.length}.000Z`,
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('daily note pin visibility and history', () => {
  it('places active pinned notes first by default without duplicating a native pin', () => {
    const native = note('native', { noteDate: DATE_B, position: 1 })
    const nativePinned = note('native-pinned', {
      noteDate: DATE_B,
      pinned: true,
      pinnedStartDate: DATE_B,
      position: 0,
    })
    const foreignPinned = note('foreign-pinned', { pinned: true, pinnedStartDate: DATE_A })
    const foreignPlain = note('foreign-plain')

    expect(dailyNotesForDate([
      native,
      nativePinned,
      foreignPinned,
      foreignPlain,
    ], DATE_B).map((value) => value.id)).toEqual([
      'foreign-pinned',
      'native-pinned',
      'native',
    ])
  })

  it('supports a per-date custom order that mixes foreign pins with native notes', () => {
    const values = [
      note('pin-a', { pinned: true, pinnedStartDate: DATE_A, position: 0 }),
      note('native-b', { noteDate: DATE_B, position: 0 }),
      note('native-b-2', { noteDate: DATE_B, position: 1 }),
    ]
    const reordered = reorderDailyNotesForDate(
      values,
      ['native-b', 'pin-a', 'native-b-2'],
      DATE_B,
      NOW,
    )

    expect(dailyNotesForDate(reordered, DATE_B).map((value) => value.id)).toEqual([
      'native-b',
      'pin-a',
      'native-b-2',
    ])
    expect(dailyNotesForDate(reordered, DATE_A).map((value) => value.id)).toEqual(['pin-a'])
    expect(reordered.find((value) => value.id === 'pin-a')?.viewPositions).toEqual({ [DATE_B]: 1 })
  })

  it('rejects incomplete or foreign reorder payloads without changing note identities', () => {
    const values = [
      note('pin-a', { pinned: true, pinnedStartDate: DATE_A }),
      note('native-b', { noteDate: DATE_B }),
    ]

    expect(reorderDailyNotesForDate(values, ['pin-a'], DATE_B, NOW)).toBe(values)
    expect(reorderDailyNotesForDate(values, ['pin-a', 'missing'], DATE_B, NOW)).toBe(values)
  })

  it('keeps an unpinned foreign note on its release date and records the interval', () => {
    const activePin = note('pin-a', { pinned: true, pinnedStartDate: DATE_A })
    const released = toggleDailyNotePin([activePin], activePin.id, DATE_B, NOW)[0]

    expect(released).toMatchObject({
      pinned: false,
      pinnedStartDate: DATE_A,
      pinnedEndDate: DATE_B,
    })
    expect(dailyNotesForDate([released], DATE_A)).toEqual([released])
    expect(dailyNotesForDate([released], DATE_B)).toEqual([released])
    expect(dailyNotesForDate([released], DATE_C)).toEqual([])
  })

  it('keeps both pin endpoints when the source date differs from the pin start', () => {
    const activePin = note('pin-a', {
      noteDate: DATE_C,
      pinned: true,
      pinnedStartDate: DATE_A,
    })
    const released = toggleDailyNotePin([activePin], activePin.id, DATE_B, NOW)[0]

    expect(dailyNotesForDate([released], DATE_A)).toEqual([released])
    expect(dailyNotesForDate([released], DATE_B)).toEqual([released])
    expect(dailyNotesForDate([released], DATE_C)).toEqual([released])
    expect(dailyNotesForDate([released], DATE_D)).toEqual([])
  })

  it('continues the original interval when a same-day release is immediately repinned', () => {
    const activePin = note('pin-a', { pinned: true, pinnedStartDate: DATE_A })
    const releasedOnB = toggleDailyNotePin([activePin], activePin.id, DATE_B, NOW)
    const repinnedOnB = toggleDailyNotePin(releasedOnB, activePin.id, DATE_B, NOW)
    const active = repinnedOnB[0]

    expect(active).toMatchObject({
      pinned: true,
      pinnedStartDate: DATE_A,
      pinnedEndDate: null,
    })

    const releasedOnC = toggleDailyNotePin(repinnedOnB, activePin.id, DATE_C, NOW)[0]
    expect(releasedOnC).toMatchObject({
      pinned: false,
      pinnedStartDate: DATE_A,
      pinnedEndDate: DATE_C,
    })
    expect(dailyNotesForDate([releasedOnC], DATE_A)).toEqual([releasedOnC])
    expect(dailyNotesForDate([releasedOnC], DATE_B)).toEqual([])
    expect(dailyNotesForDate([releasedOnC], DATE_C)).toEqual([releasedOnC])
  })

  it('starts a new interval when an old release is repinned from a different visible endpoint', () => {
    const prior = note('prior', {
      pinned: false,
      pinnedStartDate: DATE_A,
      pinnedEndDate: DATE_B,
      noteDate: DATE_C,
    })
    const repinned = toggleDailyNotePin([prior], prior.id, DATE_C, NOW)[0]

    expect(repinned).toMatchObject({
      pinned: true,
      pinnedStartDate: DATE_C,
      pinnedEndDate: null,
    })
  })

  it('automatically releases an active pin when the note is completed', () => {
    const activePin = note('pin-a', { pinned: true, pinnedStartDate: DATE_A })
    const completed = toggleDailyNoteCompleted([activePin], activePin.id, DATE_B, NOW)[0]

    expect(completed).toMatchObject({
      completed: true,
      completedAt: NOW.toISOString(),
      pinned: false,
      pinnedStartDate: DATE_A,
      pinnedEndDate: DATE_B,
    })
    expect(dailyNotesForDate([completed], DATE_B)).toEqual([completed])
    expect(dailyNotesForDate([completed], DATE_C)).toEqual([])

    const reactivated = toggleDailyNoteCompleted([completed], completed.id, DATE_B, NOW)[0]
    expect(reactivated).toMatchObject({
      completed: false,
      completedAt: null,
      pinned: false,
      pinnedStartDate: DATE_A,
      pinnedEndDate: DATE_B,
    })
  })
})
