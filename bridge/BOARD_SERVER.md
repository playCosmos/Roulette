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


## SOOP 프로필 이미지

룸 생성 시 각 참가자의 SOOP ID를 사용자 검색 API로 확인한다.

- 표시 이름이 비어 있으면 SOOP 현재 닉네임을 사용한다.
- 프로필 이미지가 비어 있으면 표시 이름 입력 여부와 관계없이 SOOP `station_logo` / `profile_image`를 조회한다.
- 조회된 URL은 룸 설정과 DB에 저장되어 모든 보드 클라이언트에 전달된다.
- 보드의 플레이어 말은 원형 SOOP 프로필 이미지를 우선 표시한다.
- 이미지 URL이 없거나 이미지 로딩이 실패하면 기존 닉네임 글자 말로 자동 대체한다.
- 관리자 참가자 상태 카드에서도 조회된 프로필 이미지를 확인할 수 있다.
