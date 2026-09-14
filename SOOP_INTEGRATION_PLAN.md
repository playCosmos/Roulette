# SOOP 별풍선 자동 티켓 발급 통합 계획

## 1. 목표

기존 `index.html` 기반 먀로또 페이지는 그대로 유지한다.

SOOP 방송용으로 별도의 오버레이 페이지와 Windows 브리지 프로그램을 추가하여 다음 흐름을 구현한다.

1. 스트리머 방송의 별풍선 후원 이벤트 수신
2. 후원자별 별풍선 누적
3. 누적 50개마다 티켓 1장 발급 대상 생성
4. 티켓 번호를 Java 브리지에서 먼저 확정하고 SQLite에 저장
5. 방송 오버레이에서 룰렛 연출 시작
6. 1~28 범위의 중복 없는 7개 번호를 왼쪽부터 순차 확정하는 것처럼 연출
7. 룰렛 종료 후 후원자 닉네임이 들어간 티켓 표시
8. 렌더링된 티켓 PNG를 로컬 브리지로 자동 전송
9. 브리지가 후원자별 폴더에 PNG와 `issued.json`을 저장
10. SQLite에 발급 상태와 이미지 경로를 영구 저장
11. 프로그램을 재실행해도 누적값, 번호, 발급 이력을 유지
12. 미완료 티켓은 새 번호를 만들지 않고 기존 확정 번호로 복구

## 2. 기존 페이지 보존 원칙

- `index.html` 및 기존 수동/자동 추첨 기능은 변경하지 않는다.
- SOOP 전용 기능은 별도 파일로 분리한다.
- 공용 이미지 자산(`assets/Frame3.png`, 티켓 시트, `mask.png`, `font.ttf`)은 재사용한다.
- SOOP 기능 장애가 기존 GitHub Pages 추첨기에 영향을 주지 않도록 결합도를 낮춘다.
- 오버레이의 표시 책임과 Java 브리지의 데이터/영구 저장 책임을 분리한다.

## 3. GitHub Pages / Overlay 구성

### 기존

- `/index.html`: 기존 먀로또 메인 페이지

### SOOP 전용

- `/soop-overlay.html`: 방송용 자동 발급 오버레이
- `/soop-overlay.css`: OBS 투명 배경 및 룰렛/티켓 연출
- `/soop-overlay.js`: FIFO 큐, 룰렛 순차 정지, 티켓 Canvas 렌더링, WebSocket 이벤트 수신
- `/soop-overlay-archive.js`: 렌더링된 PNG를 Java 브리지 저장 API로 업로드

최종 방송 화면에서는 다음 요소를 표시하지 않는다.

- 선택 번호 구슬 목록
- `roulette-progress`
- `ticket-id`
- 디버그 패널

추가 UI 조정:

- `donor-banner` 아래 여백 확대
- `Frame3.png` 외곽 `border-radius` 적용

### 테스트 모드

- `soop-overlay.html?autotest=1`: 테스트 티켓 1건을 자동 실행
- 내부 debug API는 유지하지만 최종 화면에서 debug panel은 숨김

최종 운영은 GitHub Pages 주소를 OBS에 직접 넣는 방식보다 Java 브리지가 로컬에서 서비스하는 주소를 기준으로 한다.

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

## 4. 티켓 이벤트 계약

Java 브리지가 오버레이에 전달하는 이벤트 기준:

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

### 원칙

- 실제 티켓 번호는 오버레이가 결정하지 않는다.
- Java 브리지에서 먼저 번호를 생성하고 DB commit을 완료한 후 WebSocket으로 전달한다.
- 오버레이는 이미 저장된 번호를 룰렛이 추첨하는 것처럼 연출한다.
- OBS 새로고침, WebSocket 재연결, 프로그램 재실행 때문에 번호가 바뀌면 안 된다.
- WebSocket 전송 실패가 번호/후원 누적 손실로 이어지지 않아야 한다.

## 5. 별풍선 누적 및 발급권 계산

기본값:

```text
50 별풍선 = 티켓 1장
```

후원자별 핵심 값:

- `totalBalloons`: 전체 누적 별풍선
- `allocatedTickets`: DB에 티켓 행이 생성되고 번호가 확정된 수
- `issuedTickets`: PNG 저장과 최종 발급까지 완료된 수
- `remainderBalloons`: `totalBalloons - allocatedTickets * balloonsPerTicket`

발급 대상 계산:

```text
eligibleTickets = floor(totalBalloons / balloonsPerTicket)
newTickets = eligibleTickets - allocatedTickets
```

`issuedTickets`를 신규 티켓 계산 기준으로 사용하지 않는다. 룰렛 또는 PNG 저장이 진행 중인 티켓도 이미 해당 50개의 발급권을 사용했기 때문이다.

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

## 6. 후원자 식별

- 닉네임을 기본키로 사용하지 않는다.
- SOOP `SendBalloonEvent.senderId`를 `donorId`로 사용한다.
- `senderNickname`은 현재 표시 이름과 발급 당시 스냅샷으로 저장한다.
- 닉네임이 바뀌어도 동일 `donorId`이면 누적값은 이어진다.
- 각 티켓에 후원자별 `ticket_sequence`를 저장하여 해당 사용자의 몇 번째 티켓인지 유지한다.

## 7. 중복 이벤트 방지

현재 확인한 `SendBalloonEvent` 모델에는 안정적인 단일 서버 이벤트 ID가 별도로 노출되지 않으므로 fallback fingerprint를 사용한다.

현재 fingerprint 입력:

```text
streamerId
+ donorId
+ balloonCount
+ fanOrder
+ rawPayload
```

SHA-256 결과를 `raw_hash`로 저장하고, 동일 후원자에서 동일 fingerprint가 30초 안에 다시 들어오면 replay로 보고 무시한다.

```text
최근 동일 raw_hash 존재
→ 누적 없음
→ 신규 티켓 없음

신규 이벤트
→ DonationEvent 저장
→ Donor 누적 갱신
→ 신규 Ticket 필요 수 계산
```

이 정책은 fallback이다. 실제 방송에서 원본 `SEND_BALLOON` 패킷을 확보해 더 안정적인 고유 식별 필드가 확인되면 해당 필드 기반 dedup으로 교체한다.

## 8. 발급 상태 머신

목표 상태 머신:

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

현재 구현 상태:

- Phase D: 신규 티켓 생성 시 바로 번호를 확정하고 `NUMBERS_CONFIRMED` 저장
- Phase E: PNG 업로드 시 파일 저장 후 `IMAGE_SAVED`를 거쳐 `ISSUED`로 확정
- `ROULETTE_RUNNING` / `ROULETTE_COMPLETED`의 실시간 DB 상태 기록은 아직 연결하지 않았으며 Phase F에서 복구 제어와 함께 처리

### 비정상 종료 원칙

- `NUMBERS_CONFIRMED` 이후에는 같은 번호만 사용한다.
- PNG 저장 전에 종료되면 같은 번호로 오버레이/렌더링을 다시 실행한다.
- 이미지 파일이 이미 존재하는 재요청은 멱등적으로 처리해야 한다.
- `ISSUED` 티켓의 동일 PNG 재업로드는 발급 수를 다시 증가시키지 않는다.

## 9. SQLite 및 로컬 저장 구조

권장 최종 구조:

```text
RouletteBridge/
├─ RouletteBridge.exe
├─ config.json
├─ data/
│  └─ roulette.db
├─ tickets/
│  ├─ 후원자닉네임_donorId_hash/
│  │  ├─ 0001_T..._03-07-11-16-22-25-28.png
│  │  ├─ 0002_T..._01-04-09-13-18-24-27.png
│  │  └─ issued.json
│  └─ ...
├─ web/
│  └─ 로컬 오버레이 자산
└─ logs/
```

실제 폴더명은 Windows에서 사용할 수 없는 문자를 안전하게 치환한다. 동일 닉네임 사용자 충돌을 피하기 위해 `donorId`와 짧은 hash를 함께 사용한다.

### Donor

