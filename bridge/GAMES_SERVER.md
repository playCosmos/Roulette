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


## 짧은 룸 코드 / 공유 URL

새 룸 ID는 기본 6자리 영문+숫자 코드로 생성한다. 혼동하기 쉬운 O/0, I/1은 사용하지 않는다.

예: `ABC7K2`

참가자에게 전달하는 보드 오버레이 URL은 룸 ID 외의 런타임 파라미터를 노출하지 않는다.

- 일반 보드: `https://games.example.com/games/board/index.html?roomId=ABC7K2`
- 직각 보드: `https://games.example.com/games/board/rect.html?roomId=ABC7K2`

보드 클라이언트는 `/api/client/config`에서 WebSocket 주소를 자동 조회한다. 기존 UUID 형식의 룸 ID도 계속 조회할 수 있다.


## 원격 관리자

게임 서버 PC와 실제 운영자가 다른 PC일 수 있으므로 관리자 UI도 외부 공용 HTTP 포트에서 인증 후 사용할 수 있다.

- 로컬 관리자 원본: `127.0.0.1:17830`
- 참가자/원격 관리자 공용 HTTP: `0.0.0.0:17832`
- 실시간 WebSocket: `0.0.0.0:17831`

외부 운영자는 오버레이와 동일한 호스트/포트에서 `/admin/` 경로를 사용한다.

예:

`http://PUBLIC-IP:17832/admin/?token=<server-generated-token>`

최초 토큰 검증에 성공하면 서버는 토큰을 URL에서 제거하고 12시간 관리자 세션 쿠키를 발급한다. 쿠키는 `HttpOnly`, `SameSite=Strict`이며 HTTPS 공개 주소에서는 `Secure`도 적용한다.

관리자 API의 변경 요청은 17832에서 인증을 확인한 후 내부 `127.0.0.1:17830`으로 프록시한다. 따라서 17830은 포트포워딩하지 않는다.

서버 PC의 로컬 관리자 화면에서 현재 원격 관리자 링크를 확인/복사할 수 있다. 서버 재시작 시 bootstrap token과 기존 세션은 폐기되고 새로 생성된다.


## 사용자 진입 포트 통일

사용자(룸 생성자/운영자)와 참가자는 모두 외부 공용 HTTP 포트 17832를 사용한다.

- 운영자: `http://HOST:17832/admin/`
- 참가자: `http://HOST:17832/games/board/...?...roomId=...`
- 실시간 WebSocket: `17831`
- 실제 서버 관리 백엔드: `127.0.0.1:17830`

17830은 서버 내부 관리/API 원본으로 남겨두되, 자동 브라우저 실행과 트레이 메뉴를 포함한 사용자 진입점에서는 사용하지 않는다.
