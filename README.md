# 라먀니 게임즈

Ramyani Games(라먀니 게임즈)는 SOOP 방송 연동 게임을 한 저장소에서 제공하는 게임 허브 프로젝트입니다. GitHub Pages 루트는 게임 선택 랜딩 페이지로 사용하고, 각 게임은 `games/` 아래 독립 페이지로 분리합니다. 현재 첫 게임은 기존 웹 룰렛/티켓 발급기인 **먀로또**이며, Windows용 `RouletteBridge`를 통해 SOOP 별풍선 후원 기반 자동 발급도 지원합니다.

## 저장소 구조

브라우저 소스는 역할과 종류별로 묶습니다. 루트에는 GitHub Pages 및 Bridge가 직접 여는 HTML 진입점만 유지합니다.

```text
/
├─ index.html                 # Ramyani Games 랜딩 진입점
├─ hub/
│  └─ hub.css                 # 랜딩 스타일
├─ games/
│  ├─ lotto/
│  │  ├─ index.html           # 먀로또 진입점
│  │  ├─ css/                 # 먀로또 스타일
│  │  └─ js/                  # 먀로또 동작 코드
│  └─ board/
│     ├─ index.html           # 보드게임 프로토타입
│     ├─ css/                 # 16:9 루프 보드 스타일
│     └─ js/                  # 비동기 이동/바퀴/Phase 기반 엔진
├─ soop-admin.html            # Bridge 관리자 진입점
├─ soop-channel.html          # 채널 분석 진입점
├─ soop-overlay.html          # OBS 오버레이 진입점
├─ soop/
│  ├─ admin/                  # 관리자 CSS/JS
│  ├─ channel/                # 채널 분석 CSS/JS
│  └─ overlay/                # 오버레이 CSS/JS
├─ assets/                    # 공용 이미지/티켓 리소스
├─ bridge/                    # Java SOOP Bridge
├─ release/                   # 버전별 릴리스 노트
└─ .github/workflows/         # 빌드/패키징 자동화
```

## 주요 구성

현재 프로젝트는 게임 허브, 개별 게임 페이지, Windows Bridge로 구성됩니다.

### 1. GitHub Pages 게임 허브

- 루트 `index.html`: 게임 선택 랜딩 페이지
- `games/lotto/index.html`: 기존 먀로또 수동·자동 번호 발급 및 실시간 추첨
- 참가자 번호 등록 및 일치 결과 계산
- 브라우저 Canvas 기반 티켓 PNG 출력
- `games/board/`: 최소 8×6에서 가로/세로 칸 수를 확장할 수 있는 16:9 비동기 루프형 보드게임 프로토타입
- 별도 빌드 없이 GitHub Pages에서 실행 가능

### 보드게임 개발 기준

