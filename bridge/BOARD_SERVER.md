# Board module on RamyaniGamesServer

보드게임은 RamyaniGamesServer가 제공하는 첫 멀티플레이 게임 모듈이다.

## 실행 구조

- Server executable: `RamyaniGamesServer.exe`
- Admin HTTP: `127.0.0.1:17830`
- Client HTTP: `0.0.0.0:17832`
- Client WebSocket: `0.0.0.0:17831`
- Board DB: `data/board-game.db`

관리 UI와 클라이언트는 네트워크 경계를 분리한다. 참가자에게는 관리자 주소를 전달하지 않는다.

## 참가자 사용 방식

1. 생성자가 보드게임 룸을 생성하고 보드 배치를 확정한다.
2. 확정 직후 해당 룸의 운영 페이지로 이동한다.
3. 운영 페이지 상단의 **참가자 방송용 공용 오버레이** 주소를 복사한다.
4. 모든 참가자에게 같은 주소를 전달한다.
5. 참가자는 각자의 OBS 브라우저 소스에 동일한 URL을 등록한다.

클라이언트 HTTP는 보드 정적 파일과 룸/런타임 GET만 제공하며 관리 POST API는 거부한다.

## 외부 공개 주소

인터넷 공유 시 `config.json`에 다음 값을 설정한다.

- `server.publicBaseUrl`: 예 `https://games.example.com`
- `server.publicWebSocketUrl`: 예 `wss://games.example.com/ws`

리버스 프록시에서는 publicBaseUrl을 내부 client HTTP `17832`로,
publicWebSocketUrl을 내부 WebSocket `17831`로 전달한다.

## 현재 범위

- 보드게임 멀티플레이: GamesServer에 포함
- 기존 룰렛/티켓 기능: 독립 레거시 경로로 유지하며 현재 GamesServer 패키지에는 포함하지 않음

향후 다른 방송용 게임은 `/games/<game>/` 클라이언트 경로와 서버 모듈을 추가하는 방식으로 확장한다.


## 짧은 룸 코드 / 공유 URL

새 룸 ID는 기본 6자리 영문+숫자 코드로 생성한다. 혼동하기 쉬운 O/0, I/1은 사용하지 않는다.

예: `ABC7K2`

참가자에게 전달하는 보드 오버레이 URL은 룸 ID 외의 런타임 파라미터를 노출하지 않는다.

- 일반 보드: `https://games.example.com/games/board/index.html?roomId=ABC7K2`
- 직각 보드: `https://games.example.com/games/board/rect.html?roomId=ABC7K2`

보드 클라이언트는 `/api/client/config`에서 WebSocket 주소를 자동 조회한다. 기존 UUID 형식의 룸 ID도 계속 조회할 수 있다.
