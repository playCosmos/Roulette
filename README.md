# 먀로또

`assets/Frame3.png`를 메인 프레임으로 사용하는 웹 룰렛/티켓 발급기입니다. 기존 GitHub Pages 수동 추첨 기능과 별도로, Windows용 `RouletteBridge`를 통해 SOOP 별풍선 후원을 감지하고 후원자별 누적에 따라 자동으로 룰렛을 실행한 뒤 티켓을 발급·저장할 수 있습니다.

## 주요 구성

현재 프로젝트는 두 실행 경로를 제공합니다.

### 1. GitHub Pages / 브라우저 룰렛

- 기존 `index.html` 기반 수동·자동 번호 발급
- 실시간 추첨기
- 참가자 번호 등록 및 일치 결과 계산
- 브라우저 Canvas 기반 티켓 PNG 출력
- 별도 빌드 없이 GitHub Pages에서 실행 가능

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

## Windows 배포본

Windows에서는 GitHub Releases의 `RouletteBridge-Windows-x64-v0.1.5.zip`을 받아 압축을 푼 뒤 `RouletteBridge.exe`를 실행합니다.

별도 Java 설치는 필요하지 않습니다. Java 25 기반 런타임이 배포본에 포함됩니다.

배포 구조는 다음과 같습니다.

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
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

`streamerId`에 실제 방송 대상 ID를 입력한 뒤 프로그램을 실행합니다. 값이 비어 있으면 SOOP 연결은 시작하지 않고 설정 대기 상태로 유지됩니다.

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

Windows Bridge 실행 후 OBS Browser Source에는 다음 주소를 사용합니다.

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

방송용 페이지는 기존 `index.html`과 독립되어 있습니다.

- 평상시 투명 배경
- 후원자 닉네임 표시
- 룰렛 회전
- 7개 릴 순차 확정
- 최종 티켓 표시
- 발급 완료 후 다음 티켓 처리
- 다수 티켓은 FIFO 큐로 순차 재생
- 하단 선택번호 구슬, `roulette-progress`, `ticket-id`, 디버그 패널은 최종 오버레이에서 표시하지 않음

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

운영용 로컬 API도 제공합니다.

```text
GET  /api/admin/donors
POST /api/admin/backup
POST /api/admin/manifests/rebuild
POST /api/admin/adjust
POST /api/admin/test-ticket
```

관리 API는 로컬 loopback 접근을 기준으로 하며 OBS 오버레이와 역할을 분리합니다.

관리 페이지:

```text
http://127.0.0.1:17820/soop-admin.html
```

관리 페이지는 3초 간격으로 상태와 후원자 목록을 갱신합니다. 후원자가 없으면 `불러오는 중` 상태를 유지하지 않고 `등록된 후원자가 없습니다.`를 표시합니다. 브리지나 API 오류가 발생하면 오류 상태를 화면에 표시합니다.

운영 도구 동작:

- `DB 백업`: 오버레이 연결과 무관하게 실행
- `issued.json 재생성`: 오버레이 연결과 무관하게 실행
- `수동 누적 보정`: 오버레이 연결과 무관하게 실행하며 감사 이력 기록
- `테스트 티켓`: Overlay WebSocket 클라이언트가 1개 이상 연결되어 있을 때만 활성화

OBS/오버레이 연결 수가 0이면 테스트 티켓 버튼을 비활성화하고 연결 필요 안내를 표시합니다. API를 직접 호출해도 모호한 무응답 대신 구체적인 오류를 반환합니다.

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

- Admin JavaScript 문법 검사
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
- 관리자 JS/CSS가 패키지에 포함되는지 확인
- 배포 config 구조 확인
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
├─ soop-overlay.js
├─ soop-overlay-archive.js        # PNG 업로드/상태 ACK
├─ soop-admin.html                # 로컬 관리 페이지
├─ soop-admin.css
├─ soop-admin.js
├─ bridge/                        # Windows Java Bridge
│  ├─ pom.xml
│  ├─ config.example.json
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
