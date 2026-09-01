# HORMUZ STEP 0 CINEMATIC v5 품질 감사

작성일: 2026-07-27

## 비교 대상

- 목표 콘셉트: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\hormuz-ui-cinematic-concept-v1.png`
- 현재 구현: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\mockup-meshy-cinematic-v5-desktop-1600x900.png`
- 정적 좌우 비교: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\quality-comparison-concept-vs-v5-3200x900.png`
- 드래그 비교: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\quality-comparison-concept-vs-v5.html`
- 실제 자산 확대 검수: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\meshy-ship-quality-gate.html`

## 결과

| 항목 | 판정 | 근거 |
|---|---|---|
| 호르무즈 지형·황혼 조명 | 기준 충족 | 산악·도시 불빛·해안선·수면 대비가 목표와 같은 시네마틱 톤 유지 |
| 전략 구도 | 기준 충족 | 항모 좌하, 유조선 우상, 고속정 중앙, 기뢰밭 중앙하 배치 |
| 객체 밀도 | 기준 이상 | 항모전단·함재기·민간선·스웜·크레인을 한 화면에서 더 선명하게 식별 |
| 전술 오버레이 | 기준 충족 | TSS 항로·방어권·기뢰밭·요격 섬광 동시 표시 |
| HUD 가독성 | 기준 이상 | 목표보다 계기·선택 버튼의 대비와 보조 설명이 선명함 |
| PC 반응형 | 통과 | 1600×900, 핵심 UI 가림 없음 |
| 모바일 반응형 | 통과 | 430×932, 6계기·전장·3선택지 모두 한 화면에서 판독 가능 |
| 브라우저 오류 | 통과 | HTTP 200, WebGL 활성, 콘솔 error 0건 |

정본의 8개 시각 일치 조건은 8/8로 통과했다. 따라서 전략 화면의 체감 품질은 목표 콘셉트와 동급 이상으로 판정한다. 이 판정은 픽셀 복제율이 아니라 구도·색·밀도·가독성·상태 표현의 품질 게이트 결과다.

## 실제 3D 자산 범위

- 기존 실제 Meshy GLB: 니미츠급 항모, 알레이버크급 구축함.
- 신규 실제 Meshy GLB: VLCC 유조선, 항만 갠트리 크레인, 연안 방어 TEL.
- IRGC 고속정: Meshy 작업이 99%에서 서버 timeout으로 실패해 절차형 안전 폴백 유지.
- 실제 Meshy GLB는 총 5종이다.
- 16종 유닛 인벤토리 기준 완료는 항모·구축함·유조선·TEL 4종, 25%다.

따라서 `mockup.html`은 완성 게임이 아니라 STEP 0 품질 승인용 구현이다. 전략 화면의 시각 품질은 통과했지만, M1 룰 코어와 나머지 M2 고유 유닛 제작은 아직 남아 있다.

## Meshy 2차 묶음 품질·성능

| 객체 | 4K 원본 GLB | 2K 웹 GLB | 감소율 |
|---|---:|---:|---:|
| VLCC 유조선 | 15,565,248B | 3,282,288B | 78.9% |
| 항만 갠트리 크레인 | 16,018,032B | 3,828,652B | 76.1% |
| 연안 방어 TEL | 15,424,444B | 3,374,808B | 78.1% |

원본 4K GLB와 베이스컬러 PNG는 보존하고, 런타임에는 2048px JPEG 내장 웹 GLB를 사용한다. 각 모델 로딩은 독립 처리해 한 종류가 실패해도 전체 3D 묶음이 절차형으로 되돌아가지 않는다.
