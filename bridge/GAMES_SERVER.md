# RamyaniGamesServer

방송용 게임을 서버가 제공하고, 참가자는 브라우저 기반 클라이언트만 사용하는 구조다.

## 현재 모듈

- Board: 멀티플레이 보드게임
- Roulette: 기존 구현은 별도 레거시/독립 경로로 유지하며 현재 GamesServer 패키지에는 포함하지 않는다.

## 서버 / 클라이언트 경계

- Admin HTTP: 127.0.0.1:17830
  - 룸 생성, 확정, 수동 턴, 위치 보정, 일시정지/재개, 연장, 종료
  - 외부 참가자에게 공개하지 않는다.
- Client HTTP: 0.0.0.0:17832
  - games/board 정적 클라이언트
  - 룸/런타임 GET만 허용
  - 관리 POST 요청은 허용하지 않는다.
- Client WebSocket: 0.0.0.0:17831
  - board.turn 실시간 상태 전달

## 룸 공유

룸을 확정하면 운영 페이지로 이동한다. 운영 페이지 상단의 공용 오버레이 URL 하나를 모든 참가자에게 전달한다. 각 참가자는 동일 URL을 자신의 OBS 브라우저 소스에 사용한다.

외부 인터넷 공유 시 config.json의 server.publicBaseUrl과 server.publicWebSocketUrl을 설정한다.
