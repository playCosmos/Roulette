# Roulette Bridge

Windows에서 실행되는 SOOP 별풍선 자동 티켓 발급 브리지다. 기존 `index.html` 추첨 페이지와 분리되어 있으며 SOOP 이벤트 수신, 후원자별 누적, 자동 티켓 번호 확정, OBS 오버레이 룰렛 연출, PNG 영구 저장, 재실행 복구를 담당한다.

## Windows 배포본

최종 사용자는 Java를 별도로 설치할 필요가 없다. GitHub Actions의 `Windows Package` workflow가 JDK 25 `jpackage`로 self-contained app-image를 생성한다.

배포 루트:

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
├─ restart-bridge.ps1
├─ README.txt
├─ app/                 # 브리지 애플리케이션
├─ runtime/             # 내장 Java runtime
├─ web/                 # 로컬 OBS/admin 자산
├─ data/                # SQLite DB
├─ tickets/             # 발급 PNG + issued.json
└─ backups/             # DB backup
```

`data/`, `tickets/`, `backups/`는 운영 데이터이므로 프로그램 업데이트 시 삭제하거나 덮어쓰지 않는다. 기존 `config.json`도 유지한다. 내부 로그는 실행 시 숨김 `logs/` 폴더에 UTF-8로 기록되며 트레이와 관리자 UI에서는 로그 폴더를 노출하지 않는다.

패키지된 실행 파일은 `jpackage.app-path`를 이용해 EXE가 있는 폴더를 application root로 사용한다. 따라서 EXE를 탐색기에서 더블클릭하거나 다른 working directory에서 실행해도 `config.json`과 운영 데이터 위치가 바뀌지 않는다.

### 시스템 트레이 실행

배포 EXE는 콘솔 창을 띄우지 않고 Windows 알림 영역(System Tray)에서 동작한다.

- 트레이 아이콘 더블클릭: 관리자 페이지 열기
- `상태`: SOOP 연결 상태 표시
- `관리자 페이지 열기`
- `OBS 오버레이 열기`
- `SOOP 재연결`
- `종료`: SOOP/HTTP/WebSocket을 정상 종료한 뒤 프로그램 종료

트레이를 사용할 수 없는 환경에서는 관리자 페이지를 여는 방식으로 fallback한다.

## 최초 실행과 config.json

배포본의 `streamerId`는 비어 있다. 최초 실행 시 SOOP 연결을 시도하지 않고 관리자 페이지를 자동으로 연다. 사용자는 관리자 페이지에서 `config.json`을 직접 편집·저장할 수 있다.

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

적용 정책:

- `streamerId`, SOOP enabled, offline poll 변경: 저장 즉시 SOOP 연결에 적용
- 티켓 규칙 변경: 브리지 프로세스 재시작 필요
- HTTP/WebSocket 포트 또는 host 변경: 브리지 프로세스 재시작 필요
- DB/티켓/web/backup/log 경로 변경: 브리지 프로세스 재시작 필요

재시작이 필요한 설정은 사용자가 EXE를 다시 실행할 필요가 없다. `restart-bridge.ps1`가 현재 프로세스 PID가 완전히 종료될 때까지 기다린 뒤 같은 `RouletteBridge.exe`를 같은 application root에서 자동으로 다시 시작한다. 포트가 변경된 경우에도 관리자 페이지는 새 `/health` 주소를 확인한 뒤 새 관리자 주소로 자동 이동한다.

## 관리자 페이지

기본 주소:

```text
http://127.0.0.1:17820/soop-admin.html
```

관리 페이지 기능:

- SOOP 상태, 스트리머 ID, 미완료 티켓, Overlay 연결 수 표시
- `config.json` 전체 주요 항목 편집/저장
- OBS Browser Source 주소 표시 및 복사
- DB 백업
- `issued.json` 재생성
- 테스트 티켓
- 수동 별풍선 누적 보정
- 후원자 누적 목록

브리지가 종료되거나 재시작되면 페이지 자체는 열린 상태를 유지한다. `/api/state`가 응답하지 않는 동안 `브리지 연결 대기`를 표시하고 계속 폴링한다. 같은 포트에서 브리지가 다시 올라오면 잠시 `다시 연결됨`을 표시한 뒤 정상 상태로 복귀한다. 설정 변경으로 HTTP 포트가 변경된 자동 재시작의 경우 새 포트 `/health`가 응답할 때까지 기다렸다가 새 관리자 URL로 이동한다.

후원자가 한 명도 없으면 `불러오는 중`에 머물지 않고 `등록된 후원자가 없습니다.`를 표시한다.

### 수동 누적 보정 사용자 확인

수동 보정에서는 SOOP 사용자 ID 또는 현재 닉네임 중 하나만 입력해도 된다.

조회 순서:

```text
입력값
  ↓