- 최소 보드 크기: 가로 8칸 × 세로 6칸, 외곽 24칸
- 가로/세로 칸 수는 사용자 설정값으로 확장 가능하며 외곽 칸 수는 `2×가로 + 2×(세로-2)`로 계산
- 데모 기본값: 가로 16칸 × 세로 12칸, 외곽 52칸
- 화면 기준: 16:9
- 칸 수가 늘어날수록 현재 플레이어 칸과 인접 칸의 확대 비율을 더 크게 적용하고 비활성 칸은 더 작게 조정
- 칸 수가 늘어날수록 칸 간 최소 간격도 함께 축소하여 강조 칸의 확대 공간을 확보
- v3 레이아웃은 모든 칸에 동일 종횡비를 강제하고, 확대/축소 시 가로·세로에 동일 배율을 적용
- 인접 칸 간 간격은 직선/코너 구분 없이 실제 회전 직사각형 외곽선 사이의 동일 gap을 기준으로 계산
- 플레이어 칸과 주변 칸은 고정 가중치 프로파일로 강조하고, 전체 둘레에서 gap을 제외한 남은 공간을 기준으로 비강조 칸의 공통 기본 크기를 계산
- 모든 칸은 하나의 연속된 둥근 사각형 루프를 따라 배치하며, 직선부는 margin을 제외한 화면 테두리에 정렬하고 코너 및 주변 칸은 셀 자체를 회전시키지 않은 채 중심 위치만 곡선을 따라 배치하여 글자와 토큰을 항상 정방향으로 유지
- 기존 구현은 `legacy.html`, 직전 v2 구현은 `v2.html`로 보존하고 기본 `index.html`은 `board-v3.js`/`board-v3.css`를 사용
- 보드게임 참가자는 최대 6명으로 제한하며, 주 사용 범위는 3~4명으로 가정
- v4 실험안은 강조 칸 크기를 먼저 예약한 뒤 전체 루프 길이에서 강조 칸 점유량과 동일 gap 총량을 제외하고, 남은 길이를 일반 칸에 균등 분배하는 reserve-first 방식을 사용
- P0 간격 규칙은 reserve-first 계산보다 우선하며, `0→1→...→END→START` 모든 순환 인접쌍의 실제 직사각형 외곽 간격이 하나의 동일 gap 값과 일치해야만 레이아웃을 승인
- v4는 기하학적 loop seam은 상단 직선 중앙에 유지하되, 논리적 0번 START를 좌상단 코너 슬롯에 순환 매핑하여 P0 gap 안정성과 시각적 시작 위치를 분리
- v4 플레이어 말은 셀 내부에서 매 스텝 재생성하지 않고 별도 player layer에 영속적으로 유지하며, 좌표/크기만 spring easing으로 갱신한다. 셀 확대/축소도 동일한 완화 곡선과 겹치는 전환 시간을 사용해 macOS Dock 계열의 연속적인 이동감을 목표로 한다.
- 참가자 반응형 크기는 3~4명 동시 배치에서 자연스럽게 보이도록 `1.42 → 1.20 → 1.04 → 0.94 → 0.90` 고정 국소 프로파일을 사용하고 전역 감쇠/고밀도 보정은 적용하지 않음
- 참가자별 진행은 독립적이며 공용 턴 없음
- 참가자별 이동 큐를 별도로 처리
- 시작 칸 통과 시 개인/전체 누적 바퀴 수 증가
- 전체 누적 바퀴 수를 기준으로 모든 플레이어에게 동시에 Board Phase를 전환할 수 있는 구조
- 승리/완주 조건 없이 운영자가 종료할 때까지 루프 진행
- 현재 프로토타입은 SOOP 후원 연동 전 로컬 주사위 테스트 기능 포함

### 2. SOOP 자동발급 / Windows Bridge

- SOOP 스트리머 ID 기준 현재 방송 자동 조회
- 채팅 서버 연결 및 `SEND_BALLOON` 후원 이벤트 수신
- 후원자별 별풍선 누적
- 기본값 `50개 = 티켓 1장`
- 한 번에 여러 장 조건을 충족하면 필요한 수만큼 자동 할당
- 티켓마다 `1~28` 중 서로 다른 번호 7개를 먼저 확정해 SQLite에 저장
- 확정된 번호로 방송용 룰렛 연출 실행
- 룰렛 완료 후 티켓 PNG 생성 및 로컬 폴더 자동 저장
- 후원자별 발급 번호·이미지 기록 유지
- 프로그램/OBS 재시작 시 미완료 티켓을 같은 번호로 복구
- SQLite 백업, 수동 누적 보정, 발급 기록 manifest 재생성 지원
- Windows 시스템 트레이에서 백그라운드 실행
- 관리자 페이지에서 `config.json` 편집 및 저장
- 재시작이 필요한 설정은 브리지 자동 재실행
- 관리자 페이지와 OBS 오버레이의 재연결 복구

## Windows 배포본

Windows에서는 GitHub Releases의 최신 `RouletteBridge-Windows-x64-v0.1.13.zip`을 받아 압축을 푼 뒤 `RouletteBridge.exe`를 실행합니다.

별도 Java 설치는 필요하지 않습니다. Java 25 기반 런타임이 배포본에 포함됩니다.

