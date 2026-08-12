const { contextBridge } = require('electron')

const baseState = (status, patch = {}) => ({
  status,
  currentVersion: '0.3.0',
  availableVersion: null,
  releaseName: null,
  releaseNotes: null,
  installedReleaseHistory: {
    state: 'no-baseline',
    fromVersion: null,
    toVersion: '0.3.0',
    releaseName: null,
    releaseNotes: null,
    recordedAt: null,
  },
  progress: null,
  error: null,
  unsupportedReason: null,
  canCheck: !['checking', 'downloading', 'downloaded', 'installing'].includes(status),
  canDownload: status === 'available',
  canInstall: status === 'downloaded',
  ...patch,
})

const releasePatch = {
  availableVersion: '0.3.2',
  releaseName: 'Dayline 0.3.2',
  releaseNotes: `## v0.3.1

[반복 일정]
- 반복 일정 템플릿을 캘린더로 드래그할 수 있습니다.

[좌측 메뉴]
- 좌측 메뉴를 완전히 접을 수 있습니다.
- **최근 삭제** 동작을 다듬었습니다.

## v0.3.2

[업데이트]
- 누적 변경 사항을 버전별로 표시합니다.
- 다운로드한 업데이트를 자동 설치하고 다시 시작합니다.
- [릴리스 보기](https://example.invalid/release)는 안전한 텍스트로 표시됩니다.

[보안 검증]

1. HTML은 실행하지 않고 텍스트로 표시합니다.
2. 링크는 클릭 요소가 아닌 읽을 수 있는 텍스트로 표시합니다.

<script>window.__unsafeReleaseNote = true</script>

긴 릴리스에서도 스크롤을 확인하기 위한 문단 01입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 02입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 03입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 04입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 05입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 06입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 07입니다.

긴 릴리스에서도 스크롤을 확인하기 위한 문단 08입니다.`,
}

const installedReleaseHistory = {
  state: 'ready',
  fromVersion: '0.3.0',
  toVersion: '0.3.2',
  releaseName: 'Dayline v0.3.2',
  releaseNotes: releasePatch.releaseNotes,
  recordedAt: '2026-08-12T03:30:00.000Z',
}

const unavailableInstalledReleaseHistory = {
  ...installedReleaseHistory,
  state: 'notes-unavailable',
  releaseNotes: null,
}

const initialMode = new URLSearchParams(location.search).get('updateQa')
let current = initialMode === 'available'
  ? baseState('available', releasePatch)
  : baseState('idle')
const listeners = new Set()
const calls = { check: 0, download: 0, install: 0, installArguments: null }
const store = {
  version: 4,
  revision: 0,
  tasks: [],
  dailyNotes: [],
  taskTags: [],
  settings: {
    sidebarSplit: 50,
    widgetSplit: 50,
    fontScale: 1,
    themeColor: '#255F4B',
  },
  taskTemplates: [],
  migrationWarning: null,
}

function emit(next) {
  current = { ...next }
  for (const listener of listeners) listener({ ...current })
  return { ...current }
}

contextBridge.exposeInMainWorld('dayline', {
  isDesktop: true,
  loadData: async () => structuredClone(store),
  applyStoreMutations: () => structuredClone(store),
  onDataChanged: () => () => {},
  updates: {
    getState: async () => ({ ...current }),
    check: async () => {
      calls.check += 1
      emit(baseState('checking', { canCheck: false }))
      await new Promise((resolve) => setTimeout(resolve, 40))
      return emit(baseState('available', releasePatch))
    },
    download: async () => {
      calls.download += 1
      emit(baseState('downloading', { ...releasePatch, progress: 37, canCheck: false }))
      await new Promise((resolve) => setTimeout(resolve, 90))
      emit(baseState('downloaded', { ...releasePatch, progress: 100 }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      calls.install += 1
      calls.installArguments = [true, true]
      return emit(baseState('installing', { ...releasePatch, progress: 100, canCheck: false }))
    },
    install: async () => {
      calls.install += 1
      calls.installArguments = [true, true]
      return emit(baseState('installing', { ...releasePatch, progress: 100, canCheck: false }))
    },
    onStateChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
  __updateQa: {
    getCalls: () => ({ ...calls }),
    getState: () => ({ ...current }),
    available: () => emit(baseState('available', releasePatch)),
    notAvailable: () => emit(baseState('not-available', { installedReleaseHistory })),
    unavailableHistory: () => emit(baseState('not-available', {
      installedReleaseHistory: unavailableInstalledReleaseHistory,
    })),
  },
})
