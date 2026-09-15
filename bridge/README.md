# Roulette Bridge

Windows에서 실행되는 SOOP 별풍선 자동 티켓 발급 브리지다. 기존 `index.html` 추첨 페이지와 분리되어 있으며 SOOP 이벤트 수신, 후원자별 누적, 자동 티켓 번호 확정, OBS 오버레이 룰렛 연출, PNG 영구 저장, 재실행 복구를 담당한다.

## Windows 배포본

최종 사용자는 Java를 별도로 설치할 필요가 없다. GitHub Actions의 `Windows Package` workflow가 JDK 25 `jpackage`로 self-contained app-image를 생성한다.

배포 루트:

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
├─ README.txt
├─ app/                 # 브리지 애플리케이션
├─ runtime/             # 내장 Java runtime
├─ web/                 # 로컬 OBS/admin 자산
├─ data/                # SQLite DB
├─ tickets/             # 발급 PNG + issued.json
└─ backups/             # DB backup
```

사용자는 `config.json`의 `streamerId`를 설정한 뒤 `RouletteBridge.exe`를 실행한다. `data/`, `tickets/`, `backups/`는 운영 데이터이므로 프로그램 업데이트 시 삭제하거나 덮어쓰지 않는다. 기존 `config.json`도 유지한다.

패키지된 실행 파일은 `jpackage.app-path`를 이용해 EXE가 있는 폴더를 application root로 사용한다. 따라서 EXE를 탐색기에서 더블클릭하거나 다른 working directory에서 실행해도 `config.json`과 운영 데이터 위치가 바뀌지 않는다.

### 시스템 트레이 실행

배포 EXE는 콘솔 창을 띄우지 않고 Windows 알림 영역(System Tray)에서 동작한다.

- 트레이 아이콘 더블클릭: 관리자 페이지 열기
- `상태`: SOOP 연결 상태 표시
- `관리자 페이지 열기`
- `OBS 오버레이 열기`
- `SOOP 재연결`
- `종료`: SOOP/HTTP/WebSocket을 정상 종료한 뒤 프로그램 종료

로그 폴더를 여는 메뉴는 제공하지 않는다. 내부 로그는 Windows에서 숨김 속성의 `logs/` 폴더에 UTF-8로 기록된다. 파일시스템이 DOS 숨김 속성을 지원하지 않는 경우에도 로깅 자체는 계속된다.

트레이를 사용할 수 없는 환경에서는 관리자 페이지를 여는 방식으로 fallback한다.

## 소스 개발 요구 사항

- JDK 25+
- Maven 3.9+
- SOOP 연결: `getCurrentThread/soopapi` v0.14.0 (JitPack)

소스 실행:

```bash
cd bridge
mvn clean package
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar
```

Windows portable app을 직접 만들려면 PowerShell에서 실행한다.

```powershell
cd bridge
./package-windows.ps1
```

생성 위치:

```text
bridge/dist/RouletteBridge/RouletteBridge.exe
bridge/dist/RouletteBridge/config.json
```

## 전체 동작

1. `streamerId`로 현재 SOOP 방송 정보를 조회한다.
2. 방송 중이면 BNO와 채팅 서버 정보를 확인하고 익명 read-only chat 연결을 시작한다.
3. `SEND_BALLOON`을 내부 `SoopDonation`으로 변환한다.
4. 후원자별 누적 별풍선을 SQLite transaction으로 반영한다.
5. `floor(totalBalloons / balloonsPerTicket)` 기준으로 신규 티켓 수를 계산한다.
6. 신규 티켓마다 1~28 범위의 중복 없는 7개 번호를 먼저 확정하여 DB에 저장한다.
7. DB commit 후 `ticket.issue`를 Overlay WebSocket으로 보낸다.
8. 오버레이는 저장된 번호를 사용해 룰렛을 먼저 실행하고 7개 릴을 순차 정지한다.
9. 룰렛 종료 후 같은 번호로 티켓 Canvas를 렌더링한다.
10. PNG를 로컬 bridge HTTP API로 전송한다.
11. 브리지가 닉네임/후원자 ID별 폴더에 PNG를 저장하고 티켓을 `ISSUED`로 전환한다.
12. 해당 발급 당시 닉네임 폴더의 `issued.json`을 갱신한다.
13. 프로그램 또는 OBS가 재시작되면 아직 `ISSUED`가 아닌 티켓을 같은 번호로 재전송한다.

## config.json

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

`streamerId`에 실제 방송 대상 ID를 입력한 뒤 프로그램을 실행한다. 값이 비어 있으면 SOOP 연결은 시작하지 않고 설정 대기 상태로 유지된다.

## 관리자 페이지

관리 페이지:

```text
http://127.0.0.1:17820/soop-admin.html
```

3초 간격으로 브리지 상태와 후원자 목록을 갱신한다.

상태 예시:

- 연결됨
- 방송 확인 중
- 채팅 연결 중
- 재연결 중
- 방송 대기
- 설정 필요
- 연결 실패/연결 오류

후원자가 한 명도 없으면 `불러오는 중`에 머물지 않고 `등록된 후원자가 없습니다.`를 표시한다. API 오류가 발생하면 해당 오류를 화면에 표시한다.

운영 도구:

- DB 백업
- `issued.json` 재생성
- 수동 별풍선 누적 보정
- 테스트 티켓

DB 백업, manifest 재생성, 수동 보정은 오버레이 연결 여부와 무관하다. 테스트 티켓은 실제 룰렛 연출을 보낼 Overlay WebSocket 클라이언트가 1개 이상 연결되어 있어야 한다. 연결 수가 0이면 버튼을 비활성화하고 연결 필요 안내를 표시하며, API도 명확한 오류를 반환한다.

## 로컬 주소

- Admin: `http://127.0.0.1:17820/soop-admin.html`
- Overlay: `http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821`
- Health: `http://127.0.0.1:17820/health`
- Runtime state: `http://127.0.0.1:17820/api/state`
- Overlay WebSocket: `ws://127.0.0.1:17821`
- Ticket PNG: `POST /api/tickets/{ticketId}/image`
- Admin API: `http://127.0.0.1:17820/api/admin/...` — loopback 전용