배포 구조는 다음과 같습니다.

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
├─ restart-bridge.ps1
├─ README.txt
├─ app/
├─ runtime/
├─ web/
├─ data/
├─ tickets/
└─ backups/
```

`data/`, `tickets/`, `backups/`는 운영 데이터이므로 프로그램을 업데이트할 때 삭제하거나 덮어쓰지 않습니다. 이미 수정해서 사용 중인 `config.json` 역시 새 배포본으로 교체하지 않고 유지하는 것을 권장합니다.

내부 로그는 실행 시 별도 `logs/` 폴더에 기록되며 Windows에서는 해당 폴더를 숨김 속성으로 처리합니다. 트레이나 관리자 페이지에 로그 폴더를 여는 메뉴는 제공하지 않습니다.

### 최초 실행

배포용 `config.json`의 `streamerId`는 비어 있습니다. 최초 실행 시 SOOP 연결을 시도하지 않고 관리자 페이지를 자동으로 엽니다. 사용자는 브라우저의 관리자 페이지에서 스트리머 ID와 필요한 설정을 입력하고 `config.json 저장`을 누르면 됩니다.

스트리머/SOOP 연결 설정은 가능한 범위에서 즉시 적용합니다. 티켓 규칙, 서버 포트, 저장 경로처럼 현재 프로세스의 서비스 구성을 다시 만들어야 하는 설정은 저장 후 `restart-bridge.ps1`을 통해 `RouletteBridge.exe`가 자동으로 재실행됩니다. 사용자가 EXE를 직접 다시 실행할 필요는 없습니다.

### 시스템 트레이 동작

배포 EXE는 콘솔 창을 띄우지 않고 Windows 알림 영역(System Tray)에서 동작합니다.

- 트레이 아이콘 더블클릭: 관리자 페이지 열기
- `상태`: SOOP 연결 상태 표시
- `관리자 페이지 열기`
- `OBS 오버레이 열기`
- `SOOP 재연결`
- `종료`: SOOP/HTTP/WebSocket을 정상 종료하고 프로그램 종료

트레이를 사용할 수 없는 환경에서는 관리자 페이지를 여는 방식으로 fallback합니다.

### 기본 config.json

```json
{
  "streamerId": "",
  "ticket": {
    "balloonsPerTicket": 50,
    "numberMax": 28,
    "numberCount": 7
  },
  "server": {
    "host": "127.0.0.1",
    "port": 17820,
    "websocketPort": 17821,
    "openBrowserOnStart": false
  },
  "storage": {
    "databasePath": "./data/roulette.db",
    "ticketDirectory": "./tickets",
    "webRoot": "./web",
    "backupDirectory": "./backups",
    "logDirectory": "./logs"
  },
  "soop": {
    "enabled": true,
    "offlinePollSeconds": 30
  }
}
```

관리 페이지에서 위 설정을 직접 수정할 수 있습니다.

## SOOP 연결

방송 정보 조회 후 채팅 연결은 `JOIN_CHANNEL` 이벤트를 최종 연결 완료 기준으로 사용합니다. `채팅 연결 중` 상태에서 30초 안에 JOIN 완료가 확인되지 않으면 연결 실패로 전환하고 클라이언트를 정리한 뒤 자동 재시도합니다. 따라서 채팅 연결 상태에 무기한 머무르지 않도록 처리합니다.

## SOOP 자동발급 흐름

```text
SOOP 별풍선 이벤트
        ↓
후원자별 누적 반영
        ↓
50개마다 신규 티켓 할당
        ↓
7개 번호 확정 + SQLite 저장
        ↓
OBS 오버레이에 ticket.issue 전송
        ↓
7개 릴 회전 및 순차 정지
        ↓
룰렛 완료
        ↓
티켓 PNG 생성
        ↓
Java Bridge로 PNG 업로드
        ↓
tickets/<닉네임_후원자ID>/ 저장
        ↓
