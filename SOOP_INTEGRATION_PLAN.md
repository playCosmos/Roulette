# SOOP 별풍선 자동 티켓 발급 통합 계획

## 1. 목표

기존 `index.html` 기반 먀로또 페이지는 그대로 유지한다.

SOOP 방송용으로 별도의 오버레이 페이지와 Windows 브리지 프로그램을 추가하여 다음 흐름을 구현한다.

1. 스트리머 방송의 별풍선 후원 이벤트 수신
2. 후원자별 별풍선 누적
3. 누적 50개마다 티켓 1장 발급 대상 생성
4. 티켓 번호를 브리지에서 먼저 확정하고 SQLite에 저장
5. 방송 오버레이에서 룰렛 연출 시작
6. 1~28 범위에서 중복 없는 7개 번호를 왼쪽부터 순차 확정하는 것처럼 연출
7. 룰렛 연출 완료 후 후원자 닉네임이 들어간 티켓 표시
8. 티켓 PNG를 로컬 폴더에 자동 저장
9. 후원자별 누적 별풍선, 발급 번호, 티켓 이미지 경로, 발급 상태를 영구 저장
10. 프로그램을 재실행해도 누적값과 발급 이력을 그대로 복원

## 2. 기존 페이지 보존 원칙

- `index.html` 및 현재 수동/자동 추첨 기능은 변경하지 않는다.
- SOOP 전용 기능은 별도 파일로 분리한다.
- 공용 이미지 자산(`assets/Frame3.png`, 티켓 시트, mask, font)은 기존 파일을 재사용한다.
- SOOP 기능의 장애가 기존 GitHub Pages 추첨기에 영향을 주지 않도록 결합도를 낮춘다.

## 3. GitHub Pages 구성

### 기존

- `/index.html`: 현재 먀로또 메인 페이지

### 신규

- `/soop-overlay.html`: 방송용 자동 발급 오버레이
- `/soop-overlay.css`: OBS 투명 배경 및 룰렛/티켓 연출
- `/soop-overlay.js`: 이벤트 큐, 룰렛 순차 정지, 티켓 화면 렌더링, 브리지 인터페이스

최종 방송 화면에서는 다음 요소를 표시하지 않는다.

- 선택 번호 구슬 목록
- `roulette-progress`
- `ticket-id`
- 디버그 패널

### 테스트 주소

- `soop-overlay.html?debug=1`: 테스트 발급 기능 사용
- `soop-overlay.html?autotest=1`: 페이지 진입 후 자동으로 테스트 티켓 1장 실행

실제 방송 모드에서는 Windows 브리지의 로컬 HTTP 주소를 OBS Browser Source로 사용한다.

## 4. 티켓 이벤트 계약

오버레이에 전달하는 이벤트는 다음 형태를 기준으로 한다.

```json
{
  "type": "ticket.issue",
  "ticketId": "T1757862000000-3-a1b2c3d4",
  "donorId": "soop-user-id",
  "nickname": "후원자닉네임",
  "totalBalloons": 150,
  "ticketNumber": 3,
  "numbers": [3, 7, 11, 16, 22, 25, 28],
  "issuedAt": "2026-09-14T23:00:00Z"
}
```

### 중요 원칙

- 실제 발급 번호는 오버레이가 임의로 결정하지 않는다.
- Windows 브리지에서 티켓 레코드를 먼저 생성하고 번호를 확정·저장한 뒤 오버레이로 전달한다.
- 오버레이는 저장된 번호를 룰렛이 뽑는 것처럼 연출한다.
- OBS 새로고침 또는 오버레이 재접속으로 번호가 바뀌면 안 된다.
- WebSocket 전송보다 SQLite commit이 먼저 완료되어야 한다.
- 오버레이 전송이 실패해도 이미 확정된 티켓 번호는 DB에 유지한다.

## 5. 별풍선 누적 및 발급권 계산 규칙

기본값:

```text
50 별풍선 = 티켓 1장
```

후원자별로 다음 값을 관리한다.

- `totalBalloons`: 전체 누적 별풍선
- `allocatedTickets`: DB에 티켓 레코드가 생성되어 번호까지 할당된 티켓 수
- `issuedTickets`: PNG 저장과 최종 발급까지 완료된 티켓 수
- `remainderBalloons`: `totalBalloons - allocatedTickets * balloonsPerTicket`

발급 대상 계산은 다음을 사용한다.

```text
eligibleTickets = floor(totalBalloons / balloonsPerTicket)
newTickets = eligibleTickets - allocatedTickets
```

`issuedTickets`를 발급 대상 계산에 사용하지 않는다. 룰렛 또는 이미지 저장이 진행 중인 티켓이 아직 `ISSUED`가 아니더라도 이미 발급권을 소비했기 때문이다.

예:

