# Roulette Bridge

Windows에서 실행되는 SOOP 자동 티켓 발급 브리지의 기반 프로젝트다. Phase B에서는 SOOP 접속 전 단계인 설정 로드, SQLite 영구 저장, 로컬 HTTP 서버, Overlay WebSocket 서버, 재시작 시 미완료 티켓 검색을 제공한다.

## 요구 사항

- JDK 25+
- Maven 3.9+

## 실행

```bash
cd bridge
mvn clean package
java -jar target/roulette-bridge-0.1.0-SNAPSHOT.jar
```

첫 실행 시 `config.json`이 없으면 기본 설정 파일을 자동 생성한다. `streamerId`는 Phase C부터 사용한다.

## 로컬 주소

- HTTP: `http://127.0.0.1:17820/`
- 상태: `http://127.0.0.1:17820/health`
- 런타임 상태: `http://127.0.0.1:17820/api/state`
- Overlay WebSocket: `ws://127.0.0.1:17821`

개발 중 `storage.webRoot`가 없고 저장소 루트의 `soop-overlay.html`을 찾을 수 있으면 자동으로 저장소 루트를 정적 웹 루트로 사용한다. 최종 Windows 패키지에서는 GitHub에서 동기화한 웹 자산을 `web/`에 두는 구조로 전환한다.

OBS 개발 테스트 주소 예시:

```text
http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
```

## 영구 데이터

`data/roulette.db`는 삭제하거나 프로그램 업데이트 시 덮어쓰지 않는다. SQLite의 `donor`, `donation_event`, `ticket` 테이블이 운영 원본 데이터가 된다.

재시작 시 `ISSUED`가 아닌 티켓을 검색해 복구 대상 건수를 상태 API와 로그에 표시한다. 실제 룰렛/이미지 발급 재개는 자동 발급 엔진이 추가되는 Phase D/F에서 이 목록을 사용한다.
