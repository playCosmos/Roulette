# Roulette Bridge

Windows에서 실행되는 SOOP 자동 티켓 발급 브리지다. 현재 Phase B의 설정/SQLite/로컬 HTTP·WebSocket 기반, Phase C의 SOOP 연결, Phase D의 후원 누적·자동 티켓 할당, Phase E의 PNG 영구 저장까지 연결되어 있다.

## 요구 사항

- JDK 25+
- Maven 3.9+
- SOOP 연결: `getCurrentThread/soopapi` v0.14.0 (JitPack)

## 실행

```bash
cd bridge
mvn clean package
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar
```

첫 실행 시 `config.json`이 없으면 기본 설정 파일을 자동 생성한다. `streamerId`를 실제 스트리머 ID로 변경해야 SOOP 연결이 시작된다.

테스트용 예제 `config.example.json`에는 현재 검증 대상인 `20221010`이 들어 있다.

## 전체 동작

1. `streamerId`로 현재 방송 정보를 조회한다.
2. 방송 중이면 BNO와 채팅 서버 정보를 확인한다.
3. 인증 쿠키 없이 익명 읽기 전용 채팅 연결을 시작한다.
4. `SEND_BALLOON`을 `SoopDonation`으로 변환한다.
5. 후원자별 누적 별풍선을 SQLite에 transaction으로 반영한다.
6. `floor(totalBalloons / balloonsPerTicket)` 기준으로 필요한 신규 티켓 수를 계산한다.
7. 신규 티켓마다 번호를 먼저 확정하고 `NUMBERS_CONFIRMED`로 DB에 저장한다.
8. commit 후 `ticket.issue`를 Overlay WebSocket으로 보낸다.
9. 오버레이는 저장된 번호를 사용해 룰렛 연출 후 티켓 Canvas를 렌더링한다.
10. 렌더링된 PNG를 로컬 HTTP API로 업로드한다.
11. 브리지가 닉네임/후원자 ID별 폴더에 PNG를 저장하고 DB를 `ISSUED`로 전환한다.
12. 같은 폴더의 `issued.json`에 해당 후원자의 발급 번호와 이미지 목록을 갱신한다.

## SOOP Probe

브리지 전체를 실행하지 않고 특정 스트리머의 방송 조회와 채팅 JOIN만 검증할 수 있다.

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --probe 20221010
```

검증 범위:

- streamerId → 현재 BNO 조회
- live detail 조회
- 채팅 서버 연결
- `JOIN_CHANNEL` 수신

별풍선 이벤트 자체는 실제 후원이 발생해야 검증할 수 있으므로 probe 성공만으로 `SEND_BALLOON` 실수신까지 검증된 것으로 취급하지 않는다.

## Phase D Self-test

SOOP 실후원 없이 후원 누적/티켓 할당 규칙을 검증한다.

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-d-probe
```

검증 항목:

- 30개 후원 → 티켓 0장
- +25개 → 누적 55 / 티켓 1장 / 잔여 5
- 동일 이벤트 재전송 → 중복 차단
- +120개 → 누적 175 / 총 티켓 3장 / 잔여 25
- 각 티켓이 1~28 범위의 중복 없는 7개 번호인지 확인

## Phase E Self-test

PNG 영구 저장과 최종 발급 상태 전이를 검증한다.

```bash
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar --phase-e-probe
```

검증 항목:

- 티켓 PNG 파일 생성
- 닉네임/후원자별 폴더 생성
- `Ticket.image_path` 저장
- `ISSUED` 상태 전환
- `donor.issued_ticket_count` 증가
- `issued.json` 생성
- 동일 PNG 재업로드 시 중복 발급/중복 카운트 없음

## 설정

```json
{
  "streamerId": "20221010",
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
    "webRoot": "./web"
  },
  "soop": {
    "enabled": true,
    "offlinePollSeconds": 30
  }
}
```

## 로컬 주소

- HTTP: `http://127.0.0.1:17820/`
- 상태: `http://127.0.0.1:17820/health`
- 런타임 상태: `http://127.0.0.1:17820/api/state`
- Overlay WebSocket: `ws://127.0.0.1:17821`
- 티켓 PNG 업로드: `POST /api/tickets/{ticketId}/image` (`Content-Type: image/png`)

`/api/state`에는 현재 DB 경로, 티켓 저장 루트, pending ticket 수, WebSocket client 수, SOOP 연결 상태가 포함된다.

개발 중 `storage.webRoot`가 없고 저장소 루트의 `soop-overlay.html`을 찾을 수 있으면 자동으로 저장소 루트를 정적 웹 루트로 사용한다. 최종 Windows 패키지에서는 GitHub에서 동기화한 웹 자산을 `web/`에 두는 구조로 전환한다.

OBS 개발 테스트 주소 예시:

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

로컬 브리지에서 오버레이를 열면 `soop-overlay-archive.js`가 같은 origin의 HTTP API를 자동 사용한다. GitHub Pages에서 직접 연 오버레이는 자동 저장 API를 사용하지 않는다. 필요하면 `?api=http://127.0.0.1:17820`을 명시할 수 있지만 최종 운영은 로컬 페이지 사용을 기준으로 한다.

## 영구 데이터

`data/roulette.db`는 삭제하거나 프로그램 업데이트 시 덮어쓰지 않는다. SQLite의 `donor`, `donation_event`, `ticket` 테이블이 운영 원본 데이터다.

티켓 출력 예시:

```text
tickets/
└─ 저장테스트_phase-e-user_<hash>/
   ├─ 0001_T..._03-07-11-16-22-25-28.png
   └─ issued.json
```

실제 폴더명은 Windows 금지 문자를 안전한 문자로 치환하고, 동일 닉네임 충돌을 피하기 위해 donorId와 짧은 hash를 함께 사용한다.

`issued.json`에는 다음 정보가 들어간다.

- donorId
- 현재 닉네임
- 전체 누적 별풍선
- 최종 발급 완료 티켓 수
- 각 티켓의 후원자별 발급 순번
- ticketId
- 발급 당시 닉네임
- 확정 번호 7개
- PNG 파일명
- issuedAt

재시작 시 `ISSUED`가 아닌 티켓을 검색해 복구 대상 건수를 상태 API와 로그에 표시한다. 실제 미완료 티켓 자동 재전송/상태별 재개는 Phase F에서 완성한다.
