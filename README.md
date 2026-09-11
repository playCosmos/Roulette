# Lucky Mouth Roulette

캐릭터의 입 안에서 7개의 번호 릴이 동시에 회전하고, `STOP`을 누르면 왼쪽부터 순차적으로 멈추는 정적 웹 룰렛입니다.

## 기능

- 7개 릴 동시 회전
- `STOP` 클릭 시 1번 릴부터 7번 릴까지 순차 감속/정지
- 기본 번호 범위 `1~45`, 최대 번호 변경 가능
- 중복 허용/비허용 선택
- Web Crypto API 기반 번호 추첨
- 최종 번호 자동 기록 (`localStorage`, 최근 200회)
- 현재 결과 복사, 개별 기록 복사, 전체 기록 복사
- 기록 초기화
- 효과음 켜기/끄기
- `Space` 키로 SPIN / STOP 조작
- 반응형 레이아웃

## 실행

별도의 빌드가 필요하지 않습니다.

```bash
python -m http.server 8080
```

브라우저에서 `http://localhost:8080`을 열면 됩니다.

## GitHub Pages

Repository Settings → Pages에서 `Deploy from a branch`를 선택하고 `main` / `/ (root)`를 지정하면 정적 사이트로 배포할 수 있습니다.

## 구조

```text
.
├─ index.html
├─ styles.css
├─ app.js
└─ assets/
   └─ lucky.webp
```

추첨 결과는 애니메이션과 분리되어 있습니다. `STOP`을 누르는 순간 목표 번호 7개를 먼저 확정하고, 각 릴이 해당 번호에 순차적으로 도착하도록 애니메이션합니다.