GET /api/admin/donor-resolve
  ↓ 기존 SQLite donor 정확 일치 검색
  ├─ 유일한 일치 → 상대 ID/닉네임 자동 입력
  └─ 없음 → GET /api/admin/donor-lookup
                  ↓ SOOP 직접 검색
                  ├─ 정확 일치 → 상대 값 자동 입력
                  └─ 정확 일치 없음/복수 후보 → 자동 확정하지 않음
```

직접 검색 경로는 별도 API로 분리되어 있다. SOOP 검색 결과의 ID/닉네임이 입력값과 정확히 일치할 때만 자동 선택한다. 후보가 여러 개이거나 정확 일치가 없으면 후보만 표시하고 사용자가 확인하도록 한다. 외부 검색 경로는 SOOP 웹 검색 동작에 의존하므로 변경될 수 있으며, 실패 시 ID와 닉네임을 모두 직접 입력할 수 있다.

관리 API:

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

관리 API는 loopback 접근만 허용한다.

## 보드게임 룸 서버 기초

보드게임 룸 설정은 전역 `config.json`과 분리하여 SQLite에 저장한다. DB schema v6는 룸/참가자 설정과 참가자 방송 상태뿐 아니라 보드 런타임 상태·플레이어 위치·처리 이벤트까지 영속화한다.

현재 구현된 룸 API:

```text
POST /api/board/rooms
GET  /api/board/rooms/{roomId}
POST /api/board/rooms/{roomId}/preview/reroll
POST /api/board/rooms/{roomId}/preview/commit
GET  /api/board/rooms/{roomId}/runtime
```

룸 API는 loopback 접근만 허용한다.

룸 생성 시 서버가 검증·정규화하는 항목:

- 참가자 1~6명
- 참가자별 SOOP ID와 정확 일치 별풍선 trigger
- 룸 생성 시 각 참가자의 SOOP ID를 병렬 조회하여 현재 방송 상태를 `LIVE / OFFLINE_OR_UNAVAILABLE / CHECK_FAILED`로 기록
- `LIVE`이면 방송 BNO와 제목을 함께 저장하며, 방송 중이 아니거나 조회가 실패해도 룸 생성 자체는 차단하지 않음
- 관리자 페이지의 `보드게임 룸 생성` 패널에서 참가자·후원 trigger·보드 형상·이동 방식·지시문 배치·랜덤 풀을 설정
- 룸 생성 응답의 참가자 방송 상태를 `방송 중 / 오프라인 / 확인 실패`로 표시
- 서버가 저장한 preview를 실제 `games/board` 렌더러로 iframe에 표시하고 `다시 배치 / 이 배치로 확정`을 같은 화면에서 수행
- 보드 sizing: `dimensions` 또는 `cellCount`
- 보드 외곽 형상: `rounded` 또는 `rect`
- 이동값 생성 방식: `dice` 또는 `yut`
- 주사위는 D6 고정, 1~2개
- 더블 추가 던지기, 윷/모 추가 던지기 설정
- 지시문 배치: 고정 수량(`count`) 또는 비율(`ratio`)
- 비율 지시문은 기본 랜덤 변경 후보 풀에 자동 포함되며 원래 비율을 weight로 상속
- 사용자 지정 랜덤 풀 지원
- `N칸 전진/후진`의 range형 steps는 프리뷰 생성 시 현재 값을 확정
- START는 항상 `NORMAL`, locked, reroll 불가
- 프리뷰 `reroll`은 새 seed로 위치와 가변 값을 다시 생성
- 프리뷰 `commit` 이후 룸은 `READY`가 되며 전체 재배치를 차단

현재 룰 기본값은 이동 중 경유 칸 지시문을 실행하지 않는 `destinationOnly`이다. 최종 도착 칸 지시문을 먼저 모두 처리한 뒤 보너스 던지기를 진행하며, `다음 던지기 스킵`은 아직 실행하지 않은 가장 가까운 던지기 1회를 소비하므로 더블/윷/모로 생긴 즉시 보너스 던지기도 취소할 수 있다.

룸을 READY로 확정한 뒤 SOOP `SEND_BALLOON`이 들어오면 참가자 SOOP ID와 별풍선 수가 모두 정확히 일치하는 READY 룸을 찾는다. 서버가 주사위/윷 결과를 먼저 확정하고 SQLite에 `board.turn` 이벤트, 플레이어 위치, skip 카운터, 동적 보드 상태를 원자적으로 저장한 뒤 WebSocket으로 방송한다.

런타임 처리 순서:

```text
SEND_BALLOON
→ READY 룸에서 참가자 SOOP ID + 정확 balloonTrigger 매칭
→ SOOP event id 우선 중복 방지, event id 미노출 시 raw fingerprint fallback
→ 서버 RNG로 주사위/윷 결과 확정
→ 최종 도착 칸으로 이동
→ 경유 칸 지시문은 실행하지 않음
→ 최종 도착 칸 지시문 처리
→ skip/extra-throw 상태 반영
→ 남은 보너스 던지기가 있을 때만 다음 throw 확정
→ 전체 turn을 DB commit
→ board.turn WebSocket 전송
```

더블/윷/모의 추가 던지기는 현재 이동과 최종 도착 칸 지시문 처리가 끝나기 전에 실행되지 않는다. 도착 칸의 `다음 던지기 스킵`이 대기 중 보너스 던지기를 소비하면 해당 추가 던지기는 생성되지 않는다. 동적 칸은 실제 점유가 1명 이상에서 0명으로 바뀔 때만 랜덤 후보 풀에서 다시 선택하며 START는 제외된다.

보드 OBS 주소는 READY 확정 후 관리자 화면에서 복사하거나 새 창으로 열 수 있다. 보드 클라이언트는 서버의 `board.turn` 순번대로 재생하고 클라이언트에서 결과를 재추첨하지 않는다. WebSocket 재연결 시 `/runtime`을 다시 읽어 현재 플레이어 위치와 동적 보드 상태로 복구한다.

## OBS 오버레이

기본 Browser Source 주소:

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

관리 페이지에서 현재 설정에 맞는 주소를 보여주고 복사할 수 있다.

열려 있는 오버레이는 브리지 프로세스가 종료되거나 자동 재시작되어 WebSocket이 끊겨도 내부적으로 재연결한다. 방송 화면에는 `연결 끊김`, `재연결 중`, `다시 연결됨` 같은 연결 상태 문구를 표시하지 않는다. 설정 변경으로 WebSocket/API 포트가 바뀌는 자동 재시작에서는 브리지가 재시작 제어 메시지로 다음 WebSocket/API 주소를 전달하고 오버레이가 새 주소를 사용한다.

PNG 완료 ACK와 이미지 업로드도 브리지 재시작 동안 재시도한다. 이미 번호가 확정된 티켓은 DB에서 같은 ticketId/번호를 복구하므로 재접속을 이유로 재추첨하지 않는다.

## SOOP 연결 상태

`SoopBridgeAdapter`는 `SOOPClient.add(streamerId)`로 비동기 채팅 연결을 시작하고 `JOIN_CHANNEL`을 최종 연결 완료 기준으로 사용한다. `JOIN_CHANNEL`이 30초 이내 오지 않으면 `CONNECTION_FAILED`로 전환하고 클라이언트를 정리한 뒤 설정된 주기에 따라 재시도한다. 따라서 `채팅 연결 중` 상태에 무기한 머물지 않는다.

## 전체 자동발급 동작

1. `streamerId`로 현재 SOOP 방송 정보를 조회한다.
2. 방송 중이면 BNO와 채팅 서버 정보를 확인하고 익명 read-only chat 연결을 시작한다.
3. `JOIN_CHANNEL` 완료 후 후원 이벤트를 대기한다.
4. `SEND_BALLOON`을 내부 `SoopDonation`으로 변환한다.
5. 후원자별 누적 별풍선을 SQLite transaction으로 반영한다.
6. `floor(totalBalloons / balloonsPerTicket)` 기준으로 신규 티켓 수를 계산한다.
7. 신규 티켓마다 1~28 범위의 중복 없는 7개 번호를 먼저 확정하여 DB에 저장한다.
8. DB commit 후 `ticket.issue`를 Overlay WebSocket으로 보낸다.
9. 오버레이는 저장된 번호를 사용해 룰렛을 실행하고 7개 릴을 순차 정지한다.
10. 같은 번호로 티켓 Canvas를 렌더링한다.
11. PNG를 로컬 bridge HTTP API로 전송한다.
12. 브리지가 닉네임/후원자 ID별 폴더에 PNG를 저장하고 티켓을 `ISSUED`로 전환한다.
13. 발급 당시 닉네임 폴더의 `issued.json`을 갱신한다.
14. 프로그램 또는 OBS가 재시작되면 아직 `ISSUED`가 아닌 티켓을 같은 번호로 재전송한다.

## 영구 데이터와 복구

운영 원본은 `data/roulette.db`다. 주요 데이터는 `donor`, `donation_event`, `ticket`, `adjustment_event`에 저장한다.

```text
NUMBERS_CONFIRMED
→ ROULETTE_RUNNING
→ ROULETTE_COMPLETED
→ IMAGE_SAVED
→ ISSUED
```

`FAILED` 티켓은 자동 복구 대상에서 제외한다. 그 외 미완료 티켓은 재실행 또는 overlay 재접속 시 DB에서 같은 `ticketId`와 같은 번호를 읽어 다시 전달한다.

티켓 출력 예시:

```text
tickets/
└─ 후원자닉네임_soopUserId_<hash>/
   ├─ 0001_T..._03-07-11-16-22-25-28.png
   └─ issued.json
