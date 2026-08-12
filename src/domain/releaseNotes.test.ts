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

  it('renders cumulative versions and feature scopes as ordered headings with their own change lists', () => {
    expect(parseReleaseNotes(`## v0.3.1

[반복 일정 메뉴]
- 반복 일정 드래그 앤 드롭을 개선했습니다.
- 좌측 메뉴를 완전히 접을 수 있습니다.

## v0.3.2

[업데이트]
- 누적 업데이트 내역을 한 화면에서 확인할 수 있습니다.
- 다운로드한 업데이트를 자동 설치하고 다시 시작합니다.`)).toEqual([
      { kind: 'heading', level: 2, text: 'v0.3.1' },
      { kind: 'heading', level: 3, text: '반복 일정 메뉴' },
      {
        kind: 'list',
        ordered: false,
        items: [
          '반복 일정 드래그 앤 드롭을 개선했습니다.',
          '좌측 메뉴를 완전히 접을 수 있습니다.',
        ],
      },
      { kind: 'heading', level: 2, text: 'v0.3.2' },
      { kind: 'heading', level: 3, text: '업데이트' },
      {
        kind: 'list',
        ordered: false,
        items: [
          '누적 업데이트 내역을 한 화면에서 확인할 수 있습니다.',
          '다운로드한 업데이트를 자동 설치하고 다시 시작합니다.',
        ],
      },
    ])
  })
})