```text
기존 누적 35
추가 후원 120
전체 누적 155
eligibleTickets = 3
allocatedTickets = 0
신규 티켓 = 3
잔여 = 5
```

누적값에서 별풍선을 직접 차감하는 방식 대신 전체 누적과 할당된 티켓 수를 기준으로 계산한다.

## 6. 후원자 식별

- 닉네임을 기본키로 사용하지 않는다.
- SOOP `SendBalloonEvent.senderId`를 `donorId`로 사용한다.
- 닉네임은 `senderNickname`을 현재 표시값과 발급 당시 스냅샷으로 저장한다.
- 닉네임이 변경되어도 같은 `donorId`라면 누적값은 이어진다.
- 티켓에는 후원자별 `ticket_sequence`를 별도로 기록하여 해당 후원자의 몇 번째 티켓인지 유지한다.

## 7. 중복 이벤트 방지

SOOP `SEND_BALLOON` 이벤트에서 현재 확인한 모델에는 안정적인 단일 이벤트 ID가 별도로 노출되지 않으므로 Phase D에서는 fallback fingerprint를 사용한다.

현재 fingerprint 입력:

```text
streamerId
+ donorId
+ balloonCount
+ fanOrder
+ rawPayload
```

위 값을 SHA-256으로 해시하여 `raw_hash`로 저장한다.

동일 후원자에서 동일 fingerprint가 30초 이내 다시 수신되면 replay로 보고 누적하지 않는다.

```text
최근 동일 raw_hash 존재
→ 중복 이벤트로 처리
→ totalBalloons 변경 없음
→ 신규 티켓 없음

신규 이벤트
→ DonationEvent 저장
→ 후원자 누적 갱신
→ 신규 티켓 필요 수 계산
```

이 정책은 재연결 직후 동일 패킷이 재수신되는 상황을 막기 위한 fallback이다. 실제 방송에서 `SEND_BALLOON` 원본 패킷을 확보한 뒤 더 안정적인 서버측 고유 필드가 확인되면 해당 필드 기반 dedup으로 교체한다.

## 8. 발급 상태 머신

티켓 한 장은 다음 순서로 처리한다.

```text
PENDING
  ↓
NUMBERS_CONFIRMED
  ↓
ROULETTE_RUNNING
  ↓
ROULETTE_COMPLETED
  ↓
IMAGE_SAVED
  ↓
ISSUED
```

Phase D에서는 신규 티켓을 생성할 때 바로 7개 번호를 확정하여 `NUMBERS_CONFIRMED`로 저장한다.

### 비정상 종료 복구

- `NUMBERS_CONFIRMED` 이후에는 같은 번호를 계속 사용한다.
- 룰렛 연출이 끝났지만 PNG 저장 전에 종료됐다면 같은 번호로 PNG 저장부터 다시 시도한다.
- `IMAGE_SAVED`인데 `ISSUED` 처리가 끝나지 않았다면 기존 이미지 경로를 확인한 뒤 발급 확정만 수행한다.
- 재실행 시 새로운 번호를 다시 추첨하지 않는다.
- 현재 Phase B/D에서는 재실행 시 미완료 티켓 검색까지 구현되어 있으며 실제 재전송/상태 재개는 Phase F에서 완성한다.

## 9. 로컬 영구 저장 구조

Windows 브리지 기준 권장 구조:

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
├─ data/
│  └─ roulette.db
├─ tickets/
│  ├─ 후원자닉네임_donorId/
│  │  ├─ T20260914-000001_03-07-11-16-22-25-28.png
│  │  └─ issued.json
│  └─ ...
├─ web/
│  └─ GitHub에서 동기화한 오버레이 자산
└─ logs/
```

### SQLite를 원본 데이터로 사용

#### Donor

- `donor_id`
- `current_nickname`
- `total_balloons`
- `issued_ticket_count`
- `created_at`
- `updated_at`

#### DonationEvent

- `event_id`
- `donor_id`
- `nickname`
- `balloon_count`
- `received_at`
- `processed_at`
- `raw_payload`
- `raw_hash`

#### Ticket

- `ticket_id`
- `donor_id`
- `nickname_at_issue`
- `ticket_sequence`
- `numbers_json`
- `status`
- `image_path`
- `source_event_id`
- `created_at`
- `updated_at`
- `issued_at`

`issued.json`은 사람이 쉽게 확인하기 위한 보조 출력물이며 원본 데이터는 SQLite로 한다.

DB schema는 Phase D에서 V2로 올라갔다. V1 DB는 실행 시 V2 migration을 적용한다.

## 10. 티켓 이미지 저장

최종 PNG는 브라우저의 일반 다운로드 기능에 의존하지 않는다.

권장 방식:

1. 브리지가 로컬 HTTP 서버를 실행한다.
2. GitHub에서 동기화한 `soop-overlay.html`을 로컬에서 서비스한다.
3. 오버레이 Canvas가 기존 티켓 시트와 폰트로 최종 PNG를 렌더링한다.
4. 렌더링된 PNG Blob을 로컬 브리지 API로 전달한다.
5. 브리지가 `tickets/<후원자>/...png`에 직접 저장한다.
6. 파일 저장 성공 후 DB의 티켓 상태를 `IMAGE_SAVED`로 변경한다.
7. 최종 발급 확정 후 `ISSUED`와 `issued_ticket_count`를 갱신한다.

이 방식은 현재 브라우저 Canvas 티켓 렌더링 결과와 로컬 저장 결과가 달라지는 문제를 피한다.

## 11. GitHub와 로컬 프로그램 관계

GitHub Pages는 브라우저 오버레이 소스와 업데이트 원본 역할을 한다.

Windows 브리지는 실행 시:

1. 로컬 DB 로드
2. 로컬 누적/발급 상태 복원
3. GitHub의 오버레이 버전 확인
4. 새 버전이 있으면 `web/` 자산 업데이트
5. 로컬 HTTP 서버 실행
6. SOOP 방송 상태 조회 및 연결
7. OBS는 `http://127.0.0.1:<port>/soop-overlay.html`을 Browser Source로 사용