```

닉네임이 변경되면 발급 당시 닉네임별 폴더와 manifest를 분리하지만, 누적 별풍선은 안정적인 SOOP 사용자 ID 기준으로 이어진다.

## 소스 개발 요구 사항

- JDK 25+
- Maven 3.9+
- SOOP 연결: `getCurrentThread/soopapi` v0.14.0 (JitPack)

```bash
cd bridge
mvn clean package
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar
```

Windows portable app:

```powershell
cd bridge
./package-windows.ps1
```

## Self-test

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-d-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-e-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-f-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --encoding-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --room-probe
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --board-runtime-probe
```

SOOP 연결 probe:

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --probe <streamerId>
```

## Windows CI 검증

`Windows Package` workflow는 다음을 모두 통과해야 artifact를 생성한다.

```text
Admin/Overlay JavaScript syntax check
→ Maven build
→ Phase D/E/F + encoding + board room + board runtime self-test
→ jpackage GUI/tray app-image 생성
→ RouletteBridge.exe/config.json/bundled runtime 확인
→ restart-bridge.ps1 포함 확인
→ admin/overlay/reconnect 자산 포함 확인
→ 배포 streamerId 빈 값 확인
→ 배포 ZIP에 logs/가 사전 생성되지 않았는지 확인
→ 패키지된 GUI EXE로 Phase F/encoding self-test 실행
→ Windows x64 artifact 업로드
```

따라서 artifact의 `RouletteBridge.exe`는 외부 Java 설치 없이 포함된 runtime으로 실행되는 Windows tray 배포본이다.
