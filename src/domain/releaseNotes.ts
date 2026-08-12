export type ReleaseNoteBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

function readableInline(text: string) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 — $2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s*/, '')
    .trim()
}

export function parseReleaseNotes(notes: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = []
  const paragraph: string[] = []
  let list: Extract<ReleaseNoteBlock, { kind: 'list' }> | null = null

  const flushParagraph = () => {
    const text = readableInline(paragraph.join(' '))
    if (text) blocks.push({ kind: 'paragraph', text })
    paragraph.length = 0
  }
  const flushList = () => {
    if (list?.items.length) blocks.push(list)
    list = null
  }

  for (const rawLine of notes.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || /^[-*_]{3,}$/.test(line)) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const text = readableInline(heading[2])
      if (text) blocks.push({ kind: 'heading', level: heading[1].length <= 2 ? 2 : 3, text })
      continue
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/)
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    const listItem = unordered ?? ordered
    if (listItem) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) list = { kind: 'list', ordered: isOrdered, items: [] }
      const text = readableInline(listItem[1])
      if (text) list.items.push(text)
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}