- `donor_id`
- `current_nickname`
- `total_balloons`
- `issued_ticket_count`
- `created_at`
- `updated_at`

### DonationEvent

- `event_id`
- `donor_id`
- `nickname`
- `balloon_count`
- `received_at`
- `processed_at`
- `raw_payload`
- `raw_hash`

### Ticket

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

SQLite가 운영 원본 데이터다. `issued.json`은 사람이 폴더만 열어도 닉네임별 발급 번호와 이미지 관계를 확인할 수 있게 하는 보조 출력물이다.

DB schema는 Phase D에서 V2로 올라갔으며 기존 V1 DB는 실행 시 자동 migration한다.

## 10. 티켓 PNG 영구 저장

Phase E에서 구현 완료했다.

### 흐름

```text
Overlay Canvas 렌더링
  ↓
티켓 화면 표시 완료
  ↓
roulette-overlay:completed
  ↓
soop-overlay-archive.js
  ↓ PNG Blob
POST /api/tickets/{ticketId}/image
  ↓
TicketArchiveService
  ↓
PNG 파일 저장
  ↓
DB IMAGE_SAVED → ISSUED
  ↓
donor.issued_ticket_count +1
  ↓
issued.json 갱신
```

브라우저는 저장 경로나 닉네임을 지정하지 않는다. HTTP 요청은 `ticketId + PNG`만 전달하고, Java 브리지가 DB에서 `donorId`, 발급 당시 닉네임, 번호, 발급 순번을 다시 읽어 저장 경로와 파일명을 결정한다.

### 업로드 API

```text
POST /api/tickets/{ticketId}/image
Content-Type: image/png
```

제약:

- 최대 20 MiB
- PNG signature 검사
- 존재하지 않는 ticketId는 거부
- 경로 생성은 DB 값 기준
- 파일은 임시 파일 작성 후 atomic move를 우선 사용

### 파일명

```text
{ticket_sequence 4자리}_{ticketId}_{번호7개}.png
```

예:

```text
0003_T1757862000000-3-a1b2c3d4_03-07-11-16-22-25-28.png
```

### issued.json

후원자별 `issued.json`에는 다음을 저장한다.

- `donorId`
- 현재 닉네임
- 전체 누적 별풍선
- 최종 발급 완료 티켓 수
- 마지막 갱신 시각
- 각 티켓의 발급 순번
- ticketId
- 발급 당시 닉네임
- 확정 번호 7개
- PNG 파일명
- issuedAt

### 재시도/멱등성

- 오버레이 업로드는 최대 3회 시도
- 일시 오류는 backoff 후 재시도
- 명백한 4xx 오류는 반복하지 않음
- 동일 ticketId의 PNG가 다시 전송되어도 `issued_ticket_count`는 다시 증가하지 않음
- 이미 `ISSUED`인 티켓의 PNG 재요청은 파일/manifest를 복구하는 용도로 안전하게 재처리 가능

GitHub Pages에서 직접 열린 오버레이는 기본적으로 로컬 저장 API를 호출하지 않는다. 최종 운영의 로컬 브리지 페이지에서는 같은 origin을 자동 사용한다.

## 11. GitHub와 로컬 프로그램 관계

GitHub 저장소/Pages는 오버레이 소스와 업데이트 원본 역할을 한다.

최종 Windows 브리지는 다음 순서가 목표다.

1. 로컬 DB 로드
2. 누적/발급 상태 복원
3. GitHub의 웹 자산 버전 확인
4. 새 버전이 있으면 `web/` 자산 업데이트
5. 로컬 HTTP/WebSocket 서버 실행
6. SOOP 방송 조회 및 연결
7. OBS는 로컬 URL 사용

GitHub 웹 자산 자동 동기화는 아직 미구현이며 Phase G 전에 추가한다.

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

현재 테스트용 `config.example.json`의 streamerId는 `20221010`이다.

기본값:

- 티켓 번호 범위: 1~28
- 티켓 번호 수: 7개
- 티켓 내부 번호 중복: 비허용
- 별풍선 50개당 티켓 1장
- HTTP: 17820
- Overlay WebSocket: 17821
- SOOP offline poll: 30초