DB 상태 ISSUED + issued.json 갱신
```

번호는 룰렛 표시 전에 서버 측에서 확정·저장합니다. 따라서 OBS 새로고침이나 프로그램 재실행이 발생해도 이미 화면에 표시된 티켓의 번호를 새로 추첨하지 않습니다.

티켓 상태는 다음 순서로 관리됩니다.

```text
PENDING
→ NUMBERS_CONFIRMED
→ ROULETTE_RUNNING
→ ROULETTE_COMPLETED
→ IMAGE_SAVED
→ ISSUED
```

`FAILED` 상태는 자동 복구 대상에서 제외합니다.

## OBS 방송용 페이지

Windows Bridge 실행 후 OBS Browser Source에는 기본적으로 다음 주소를 사용합니다.

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

관리 페이지의 `OBS 오버레이 주소` 영역에서 현재 설정에 맞는 주소를 확인하고 복사할 수 있습니다.

방송용 페이지는 기존 `index.html`과 독립되어 있습니다.

- 평상시 투명 배경
- 후원자 닉네임 표시
- 룰렛 회전
- 7개 릴 순차 확정
- 최종 티켓 표시
- 발급 완료 후 다음 티켓 처리
- 다수 티켓은 FIFO 큐로 순차 재생
- 하단 선택번호 구슬, `roulette-progress`, `ticket-id`, 디버그 패널은 최종 오버레이에서 표시하지 않음

브리지 프로세스가 종료되거나 설정 적용을 위해 자동 재시작되는 동안 열려 있는 오버레이는 WebSocket을 내부적으로 재연결합니다. 방송 화면에는 `연결 끊김`, `재연결 중`, `다시 연결됨` 같은 상태 문구를 표시하지 않습니다. 서버/API 포트가 변경되는 자동 재시작에서는 새 연결 주소를 전달받아 이후 연결과 PNG 업로드에 사용합니다.

GitHub Pages에서 오버레이 외형만 확인할 수도 있지만 실제 자동 PNG 저장과 운영 데이터 처리는 로컬 Windows Bridge를 사용하는 구성을 기준으로 합니다.

## 발급 데이터와 티켓 저장

SQLite `data/roulette.db`가 운영 데이터의 원본입니다.

주요 데이터:

- 후원자 SOOP 사용자 ID
- 현재 닉네임
- 누적 별풍선
- 할당 티켓 수
- 최종 발급 완료 티켓 수
- 수신 후원 이벤트 및 중복 방지 키
- 티켓 ID
- 후원자별 발급 순번
- 발급 당시 닉네임
- 확정 번호 7개
- 상태
- 이미지 경로
- 발급 시각

티켓 이미지는 예를 들어 다음과 같이 저장됩니다.

```text
tickets/
└─ 라먀니_abc123_<hash>/
   ├─ 0001_T..._03-07-11-16-22-25-28.png
   ├─ 0002_T..._01-04-09-13-18-24-27.png
   └─ issued.json
