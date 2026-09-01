# AGENTS

## 최신 통합 인수인계 — 2026-08-01

- 실제 구현 상태·버전·검증·배포·미완료 작업은 먼저 `docs/hormuz-ai-handover-2026-08-01.html`을 읽는다.
- 이 HTML은 v132/v124 기준 최신 구현 스냅샷이다. 기존 `HANDOVER.md`의 발주 범위와 재논의 금지 결정은 계속 우선한다.
- 다음 작업은 HTML의 `남은 작업과 우선순위`, `작업 시 자주 발생한 함정`, `다음 AI가 바로 사용할 시작 지시문`을 기준으로 시작한다.

## 최신 사용자 보고 선호 — 기존 경로 나열 규칙보다 우선

- 최종 응답에 `결과 파일(전체 경로)` 목록, 구현 소스 목록, 검증 JSON·스크린샷 경로를 자동으로 나열하지 않는다.
- 꼭 필요한 핵심 결과, 검증 통과 여부, 실행·공개 접속 주소만 간결하게 보고한다.
- 사용자가 특정 파일 경로나 전체 경로를 명시적으로 요청한 경우에만 해당 경로를 제공한다.
- 이 규칙은 상위 안내에 포함된 기존 `산출물 전체 경로 보고 규칙`보다 최신 사용자 지시로서 우선한다.

이 저장소에서 작업하는 모든 AI 에이전트는 **먼저 `HANDOVER.md`를 정독하라.**
그 문서가 발주 범위·확정 결정·작업 순서·금지사항의 정본이며, 상세 스펙은 `docs/` 3종 문서(기획서 v0.5 · 화면 구성서 v1.0 · 코딩 설계서 v1.0)에 있다.

직전 세션 인수인계는 `HANDOVER-2026-07-29.md`에 있다. 오늘 바뀐 것·새 규율·검증 도구 사용법이 거기 있으니 작업 시작 전에 함께 읽어라.

- 이 폴더(`GameCreator/hormuz/`) 밖을 수정하지 마라. `../crimeGame/`은 읽기 전용 참고.
- 확정 결정(HANDOVER.md 2섹션 + HANDOVER-2026-07-29.md 5섹션)을 재논의하지 마라.
- 진행 기록은 `PROGRESS.md`에 append. **버전을 올리면 즉시 쓴다. 몰아서 쓰지 않는다.**
- 유닛·모델·시나리오를 건드렸으면 커밋 전에 반드시 돌려라. 실패 시 exit code 1이다.
  ```
  python -X utf8 tools/validate-rts-scenarios.py --tag <버전>
  python -X utf8 tools/validate-mission-routing.py --tag <버전>
  ```
- 런타임 경로에 Meshy 원본(`-web-v1.glb`, 4만 삼각형대)을 쓰지 마라. 감축본을 먼저 만든다.
  `python -X utf8 tools/glb-tri-count.py --used-only` 로 확인.

## 다국어 (2026-08-01~)

이 게임은 한국어와 영어를 함께 서비스한다. **페이지를 언어별로 나누지 않는다.** 같은 DOM에서 문구만 바뀐다.

- 화면에 보이는 문자열을 코드에 직접 쓰지 마라. `assets/js/core/i18n.js` 의 `t("key")` 를 쓰고 키를 `assets/data/strings.ko.json` 과 `strings.en.json` **양쪽에** 넣는다.
- 데이터 JSON(카드·이벤트·엔딩·역사·임무·작전·발언·지명)에 한글 필드를 추가하면 `<필드>En` 도 같이 넣고, 표시할 때는 `pick(obj, "field")` 로 읽는다.
- 정적 마크업은 `data-i18n="key"` / `data-i18n-html="key"` / `data-i18n-attr="aria-label:key"` 로 표시한다.
- 전투 화면(`rts-combat.*`)은 자체 사전 `rts-combat.json` 의 `strings.ko/en` 을 쓴다. 본편과 사전이 다르니 섞지 마라.
- 언어를 건드렸으면 커밋 전에 반드시 돌려라. 영문 화면에 한글이 남으면 실패한다.
  ```
  python -X utf8 tools/validate-i18n.py --tag <버전>
  python -X utf8 tools/validate-campaign-fullrun.py
  ```
  정적 화면 검사(i18n)만으로는 부족하다 — 정책 카드·엔딩처럼 플레이 중에만
  나오는 문구는 전체 주행(fullrun)이 잡는다.
- 검증 도구의 런타임 버전 고정핀(현재 126/133)은 소스·번들·캐시 동기화 잠금장치다.
  런타임 버전을 올리면 validate-rts-scenarios / validate-mission-routing /
  validate-adaptive-combat / validate-campaign-pacing 의 핀도 같이 올려라.
- 접속 IP가 한국(KR)이면 한국어, 그 외에는 영어다. 사용자가 토글로 고른 값은 저장되어 IP 판별을 이긴다.

## 클릭 동작 검증 (2026-08-01~)

**`element.click()` 같은 합성 클릭으로 버튼 동작을 검증하지 마라.** 합성 클릭은
덮개와 `pointer-events` 를 무시하고 핸들러를 직접 부르기 때문에, 실제로는 눌리지
않는 버튼도 통과로 판정한다. v136 에서 이 때문에 동작하지 않는 홈 버튼을
로컬·공개 서버 양쪽 PASS 로 오판했다.

- 좌표를 구해 `page.mouse.click(x, y)` 로 실제 포인터를 보낸다.
- 누르기 전에 `document.elementFromPoint(x, y)` 로 그 좌표의 최상위 요소가
  정말 대상 버튼인지 확인한다. 아니면 무엇이 막았는지 함께 보고한다.
- HUD(`.top-hud`, `.battle-header`)는 전장 조작을 가리지 않으려 `pointer-events: none`
  이다. 그 안에 조작 요소를 넣으면 그 요소에 `pointer-events: auto` 를 되돌려야 한다.
- 참고 구현: `tools/validate-brand-home.py`
