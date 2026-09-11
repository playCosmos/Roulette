# Lucky Teeth Roulette

캐릭터의 **보이는 이빨 7개 자체가 각각 독립적인 번호 릴처럼 회전**하는 정적 웹 룰렛입니다. `SPIN`을 누르면 7개 이빨이 동시에 회전하고, `STOP`을 누르면 왼쪽 이빨부터 오른쪽 이빨까지 하나씩 감속해 멈춥니다.

## 기능

- 7개 이빨 동시 회전
- STOP 시 왼쪽 → 오른쪽 순차 감속/정지
- 마지막 7번째 이빨은 추가 지연 후 정지
- 기본 번호 범위 1~45, 최대 번호 변경 가능
- 중복 허용/비허용
- Web Crypto API 기반 추첨
- 추첨 완료 시 브라우저 `localStorage`에 최근 200회 자동 기록
- 현재 결과 복사 / 개별 기록 복사 / 전체 기록 복사
- 기록 초기화
- 효과음 ON/OFF
- Space 키로 SPIN / STOP
- GitHub Pages에서 빌드 없이 실행

## 이미지

캐릭터 이미지는 Base64 텍스트 조각으로 복원하지 않습니다. 실제 정적 이미지 파일을 직접 사용합니다.

```text
assets/lucky.webp
```

웹 페이지에서는 일반 이미지처럼 `./assets/lucky.webp`를 직접 로드합니다.

## 구조

```text
.
├─ index.html
├─ styles.css
├─ app.js
├─ .nojekyll
└─ assets/
   └─ lucky.webp
```

## 실행

별도 빌드 과정이 없습니다.

```bash
python -m http.server 8080
```

또는 GitHub Pages에서 `main` / `/ (root)`를 배포 대상으로 선택하면 바로 실행할 수 있습니다.

## 추첨과 연출 분리

`STOP`을 누르는 순간 최종 번호 7개를 먼저 확정합니다. 각 이빨의 회전 위상을 목표 번호에 정확히 맞춰 정지시키므로, 마지막 프레임에서 숫자만 강제로 바꾸는 방식이 아닙니다.