## 13. Java 브리지 책임

현재 담당:

- SOOP 방송 조회
- 채팅 서버 연결
- KEEP_ALIVE 및 재연결
- `SEND_BALLOON` 디코딩 어댑터
- 후원 이벤트 fallback dedup
- 후원자별 누적
- 신규 티켓 수 계산
- `SecureRandom` 기반 번호 확정
- SQLite 선저장
- Overlay `ticket.issue` 전송
- 최종 PNG 수신
- PNG 파일 저장
- `image_path` / `ISSUED` 갱신
- `issued_ticket_count` 갱신
- `issued.json` 생성/갱신
- 미완료 티켓 검색

향후 담당:

- 미완료 티켓 자동 재전송/복구
- 로그 파일
- DB 백업
- 운영 보정 API/UI
- GitHub web 자산 자동 동기화
- Windows 자급식 패키징

## 14. 오버레이 책임

`soop-overlay.html` 계열은 다음만 담당한다.

- `ticket.issue` 수신
- FIFO 큐
- 후원자 닉네임 표시
- 7개 릴 동시 회전
- 왼쪽부터 순차 정지
- 이미 확정된 번호 표시
- 티켓 Canvas 렌더링
- 최종 티켓 화면 표시
- 렌더링된 PNG Blob을 브리지 저장 API로 전달

오버레이에서 하지 않는 것:

- 별풍선 누적
- 50개 임계치 판단
- 신규 티켓 수 결정
- 실제 티켓 번호 생성
- 영구 DB 관리
- 저장 폴더 경로 결정

## 15. 다량 후원 처리

예: 한 사용자가 별풍선 500개를 한 번에 후원한 경우

```text
500 / 50 = 신규 티켓 10장
```

브리지는 하나의 DB transaction 안에서 10장의 번호를 각각 생성하고 `NUMBERS_CONFIRMED`로 저장한 후 commit한다.

commit 후 오버레이로 10개의 `ticket.issue`를 전달하며, 오버레이는 기존 FIFO로 순차 실행한다.

```text
Ticket 1 룰렛 → 티켓 표시 → PNG 저장
Ticket 2 룰렛 → 티켓 표시 → PNG 저장
...
Ticket 10 룰렛 → 티켓 표시 → PNG 저장
```

## 16. 구현 단계

### Phase A — GitHub 오버레이 페이지

- [x] 기존 `index.html` 유지
- [x] `soop-overlay.html` 추가
- [x] 투명 OBS 페이지
- [x] 7개 릴 순차 정지
- [x] 닉네임 표시
- [x] 기존 티켓 시트 기반 Canvas 렌더링
- [x] FIFO 이벤트 큐
- [x] 테스트 모드
- [x] Java 브리지 이벤트 진입점
- [x] 선택번호 구슬/progress/ticket-id/debug panel 숨김
- [x] donor-banner 여백 및 Frame3 border-radius 조정

### Phase B — Java SOOP Bridge 기초

- [x] Java 프로젝트
- [x] `config.json` 로더
- [x] 로컬 HTTP/WebSocket 서버
- [x] SQLite 초기 스키마 및 migration
- [x] 종료/재실행 시 DB 유지
- [x] 미완료 티켓 검색
- [ ] 미완료 티켓 상태별 실제 재처리

### Phase C — SOOP 연동

- [x] streamerId → 현재 방송 조회
- [x] 채팅 서버 접속
- [x] KEEP_ALIVE
- [x] 별풍선 이벤트 디코딩 코드 연결
- [x] 자동 재연결
- [x] `senderId` / `senderNickname` / `count` 어댑터 매핑
- [x] `streamerId=20221010` 실제 live detail + JOIN_CHANNEL 검증
- [ ] 실제 별풍선 발생 시 `SEND_BALLOON` 실수신 캡처 검증

### Phase D — 자동 발급 엔진