방송 중 GitHub 장애나 인터넷 일시 장애가 발생해도 이미 받아 둔 로컬 오버레이와 DB는 계속 사용할 수 있게 한다.

GitHub 웹 자산 자동 동기화는 아직 미구현이며 Windows 패키징 전 단계에서 추가한다.

## 12. Windows 브리지 config

초기 최소 설정:

```json
{
  "streamerId": "STREAMER_ID",
  "ticket": {
    "balloonsPerTicket": 50
  },
  "server": {
    "port": 17820,
    "openBrowserOnStart": false
  }
}
```

현재 테스트용 `config.example.json`의 streamerId는 `20221010`으로 둔다.

고정 기본값:

- 티켓 번호 범위: 1~28
- 티켓 번호 수: 7개
- 중복 번호: 비허용
- SOOP offline poll: 30초

## 13. Java 브리지 책임

Java 브리지에서 담당할 기능:

- SOOP 방송 조회
- SOOP 채팅/후원 서버 연결
- 별풍선 이벤트 디코딩
- 자동 재연결
- 후원 이벤트 중복 제거
- 후원자별 누적 계산
- 티켓 필요 수 계산
- `SecureRandom` 기반 티켓 번호 확정
- 티켓 번호 DB 선저장
- 오버레이 이벤트 전달
- 최종 PNG 수신 및 폴더 저장
- 발급 상태 갱신
- 재실행 복구
- GitHub 오버레이 버전 확인 및 로컬 웹 자산 갱신

Phase D까지는 PNG 저장 이후 기능을 제외한 SOOP 수신 → 누적 → 번호 확정 → `ticket.issue` 전달 경로가 연결되어 있다.

## 14. 오버레이 책임

`soop-overlay.html`에서는 다음만 담당한다.

- 브리지에서 티켓 이벤트 수신
- 여러 장 발급 시 FIFO 대기열 처리
- 룰렛 시작
- 7개 릴 순차 정지
- 이미 확정된 7개 번호 표시
- 티켓 Canvas 렌더링
- 티켓 발급 연출
- 최종 PNG Blob을 브리지로 전달

별풍선 누적, 50개 판단, 발급 수 결정, 번호 생성, 영구 기록은 오버레이에서 하지 않는다.

## 15. 다량 후원 처리

예: 한 사용자가 500개를 한 번에 후원한 경우

```text
500 / 50 = 신규 티켓 10장
```

10장의 번호를 브리지에서 하나의 DB transaction 안에서 각각 생성·저장한 뒤 commit한다.

commit 이후 오버레이로 각 티켓의 `ticket.issue`를 순서대로 전달한다.

오버레이에서는 동시에 10장을 보여주지 않고 기존 FIFO 큐로 처리한다.

```text
Ticket 1 룰렛 → 이미지 발급
Ticket 2 룰렛 → 이미지 발급
...
Ticket 10 룰렛 → 이미지 발급
```

브라우저를 새로고침해도 아직 `ISSUED`가 아닌 티켓은 DB에 남는다. 실제 자동 재전송은 Phase F에서 구현한다.

## 16. 구현 단계

### Phase A — GitHub 오버레이 페이지

- [x] 기존 `index.html` 유지
- [x] `soop-overlay.html` 추가
- [x] 투명 OBS 페이지 구성
- [x] 7개 릴 순차 정지 구현
- [x] 닉네임 표시
- [x] 기존 티켓 시트 기반 화면 렌더링
- [x] FIFO 이벤트 큐
- [x] 테스트 모드
- [x] Java 브리지용 이벤트 진입점 정의
- [x] 최종 방송 화면의 선택번호 구슬/progress/ticket-id/debug panel 숨김
- [x] donor-banner 여백 및 Frame3 border-radius 조정

