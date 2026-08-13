import type { DailyNote } from '../types'

export type DailyNoteLingerDates = ReadonlyMap<string, string>

function comparePositioned(left: DailyNote, right: DailyNote): number {
  return left.position - right.position
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

/**
 * Builds the sidebar list without copying a pinned note into each date.
 * Pinned notes lead the list even on their source date and remain globally
 * visible regardless of completion state. Notes owned by the selected date
 * are still included only once, and each group keeps its stable per-date order.
 */
export function dailyNotesForDate(
  notes: DailyNote[],
  selectedDate: string,
  lingerDates: DailyNoteLingerDates = new Map(),
): DailyNote[] {
  return notes
    .filter((note) => note.noteDate === selectedDate
      || note.pinned
      || lingerDates.get(note.id) === selectedDate)
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1

      const leftNative = left.noteDate === selectedDate
      const rightNative = right.noteDate === selectedDate
      if (leftNative !== rightNative) return leftNative ? 1 : -1
      if (!leftNative) {
        const dateOrder = left.noteDate.localeCompare(right.noteDate)
        if (dateOrder !== 0) return dateOrder
      }
      return comparePositioned(left, right)
    })
}

export function shouldLingerAfterForeignUnpin(note: DailyNote, selectedDate: string): boolean {
  return note.noteDate !== selectedDate && note.pinned
}