- [x] 후원자별 누적
- [x] 50개 단위 신규 티켓 계산
- [x] `SecureRandom` 번호 생성
- [x] `NUMBERS_CONFIRMED` 선저장
- [x] 후원자별 `ticket_sequence`
- [x] Overlay `ticket.issue` 전송
- [x] 한 후원에서 여러 장 생성
- [x] fallback raw hash dedup
- [x] Donation/Donor/Ticket transaction
- [x] Phase D CI self-test

Phase D 검증:

```text
30 후원          → total 30 / ticket 0 / remainder 30
+25 후원         → total 55 / ticket 1 / remainder 5
동일 이벤트 반복 → duplicate / total 55 유지
+120 후원        → total 175 / ticket 총 3 / 신규 2 / remainder 25
```

각 티켓이 1~28 범위의 중복 없는 7개 번호인지 검증한다.

### Phase E — 이미지 영구 저장

- [x] 오버레이 Canvas 결과 PNG 사용
- [x] `soop-overlay-archive.js` 분리
- [x] 브리지 PNG 업로드 API
- [x] 닉네임/후원자별 폴더
- [x] 안전한 Windows 폴더명 정규화
- [x] PNG 파일명 규칙
- [x] `Ticket.image_path` 저장
- [x] `issued.json` 생성/갱신
- [x] 최대 3회 업로드 재시도
- [x] `IMAGE_SAVED` / `ISSUED` 상태 전이
- [x] `issued_ticket_count` 갱신
- [x] 중복 PNG 업로드 멱등성
- [x] Phase E CI self-test
- [x] Overlay archive JS 문법 CI 검사

Phase E 검증:

```text
55 별풍선으로 티켓 1장 생성
→ pending 1
→ PNG 저장
→ image_path 생성
→ status ISSUED
→ issued_ticket_count 1
→ issued.json 생성
→ pending 0
→ 같은 PNG 재업로드
→ status/issued count 변화 없음
```

### Phase F — 복구/운영 기능

- [ ] 미완료 티켓 상태별 재처리
- [ ] 브리지 시작 시 `NUMBERS_CONFIRMED` 티켓 Overlay 재전송
- [ ] Overlay 재접속 시 pending 티켓 재전송 정책
- [ ] 룰렛 실행/완료 상태 acknowledgement
- [ ] DB 백업
- [ ] 파일 로그
- [x] 기본 연결 상태 API
- [ ] 테스트 후원/테스트 티켓 관리 기능
- [ ] 수동 누적 보정 기능
- [ ] `issued.json` 재생성/복구 명령

### Phase G — Windows 패키징/업데이트

- [ ] 자급식 Java runtime
- [ ] Windows 실행 파일/설치 패키지
- [ ] Java 미설치 PC 실행 검증
- [ ] config/data/tickets 업데이트 보존 검증
- [ ] GitHub 오버레이 버전 확인
- [ ] 로컬 `web/` 자산 자동 동기화

## 17. 1차 완료 조건

다음 시나리오를 모두 통과하면 1차 운영 버전 완료로 본다.

1. 프로그램 최초 실행 후 streamerId만 설정하여 SOOP 방송 연결
2. A가 30개 후원 → 티켓 없음
3. A가 25개 추가 → 누적 55, 티켓 1장, 잔여 5
4. B가 120개 후원 → 티켓 2장, 잔여 20
5. A가 95개 추가 → 기존 잔여 포함 신규 티켓 2장
6. 동일 후원 이벤트 재수신 시 중복 누적 없음
7. 각 티켓 번호가 Overlay 전송 전에 DB에 확정됨
8. 룰렛에서 저장된 7개 번호가 순차 확정되는 것처럼 표시됨
9. 룰렛 종료 후 동일 번호의 티켓 이미지 표시
10. PNG가 후원자 폴더에 자동 저장
11. SQLite와 `issued.json`에서 닉네임별 발급 번호 확인 가능
12. 동일 PNG 재전송으로 발급 수가 중복 증가하지 않음
13. 프로그램 재실행 후 누적값과 발급 이력 유지
14. 미완료 티켓이 재실행 시 새 번호 없이 복구됨
15. 다량 후원 시 모든 티켓을 DB 선저장 후 FIFO 처리
16. 기존 `index.html` 동작에 변화 없음
