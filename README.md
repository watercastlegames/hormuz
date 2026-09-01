# HORMUZ

브라우저에서 바로 돌아가는 3D 실시간 전략 게임의 전체 소스다.
설치할 것도, 빌드 도구도, 프레임워크도 없다. 웹서버 하나면 된다.

Full source of a browser-based 3D real-time strategy game.
No framework, no build step required to run it — just serve the folder.

- Play online: https://watercastlegames.github.io/hormuz/
- Production demo: https://sidak.kr/autodev/GameCreator/hormuz/
- Source: https://github.com/watercastlegames/hormuz

## 돌려보기 / Run it

```
python -m http.server 8080
# http://localhost:8080/index.html
```

## 구조 / Layout

```
index.html            작전 화면 (캠페인)
rts-combat.html       전투 화면
assets/js/            게임 코드 (순수 자바스크립트, 프레임워크 없음)
  rts-combat.js         전투 엔진 — 가장 큰 파일이고 핵심이다
  vendor/               three.js
assets/data/          전투 시나리오 정의 (JSON)
assets/models/        3D 모델 (.glb)
tools/                검증·측정 도구 (Python)
docs/                 개발 기록과 감사 문서
```

## 지도 연동 / Google 3D Maps

실제 지형을 쓰려면 본인 API 키가 필요하다.
`net/google-maps-config.js` 에 발급받은 값을 넣으면 된다.
비워 두면 자체 지형으로 자동 전환되며, 게임은 그대로 돌아간다.

Uses Google Photorealistic 3D Tiles when configured.
Without a key it falls back to locally generated terrain and still runs.

**브라우저용 키는 화면에 그대로 노출된다.** 반드시 HTTP 리퍼러 제한을 걸어야 한다.
Browser keys are visible to anyone. Always restrict them by HTTP referrer.

## 검증 도구 / Verification tools

`tools/` 안의 스크립트는 전부 실제로 쓴 것들이다.
게임을 헤드리스 브라우저로 띄워 놓고 승률·프레임·용량을 직접 잰다.

```
python tools/validate-rts-scenarios.py    시나리오 7개가 다 클리어 가능한지
python tools/audit-smoothness.py          프레임이 끊기는 지점 찾기
python tools/audit-load-cost.py           전투별 내려받는 용량
```

## 라이선스 / License

코드와 문서는 MIT다. 상업적 이용을 포함해 자유롭게 쓸 수 있다.
3D 모델은 CC BY 4.0이며 출처 표시가 필요하다.

Code and documentation are MIT licensed. Bundled HORMUZ 3D models are CC BY 4.0
and require attribution. See `ASSET-LICENSES.md` for third-party notices.

ElevenLabs 무료 플랜으로 만든 운영용 효과음은 이 저장소에 포함하지 않았다.
공개 빌드는 무음 폴백으로 정상 동작한다.

Production sound effects generated on an ElevenLabs free plan are intentionally omitted.
The public build runs normally with a silent fallback.

## 기여·면책 / Contributing and disclaimer

- `CONTRIBUTING.md` — build, i18n, verification, and security rules
- `DISCLAIMER.md` — fictional-simulation and non-navigation notice
