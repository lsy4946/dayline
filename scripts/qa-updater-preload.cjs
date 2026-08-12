const { contextBridge } = require('electron')

const baseState = (status, patch = {}) => ({
  status,
  currentVersion: '0.2.1',
  availableVersion: null,
  releaseName: null,
  releaseNotes: null,
  progress: null,
  error: null,
  unsupportedReason: null,
  canCheck: !['checking', 'downloading', 'downloaded', 'installing'].includes(status),
  canDownload: status === 'available',
  canInstall: status === 'downloaded',
  ...patch,
})

const releasePatch = {
  availableVersion: '0.3.0',
  releaseName: 'Dayline 0.3.0',
  releaseNotes: `## 주요 변경

업데이트 화면에서 변경 사항을 더 읽기 쉽게 확인할 수 있습니다.

- 캘린더 일정 이동을 개선했습니다.
- **최근 삭제** 동작을 다듬었습니다.
- [릴리스 보기](https://example.invalid/release)는 안전한 텍스트로 표시됩니다.

### 세부 개선

1. 첫 번째 단계의 동작을 검증합니다.
2. 두 번째 단계의 동작을 검증합니다.

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

const initialMode = new URLSearchParams(location.search).get('updateQa')
let current = initialMode === 'available'
  ? baseState('available', releasePatch)
  : baseState('idle')
const listeners = new Set()
const calls = { check: 0, download: 0, install: 0 }
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
      return emit(baseState('downloaded', { ...releasePatch, progress: 100 }))
    },
    install: async () => {
      calls.install += 1
      return emit(baseState('installing', { ...releasePatch, progress: 100, canCheck: false }))
    },
    onStateChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
  __updateQa: {
    getCalls: () => ({ ...calls }),
    notAvailable: () => emit(baseState('not-available')),
  },
})