```

닉네임이 변경되더라도 내부 동일성은 안정적인 SOOP 사용자 ID를 기준으로 유지하며 각 티켓에는 발급 당시 닉네임을 별도로 기록합니다.

`issued.json`은 사람이 확인하기 위한 보조 기록이며 SQLite가 최종 원본입니다.

## 복구 및 운영 기능

Windows Bridge는 재시작 시 `ISSUED`가 아닌 미완료 티켓을 검색합니다.

- `NUMBERS_CONFIRMED`
- `ROULETTE_RUNNING`
- `ROULETTE_COMPLETED`
- `IMAGE_SAVED`

위 상태의 티켓은 기존 `ticketId`와 기존 7개 번호를 유지한 채 다시 처리할 수 있습니다.

### 관리자 페이지

```text
http://127.0.0.1:17820/soop-admin.html
```

관리 페이지는 3초 간격으로 상태와 후원자 목록을 갱신합니다. 후원자가 없으면 `등록된 후원자가 없습니다.`를 표시합니다.

브리지 프로세스가 내려가면 페이지는 닫히지 않고 `브리지 연결 대기`를 표시하면서 계속 확인합니다. 같은 포트로 다시 실행되면 잠시 `다시 연결됨`을 표시한 뒤 정상 상태로 돌아옵니다. 설정 변경으로 HTTP 포트가 바뀌는 자동 재시작의 경우 새 `/health`가 응답할 때까지 기다린 뒤 새 관리자 주소로 자동 이동합니다.

관리 페이지에서 지원하는 설정/운영 기능:

- `config.json` 편집 및 저장
- OBS 오버레이 주소 확인 및 복사
- `DB 백업`
- `issued.json 재생성`
- `수동 누적 보정`
- `테스트 티켓`
- 후원자 누적 확인

`테스트 티켓`은 Overlay WebSocket 클라이언트가 1개 이상 연결되어 있을 때만 활성화합니다. 연결 수가 0이면 버튼을 비활성화하고 연결 필요 안내를 표시합니다.

### 수동 누적 보정 사용자 자동 확인

수동 보정에서는 SOOP 사용자 ID 또는 현재 닉네임 중 하나만 입력해도 됩니다.

1. 먼저 로컬 SQLite의 기존 후원자 기록을 정확 일치로 검색합니다.
2. 유일하게 일치하면 ID 또는 닉네임의 상대 값을 자동으로 채웁니다.
3. 로컬 기록에 없는 신규 값이면 별도 SOOP 직접 조회 경로를 호출합니다.
4. 직접 조회에서도 ID/닉네임이 정확히 일치할 때만 자동 확정합니다.
5. 후보가 여러 개이거나 정확 일치가 없으면 임의 선택하지 않고 후보를 표시해 사용자가 확인하도록 합니다.

SOOP 직접 조회는 웹 검색 동작에 의존하는 best-effort 기능이므로 외부 변경으로 실패할 수 있습니다. 이 경우 ID와 닉네임을 모두 직접 입력할 수 있습니다.

운영용 로컬 API:

```text
GET  /api/admin/config
PUT  /api/admin/config
GET  /api/admin/donors
GET  /api/admin/donor-resolve?field=id|nickname|auto&value=...
GET  /api/admin/donor-lookup?field=id|nickname|auto&value=...
POST /api/admin/backup
POST /api/admin/manifests/rebuild
POST /api/admin/adjust
POST /api/admin/test-ticket
```

관리 API는 로컬 loopback 접근만 허용합니다.

주요 로컬 주소:

```text
http://127.0.0.1:17820/health
http://127.0.0.1:17820/api/state
http://127.0.0.1:17820/soop-admin.html
ws://127.0.0.1:17821
```

## 로그 및 한글

`config.json`, 로그 파일, manifest는 UTF-8 기반으로 저장합니다. 배포 EXE는 콘솔 창 없이 트레이에서 실행하며 내부 로그는 Windows에서 숨김 처리되는 로그 디렉터리에 기록합니다. 개발용 콘솔을 연결해 실행하는 경우에는 Windows 콘솔 인코딩 처리도 유지합니다.

## 검증 상태

현재 Windows CI에서 다음 항목을 검사합니다.

- Admin/Overlay JavaScript 문법 검사
- Java 25 Maven build
- Phase D 후원 누적 및 자동 티켓 할당
- 중복 후원 이벤트 차단
- `1~28 / 7개 / 중복 없음` 번호 검증
- Phase E PNG 저장
- SQLite `ISSUED` 상태 전환
- `issued.json` 생성 및 동일 PNG 재업로드 멱등성
- Phase F 재시작 복구
- 기존 번호 유지
- `FAILED` 자동복구 제외
- Windows `jpackage` GUI/Tray EXE 생성
- 내장 Java runtime 존재 확인
- `restart-bridge.ps1` 패키지 포함 확인
- 관리자 JS/CSS와 오버레이 재연결 자산 포함 확인
- 배포 `streamerId` 빈 값 확인
- 배포본에 `logs/`가 사전 생성되지 않는지 확인
- 패키지된 GUI EXE 자체 Phase F/encoding self-test

SOOP 연결 probe는 스트리머 ID를 명시적으로 전달하여 방송 정보 조회, BNO 조회, 채팅 서버 연결 및 `JOIN_CHANNEL` 경로를 검증할 수 있습니다. 실제 `SEND_BALLOON` payload의 최종 실방송 검증은 실제 후원 이벤트가 발생해야 완료할 수 있습니다.

---

# 기존 GitHub Pages 룰렛

## 화면 구성

오른쪽 컨트롤 영역은 두 탭으로 분리됩니다.

- `자동 번호 발급`: 기본 자동, 연속 자동, 사용자 지정 수동 티켓 출력
- `추첨기`: 모든 릴을 먼저 회전시킨 뒤 사용자가 한 번 누를 때마다 그 순간 새로운 번호를 하나씩 무작위 추첨

## 자동 번호 발급

### 기본

- 번호 범위와 발급 개수를 지정
- 이미지 클릭 또는 `Space` 1회: 모든 릴 회전 시작
- 다시 클릭 또는 `Space`: 왼쪽부터 순차 감속/확정
- 결과는 발급 기록에 저장

### 연속 자동

- 연속 실행 횟수를 `1~100회`로 지정
- 이미지 클릭 또는 `Space` 1회로 시작
- 기본 자동 번호 발급을 지정 횟수만큼 반복
- 각 회차 결과를 발급 기록에 저장
- 실행 중 다시 누르면 현재 회차를 마친 뒤 중지

### 수동 티켓 출력

수동 모드는 번호를 추첨하거나 릴을 회전시키는 모드가 아니라 **사용자가 지정한 번호로 티켓 PNG만 생성하는 모드**입니다.

- 발급 방식에서 `수동` 선택
- 티켓 시트 형식에 맞춰 `1~28` 중 서로 다른 번호 `7개` 사용
- 자동 번호 발급의 번호 범위/발급 개수 설정은 수동 모드에서 사용하지 않음
- 사용자 지정 번호 입력란에서 한 줄을 한 조합으로 인식
- 공백, 쉼표, 세미콜론, `/`로 번호 구분 가능
- 여러 줄을 입력하면 여러 조합을 한 번에 출력
- 한 번에 최대 100조합 지원
- 각 줄에 번호가 정확히 7개 있어야 하며 범위 초과·중복 번호는 거부
- `이미지 출력` 체크박스가 켜져 있어야 실행
- 이미지 클릭 또는 `Space` 1회로 입력된 모든 조합의 PNG 생성 시작
- 수동 모드에서는 릴을 돌리거나 순차 정지하지 않음
- 수동 번호는 자동 발급 기록에 추가하지 않음
- 각 조합마다 yellow / red / green / blue 시트 중 하나를 독립적으로 무작위 선택
- 마지막 수동 입력값과 수동 모드 선택은 `localStorage`에 유지

입력 예시:

```text
1 5 9 13 18 24 28
2 6 10 14 19 25 27
3 7 11 15 20 23 26
```

위 예시는 한 번 실행하면 티켓 PNG 3장을 생성합니다.

### 공통 설정

- 자동 발급 번호 범위 설정 가능
- 자동 발급 개수 `1~7` 설정 가능
- 중복은 항상 비허용
- 번호 범위, 발급 개수, 발급 방식, 연속 횟수, 수동 번호 입력값은 `localStorage`에 저장
- 자동 번호 생성에는 Web Crypto API 사용
- 최근 200회 자동 발급 기록
- 현재 결과 / 개별 기록 / 전체 기록 복사 시 번호만 복사
- `전체 복사`는 한 줄에 한 조합 형식
- 날짜와 시간은 저장·표시·복사하지 않음

## 티켓 PNG 출력

자동 번호 발급 탭의 `이미지 출력` 체크박스로 PNG 생성 여부를 선택합니다. 체크하지 않으면 기본/연속 자동 발급은 번호만 생성하며 이미지 파일은 만들지 않습니다.

현재 티켓 출력은 **숫자가 인쇄되지 않은 4색 `*2` 빈 시트**를 사용합니다.

```text
assets/Yellow2.png
assets/Red2.png
assets/Green2.png
assets/Blue2.png
assets/mask.png
assets/font.ttf
```

`ticket-renderer.js`는 모든 색상에 공통 `SHARED_GRID`와 `SHARED_SELECTED` 좌표를 사용합니다. `Yellow2 / Red2 / Green2 / Blue2`에는 1~28 숫자가 미리 인쇄되어 있지 않으며, 브라우저가 `assets/font.ttf`를 로드한 뒤 Canvas에서 숫자를 직접 합성합니다.

렌더링 순서는 다음과 같습니다.

1. 4색 빈 시트 중 한 장 선택
2. 닉네임 출력
3. `1~28` 기본 숫자를 동일한 폰트와 공통 좌표로 출력
4. 선택된 7개 번호 위치에 `assets/mask.png`를 배치
5. 마스크 위에 같은 폰트로 흰색 숫자를 다시 출력
6. 하단 `선택 번호` 7칸에 번호 출력
7. 최종 PNG 다운로드

상단 1~28 번호의 열 X 좌표와 하단 선택 번호 7칸의 X 좌표는 동일하게 사용합니다. 위치 수정이 필요하면 공통 좌표만 변경하면 모든 색상에 동시에 반영됩니다.

자동/연속 발급에서 티켓 이미지는 번호 범위가 정확히 `1~28`, 발급 개수가 `7개`인 경우에만 출력됩니다. 수동 모드는 시트 규격 자체가 `1~28 / 7개`로 고정됩니다.

브라우저에 따라 여러 PNG를 연속 다운로드할 때 최초 한 번 `여러 파일 다운로드 허용` 확인이 나타날 수 있습니다.

## 추첨기

추첨기 탭은 미리 정해 둔 번호를 순서대로 보여주는 방식이 아니라 **실시간 무작위 추첨 방식**입니다.

- 번호 범위와 추첨 개수를 별도로 지정
- 추첨 개수 `1~7` 지원
- 중복은 항상 비허용
- 추첨기 설정값은 `localStorage`에 저장
- 보너스 번호 기능 없음
- 첫 번째 이미지 클릭 또는 `Space`: 지정된 개수의 릴을 모두 회전 시작
- 이후 입력 1회마다 왼쪽 릴 하나만 정지
- 정지할 번호는 회전 시작 시 미리 만들지 않고 **해당 릴을 멈추는 입력이 발생한 순간 Web Crypto API로 새로 추첨**
- 이미 나온 번호는 후보에서 제외
- 7개 추첨 기준 총 8회의 입력으로 완료
- 한 릴이 감속 중일 때 추가 입력은 무시
- 완료된 실시간 추첨 번호는 자동 번호 발급 기록에 저장하지 않음

## 참가자 번호와 결과

추첨기 탭에서는 여러 사람의 번호를 등록해 한 번의 실시간 추첨 결과를 사람별로 동시에 판정합니다.

- `사람 추가` 버튼으로 참가자 추가
- 참가자마다 이름과 여러 번호 조합 입력 가능
- 한 줄을 한 조합으로 인식
- 공백·쉼표·세미콜론으로 번호 구분
- 한 조합 안의 중복 번호는 허용하지 않음
- 참가자 이름과 번호는 `localStorage`에 저장
- 추첨 시작 시 참가자 입력 영역 자동 접힘
- 추첨 완료 후 모든 참가자의 모든 조합을 검사
- 상세 카드에는 조합별 일치 개수와 일치 번호 표시
- 요약 영역은 `N개 일치` 그룹을 높은 순서부터 표시
- 동일 참가자가 서로 다른 일치 수의 조합을 보유하면 여러 그룹에 나타날 수 있음
- 추첨 완료 후 참가자 번호를 수정하면 현재 결과 기준으로 즉시 재계산

## 메인 이미지 전환

초기 화면은 다음 이미지를 순서대로 사용해 입이 열리는 전환을 보여줍니다.

```text
assets/image0.png
assets/image1.png
assets/image2.png
assets/image3.png
assets/Frame3.png
```

`image0~3`은 전환용 레이어이고, `Frame3.png`가 최종 메인 프레임입니다. 릴 Canvas는 프레임보다 낮은 레이어에 있어 입 영역을 통해서만 보입니다.

`assets/Frame.png`와 `assets/Frame2.png`는 현재 런타임에서는 사용하지 않지만 **프레임 원본/변형 자산으로 유지**합니다.

## 현재 자산 구조

```text
assets/
├─ Frame.png
├─ Frame2.png
├─ Frame3.png
├─ image0.png
├─ image1.png
├─ image2.png
├─ image3.png
├─ Yellow2.png
├─ Red2.png
├─ Green2.png
├─ Blue2.png
├─ mask.png
└─ font.ttf
```

## 코드 구조

```text
.
├─ index.html                     # 기존 GitHub Pages 룰렛
├─ styles.css
├─ draw-modes.css
├─ ticket-renderer.css
├─ live-draw.css
├─ stage-transition.css
├─ roulette-core.js
├─ roulette-draw.js
├─ ticket-renderer.js
├─ ticket-hook.js
├─ live-draw.js
├─ stage-transition.js
├─ roulette-ui.js
├─ soop-overlay.html              # 방송용 자동발급 오버레이
├─ soop-overlay.css
├─ soop-overlay-connection.js     # WebSocket 자동 재연결
├─ soop-overlay.js
├─ soop-overlay-archive.js        # PNG 업로드/상태 ACK 및 재시도
├─ soop-admin.html                # 로컬 관리 페이지
├─ soop-admin.css
├─ soop-admin.js
├─ bridge/                        # Windows Java Bridge
│  ├─ pom.xml
│  ├─ config.example.json
│  ├─ restart-bridge.ps1
│  ├─ package-windows.ps1
│  ├─ README.md
│  └─ src/
├─ assets/
├─ README.md
└─ .nojekyll
```

## 개발 실행

기존 브라우저 룰렛은 별도 빌드 과정이 없습니다.

```bash
python -m http.server 8080
```

Java Bridge 개발 실행은 다음과 같습니다.

```bash
cd bridge
mvn clean package
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar
```

또는 배포본에서는 `RouletteBridge.exe`를 직접 실행합니다. 배포본은 콘솔 창 대신 Windows 시스템 트레이에서 동작합니다.

- v4 Dock 영향 범위: 플레이어 칸 2.00×, ±1칸 1.42×, ±2칸 1.14×까지만 적용하며 ±3칸부터는 1.00× 일반 크기
