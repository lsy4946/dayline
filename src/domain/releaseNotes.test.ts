import { describe, expect, it } from 'vitest'
import { parseReleaseNotes } from './releaseNotes'

describe('release notes presentation', () => {
  it('preserves headings, paragraphs, and grouped lists', () => {
    expect(parseReleaseNotes(`## 주요 변경

설명이 이어집니다.

- 첫 항목
- **둘째 항목**

1. 첫 단계
2. 둘째 단계`)).toEqual([
      { kind: 'heading', level: 2, text: '주요 변경' },
      { kind: 'paragraph', text: '설명이 이어집니다.' },
      { kind: 'list', ordered: false, items: ['첫 항목', '둘째 항목'] },
      { kind: 'list', ordered: true, items: ['첫 단계', '둘째 단계'] },
    ])
  })

  it('keeps markdown links readable without creating interactive markup', () => {
    expect(parseReleaseNotes('[릴리스 보기](https://example.invalid/release)')).toEqual([
      { kind: 'paragraph', text: '릴리스 보기 — https://example.invalid/release' },
    ])
  })
})