### Phase B — Java SOOP Bridge 기초

- [x] Java 프로젝트 생성
- [x] `config.json` 로더
- [x] 로컬 HTTP/WebSocket 서버
- [x] SQLite 초기 스키마 및 migration
- [x] 종료/재실행 시 DB 유지
- [x] 재실행 시 미완료 티켓 검색
- [ ] 미완료 티켓 상태별 실제 재처리

### Phase C — SOOP 연동

- [x] streamerId → 현재 방송 조회
- [x] 채팅 서버 접속
- [x] KEEP_ALIVE
- [x] 별풍선 이벤트 디코딩 코드 연결
- [x] 자동 재연결
- [x] `senderId` / `senderNickname` / `count` 어댑터 매핑
- [x] `streamerId=20221010` 실제 live detail 및 JOIN_CHANNEL 검증
- [ ] 실제 별풍선 후원 발생 시 `SEND_BALLOON` 실수신 캡처 검증

### Phase D — 자동 발급 엔진

- [x] 후원자별 누적
- [x] 50개 단위 신규 티켓 계산
- [x] `SecureRandom` 기반 티켓 번호 생성
- [x] `NUMBERS_CONFIRMED` 선저장
- [x] 후원자별 `ticket_sequence` 저장
- [x] 오버레이로 `ticket.issue` 전송
- [x] 한 후원에서 여러 장 생성 및 기존 Overlay FIFO 전달
- [x] fallback raw hash 기반 중복 이벤트 차단
- [x] SQLite transaction으로 Donation/Donor/Ticket 원자 처리
- [x] Phase D CI self-test

Phase D CI 검증 시나리오:

```text
30 후원        → total 30 / ticket 0 / remainder 30
+25 후원       → total 55 / ticket 1 / remainder 5
동일 이벤트 재전송 → duplicate / total 55 유지 / 신규 ticket 0
+120 후원      → total 175 / ticket 총 3 / 신규 2 / remainder 25
```

각 티켓은 1~28 범위의 중복 없는 7개 번호임을 검증한다.

### Phase E — 이미지 영구 저장

- [ ] 오버레이 Canvas → PNG Blob 생성
- [ ] 브리지 업로드 API 구현
- [ ] 닉네임별 폴더 생성
- [ ] PNG 파일명 규칙 적용
- [ ] `Ticket.image_path` 저장
- [ ] `issued.json` 생성/갱신
- [ ] 저장 실패 재시도
- [ ] `IMAGE_SAVED` / `ISSUED` 상태 전이

### Phase F — 복구/운영 기능

- [ ] 미완료 티켓 재처리
- [ ] 오버레이 재접속 시 미완료 티켓 재전송
- [ ] DB 백업
- [ ] 로그 파일
- [x] 기본 연결 상태 API
- [ ] 테스트 후원/테스트 티켓 관리 기능
- [ ] 수동 누적 보정 기능

### Phase G — Windows 패키징

- [ ] 자급식 Java runtime 구성
- [ ] Windows 실행 파일/설치 패키지 생성
- [ ] Java 사전 설치 없이 실행 검증
- [ ] config/data/tickets가 업데이트로 덮어써지지 않는지 검증
- [ ] GitHub 오버레이 버전 확인 및 로컬 web 자산 갱신

## 17. 완료 조건

다음 시나리오를 모두 통과하면 1차 완료로 본다.

1. 프로그램 최초 실행 후 streamerId만 설정하여 SOOP 방송 연결
2. A 사용자가 30개 후원 → 티켓 없음
3. A 사용자가 25개 추가 → 누적 55, 티켓 1장, 잔여 5
4. B 사용자가 120개 후원 → 티켓 2장, 잔여 20
5. A 사용자가 95개 추가 → 기존 잔여 포함 신규 티켓 2장
6. 동일 후원 이벤트 재수신 시 별풍선이 중복 누적되지 않음
7. 티켓 생성 시 7개 번호가 DB에 먼저 확정 저장됨
8. 티켓마다 룰렛이 먼저 실행되고 저장된 7개 번호가 순차 확정되는 것처럼 표시됨
9. 룰렛 종료 후 같은 번호의 티켓 이미지 표시
10. PNG가 후원자 폴더에 자동 저장
11. SQLite와 `issued.json`에서 닉네임별 발급 번호 확인 가능
12. 프로그램 종료/재실행 후 누적값과 발급 이력 유지
13. 재실행 시 미완료 티켓은 번호를 다시 추첨하지 않고 이어서 처리
14. 다량 후원으로 여러 장이 발생하면 모두 DB 선저장 후 Overlay FIFO로 순차 처리
15. 기존 `index.html` 페이지의 동작에는 변화가 없음
