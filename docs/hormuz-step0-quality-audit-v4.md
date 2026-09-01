# HORMUZ STEP 0 CINEMATIC v4 품질 감사

작성일: 2026-07-27

## 비교 대상

- 목표 콘셉트: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\hormuz-ui-cinematic-concept-v1.png`
- 현재 구현: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\mockup-meshy-cinematic-v4-desktop-1600x900.png`
- 정적 좌우 비교: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\quality-comparison-concept-vs-v4-3200x900.png`
- 드래그 비교: `D:\soccerstarWebSource\GameCreator\hormuz\output\step0\quality-comparison-concept-vs-v4.html`

## 판정

| 항목 | v4 판정 | 근거 |
|---|---|---|
| 호르무즈 지형·황혼 조명 | 기준 충족 | 산악·해안·도시 불빛·해수면의 화면 점유율과 명암이 기준과 동급 |
| 함대·민간선·고속정 실루엣 | 기준 이상 | 전략 줌에서 함종과 진영색이 기준보다 선명하게 식별됨 |
| 항만·해안 디테일 | 기준 충족 | 우측 해안 크레인과 항만 조명 밀도 보강 |
| 전술 정보 밀도 | 기준 충족 | 청록 항로, 방어권, 적색 기뢰밭, 타격 지점 동시 표시 |
| HUD 가독성 | 기준 이상 | PC·모바일 모두 6계기와 3개 결정 버튼을 읽을 수 있음 |
| 화면 구도 | 기준 충족 | 항모 좌하·위협 중앙·유조선 우상·결정 패널 중하 배치 유지 |
| 실제 3D 자산 완성도 | 미완료 | 고유 16종 중 Meshy GLB 2종만 완료 |
| 게임 전체 완성도 | 미완료 | 현재 STEP 0이며 M1~M4는 남아 있음 |

## 100% 기준 해석

전략 줌 스크린샷의 체감 품질은 승인 콘셉트의 목표 범위에 도달했으며, 함종 식별성과 HUD 가독성은 기준을 상회한다. 이는 픽셀 복제가 아니라 실제 게임 화면에서 요구되는 구도·색상·밀도·가독성 기준의 통과 판정이다.

그러나 “모든 객체가 완성된 실시간 3D”라는 의미의 100%는 아니다. 현재 Meshy 고유 모델은 니미츠급 항공모함과 알레이버크급 구축함 2종으로, 목록 16종 대비 12.5%다. 유조선·고속정·항만 크레인·TEL 등은 전략 줌 이미지 LOD 또는 절차형 폴백이며, 다음 Meshy 유료 묶음 승인 후 GLB로 교체해야 한다.

## 구현 구조

- CINEMATIC: 고해상도 환경·전략 LOD + 코드 전술 레이어 + Three.js 동적 합성.
- RICH/BASIC: Three.js 실제 메시와 절차형 폴백.
- 근접 검수: `meshy-ship-quality-gate.html`에서 실제 Meshy GLB 회전·확대.
- 모델 로딩 실패: 절차형 함대 자동 복원.

## 다음 품질 게이트

다음 우선순위는 유조선, IRGC 고속정, 항만 크레인, TEL 4종이다. 동일한 Meshy 6 최고 설정을 적용할 경우 객체당 30크레딧, 합계 120크레딧이므로 실행 전 별도 승인이 필요하다.
