# Roulette Bridge

Windows에서 실행되는 SOOP 자동 티켓 발급 브리지다. 현재 Phase B의 설정/SQLite/로컬 HTTP·WebSocket 기반 위에 Phase C의 SOOP 방송 조회, 채팅 연결, 별풍선 이벤트 수신 어댑터가 추가되어 있다.

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

## SOOP 연결 동작

1. `streamerId`로 현재 방송 정보를 조회한다.
2. 방송 중이면 BNO, 제목, 채팅 서버 정보를 확인한다.
3. 인증 쿠키 없이 익명 읽기 전용 채팅 연결을 시작한다.
4. `JOIN_CHANNEL` 수신 시 상태를 `CONNECTED`로 변경한다.
5. `SEND_BALLOON`을 `SoopDonation`으로 변환한다.
6. 연결 종료/오류 시 soopapi의 재연결 이벤트를 추적하고, 연결이 완전히 종료된 경우 `offlinePollSeconds` 후 방송 정보를 다시 조회한다.
7. 방송이 꺼져 있는 상태에서 브리지를 실행해도 종료하지 않고 다음 방송을 계속 기다린다.

현재 `SoopDonation`의 소비 지점은 비어 있으며 Phase D에서 후원자 누적 및 50개 단위 티켓 발급 엔진을 연결한다.

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

`/api/state`의 `soop` 항목에는 현재 연결 상태, BNO, 방송 제목, 수신한 별풍선 이벤트 수, 마지막 후원 수신 시각, 마지막 오류가 표시된다.

개발 중 `storage.webRoot`가 없고 저장소 루트의 `soop-overlay.html`을 찾을 수 있으면 자동으로 저장소 루트를 정적 웹 루트로 사용한다. 최종 Windows 패키지에서는 GitHub에서 동기화한 웹 자산을 `web/`에 두는 구조로 전환한다.

OBS 개발 테스트 주소 예시:

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

## 영구 데이터

`data/roulette.db`는 삭제하거나 프로그램 업데이트 시 덮어쓰지 않는다. SQLite의 `donor`, `donation_event`, `ticket` 테이블이 운영 원본 데이터가 된다.

재시작 시 `ISSUED`가 아닌 티켓을 검색해 복구 대상 건수를 상태 API와 로그에 표시한다. 실제 룰렛/이미지 발급 재개는 자동 발급 엔진이 추가되는 Phase D/F에서 이 목록을 사용한다.