GitHub Pages의 `soop-overlay.html`은 화면 개발/미리보기 원본이고, 실제 방송에서는 EXE가 포함한 `web/` 자산을 localhost로 서비스한다. GitHub Pages 장애가 발생해도 이미 패키지된 overlay와 로컬 DB는 계속 사용할 수 있다.

## 영구 데이터와 복구

운영 원본은 `data/roulette.db`다. 주요 데이터는 `donor`, `donation_event`, `ticket`, `adjustment_event`에 저장한다.

티켓 상태는 다음 순서를 사용한다.

```text
NUMBERS_CONFIRMED
→ ROULETTE_RUNNING
→ ROULETTE_COMPLETED
→ IMAGE_SAVED
→ ISSUED
```

`FAILED` 티켓은 자동 복구 대상에서 제외한다. 그 외 미완료 티켓은 재실행 또는 overlay 재접속 시 DB에서 같은 `ticketId`와 같은 번호를 읽어 다시 전달한다. 번호를 다시 추첨하지 않는다.

티켓 출력 예시:

```text
tickets/
└─ 후원자닉네임_soopUserId_<hash>/
   ├─ 0001_T..._03-07-11-16-22-25-28.png
   └─ issued.json
```

닉네임이 변경되면 발급 당시 닉네임별 폴더와 manifest를 분리하지만, 누적 별풍선은 안정적인 SOOP 사용자 ID 기준으로 이어진다.

## Self-test

SOOP 실후원 없이 핵심 규칙을 검증할 수 있다.

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-d-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-e-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-f-probe
```

Phase D는 누적/중복 방지/티켓 할당을, Phase E는 PNG 저장 및 `issued.json`/멱등성을, Phase F는 재시작 복구/상태 전이/FAILED 제외/운영 데이터 기능을 검증한다.

SOOP 연결 probe:

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --probe <streamerId>
```

이 probe는 live detail, chat server 연결, `JOIN_CHANNEL`까지 검증한다. 실제 `SEND_BALLOON` payload의 최종 실방송 검증은 테스트 시간에 실제 별풍선 이벤트가 발생해야 완료할 수 있다.

## Windows CI 검증

`Windows Package` workflow는 다음을 모두 통과해야 artifact를 생성한다.

```text
Admin JavaScript syntax check
→ Maven build
→ Phase D/E/F self-test
→ jpackage GUI/tray app-image 생성
→ RouletteBridge.exe/config.json/bundled runtime 확인
→ 관리자 JS/CSS 패키지 포함 확인
→ 배포 config 구조 확인
→ 배포 ZIP에 logs/가 사전 생성되지 않았는지 확인
→ 패키지된 GUI EXE로 Phase F/encoding self-test 실행
→ RouletteBridge-Windows-x64 artifact 업로드
```

따라서 artifact의 `RouletteBridge.exe`는 외부 Java 설치 없이 포함된 runtime으로 실행되는 Windows tray 배포본이다.
