import type { DailyNote } from '../types'

function comparePositioned(left: DailyNote, right: DailyNote): number {
  return left.position - right.position
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function visibleOnDate(note: DailyNote, selectedDate: string): boolean {
  return note.noteDate === selectedDate
    || note.pinned
    || (!note.pinned && note.pinnedStartDate === selectedDate)
    || note.pinnedEndDate === selectedDate
}

/**
 * Builds the sidebar list without copying a pinned note into each date. Pinned
 * notes lead by default, while a complete per-date view order may deliberately
 * interleave them with native notes. Once unpinned, a foreign note remains only
 * on its source date and the dates where the active pin interval started and
 * ended. The start/end endpoints may be the same date and are de-duplicated by
 * the single stored row.
 */
export function dailyNotesForDate(
  notes: DailyNote[],
  selectedDate: string,
): DailyNote[] {
  const visible = notes.filter((note) => visibleOnDate(note, selectedDate))
  return visible
    .sort((left, right) => {
      const leftExplicit = left.viewPositions[selectedDate]
      const rightExplicit = right.viewPositions[selectedDate]
      const leftHasExplicit = Number.isInteger(leftExplicit) && leftExplicit >= 0
      const rightHasExplicit = Number.isInteger(rightExplicit) && rightExplicit >= 0

      if (leftHasExplicit && rightHasExplicit && leftExplicit !== rightExplicit) {
        return leftExplicit - rightExplicit
      }
      if (leftHasExplicit !== rightHasExplicit) {
        const missing = leftHasExplicit ? right : left
        if (missing.pinned) return leftHasExplicit ? 1 : -1
        return leftHasExplicit ? -1 : 1
      }
      if (!leftHasExplicit && !rightHasExplicit && left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1
      }

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

export function reorderDailyNotesForDate(
  notes: DailyNote[],
  orderedIds: string[],
  selectedDate: string,
  now = new Date(),
): DailyNote[] {
  const visibleIds = new Set(dailyNotesForDate(notes, selectedDate).map((note) => note.id))
  const uniqueOrderedIds = orderedIds.filter((id, index) => visibleIds.has(id) && orderedIds.indexOf(id) === index)
  if (uniqueOrderedIds.length !== visibleIds.size) return notes

  const positions = new Map(uniqueOrderedIds.map((id, position) => [id, position]))
  const timestamp = now.toISOString()
  return notes.map((note) => {
    const position = positions.get(note.id)
    if (position == null || note.viewPositions[selectedDate] === position) return note
    return {
      ...note,
      viewPositions: { ...note.viewPositions, [selectedDate]: position },
      updatedAt: timestamp,
    }
  })
}

export function toggleDailyNotePin(
  notes: DailyNote[],
  noteId: string,
  selectedDate: string,
  now = new Date(),
): DailyNote[] {
  const target = notes.find((note) => note.id === noteId)
  if (!target || target.completed) return notes
  const timestamp = now.toISOString()

  if (target.pinned) {
    const currentOrder = dailyNotesForDate(notes, selectedDate).map((note) => note.id)
    const ordered = reorderDailyNotesForDate(notes, currentOrder, selectedDate, now)
    return ordered.map((note) => note.id === noteId
      ? {
          ...note,
          pinned: false,
          pinnedStartDate: note.pinnedStartDate ?? note.noteDate,
          pinnedEndDate: selectedDate,
          updatedAt: timestamp,
        }
      : note)
  }

  const resumedInterval = target.pinnedStartDate != null && target.pinnedEndDate === selectedDate
  const pinned = notes.map((note) => note.id === noteId
    ? {
        ...note,
        pinned: true,
        pinnedStartDate: resumedInterval ? note.pinnedStartDate : selectedDate,
        pinnedEndDate: null,
        updatedAt: timestamp,
      }
    : note)
  const visibleOrder = dailyNotesForDate(pinned, selectedDate).map((note) => note.id)
  return reorderDailyNotesForDate(
    pinned,
    [noteId, ...visibleOrder.filter((id) => id !== noteId)],
    selectedDate,
    now,
  )
}

export function toggleDailyNoteCompleted(
  notes: DailyNote[],
  noteId: string,
  selectedDate: string,
  now = new Date(),
): DailyNote[] {
  const target = notes.find((note) => note.id === noteId)
  if (!target) return notes
  const timestamp = now.toISOString()
  const completing = !target.completed
  const currentOrder = target.pinned
    ? dailyNotesForDate(notes, selectedDate).map((note) => note.id)
    : null
  const ordered = currentOrder
    ? reorderDailyNotesForDate(notes, currentOrder, selectedDate, now)
    : notes

  return ordered.map((note) => note.id === noteId
    ? {
        ...note,
        completed: completing,
        completedAt: completing ? timestamp : null,
        pinned: completing && note.pinned ? false : note.pinned,
        pinnedStartDate: completing && note.pinned
          ? note.pinnedStartDate ?? note.noteDate
          : note.pinnedStartDate,
        pinnedEndDate: completing && note.pinned ? selectedDate : note.pinnedEndDate,
        updatedAt: timestamp,
      }
    : note)
}
