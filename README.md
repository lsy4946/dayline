# Dayline

Windows PC에서 오프라인으로 사용하는 캘린더 중심 To-Do 데스크톱 앱 프로토타입입니다. Electron과 React로 만들었으며, 인터넷이나 별도 서버 없이 일정 데이터와 위젯 위치를 기기에 저장합니다.

## 구현된 핵심 기능

- 월간 캘린더 위에 일정 칩 표시
- 날짜를 기본값으로 두고, 사용자가 `시간도 지정`을 켰을 때만 시간 입력 노출
- 일정 첫 클릭: 완료 처리 + 취소선 + 명확한 완료 색상
- 완료 일정 다음 클릭: 즉시 영구 삭제하지 않고 `최근 삭제`로 이동
- 빠른 더블클릭으로 완료와 삭제가 연달아 일어나지 않도록 700ms 보호
- 삭제 직후 실행 취소 및 완료 직후 되돌리기
- 삭제 시점부터 30일 동안 제목, 날짜, 시간, 완료 상태를 보존하고 원상 복구
- 별도 데스크톱 위젯 창
  - 창 이동, 가장자리 크기 조절
  - 위치·크기 잠금
  - 항상 위 고정 전환
  - 기본 크기와 화면 우측 상단 위치로 초기화
  - 마지막 위치·크기·고정 상태 자동 복원
  - 다중 모니터 구성이 바뀌어도 화면 안으로 위치 보정
- 메인 창과 위젯의 로컬 데이터 실시간 공유
- 로컬 JSON 파일의 임시 파일 교체 방식 저장
- 최초 실행용 예시 일정과 복구 예시 제공

## 개발 실행

요구 환경은 Windows 10/11과 Node.js 20 이상입니다.

```powershell
npm install
npm run build:icon
npm run dev
```

## 검증

```powershell
npm test
npm run build
npm run qa:capture
```

- `npm test`: 완료 → 최근 삭제 → 복구와 정확한 30일 경계 조건 검증
- `npm run build`: TypeScript 검사와 프로덕션 렌더러 빌드
- `npm run qa:capture`: 실제 Electron 렌더러를 메인/위젯 창 크기로 캡처해 `qa` 폴더에 저장

## Windows 설치 파일 만들기

```powershell
npm run dist:win
```

`release` 폴더에 다음 두 파일이 생성됩니다.

- `Dayline-Setup-0.1.0-x64.exe`: 설치 경로를 고를 수 있는 NSIS 설치 프로그램
- `Dayline-Portable-0.1.0-x64.exe`: 설치 없이 실행하는 포터블 프로그램

두 결과물 모두 Electron 런타임과 모든 화면 자산을 포함하므로 설치와 사용에 인터넷 연결이 필요하지 않습니다. 프로토타입은 코드 서명을 하지 않았기 때문에 다른 PC에서 처음 실행할 때 Windows SmartScreen 경고가 나타날 수 있습니다.

## 데이터 위치

설치 버전은 Electron의 Windows `userData` 폴더 아래에 다음 파일을 저장합니다.

- `dayline-data.json`: 활성 일정, 완료 일정, 최근 삭제 일정
- `dayline-window-state.json`: 위젯 위치, 크기, 항상 위, 잠금 상태

개발 실행 데이터는 `%APPDATA%\Dayline Dev`로 분리됩니다.

## 프로토타입 범위

현재 위젯은 사용성이 좋은 `항상 위` 또는 일반 창 모드입니다. Windows의 WorkerW에 붙어 모든 일반 창 뒤, 바탕화면 아이콘과 같은 레이어에 상주하는 네이티브 데스크톱 위젯은 Electron 기본 API가 아니므로 후속 Windows 네이티브 연동 범위로 남겨두었습니다.
