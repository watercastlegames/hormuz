# 호르무즈 3D·UI 제작 인벤토리 v1.0

> 기준 아트: `output/step0/hormuz-ui-cinematic-concept-v1.png`  
> 정본 우선순위: `HANDOVER.md` > 코딩 설계서 > 화면 구성서 > 기획서  
> 목표: 승인된 이미지의 색·밀도·구도·정보 위계를 실제 조작 가능한 Three.js 화면으로 재현한다.

## 1. 결론 카드

| 구분 | 확정 수량 | 제작 방식 |
|---|---:|---|
| 환경·지도 패키지 | 10종 | GIS/절차형 메시 + 셰이더 |
| 고유 3D 유닛 모델 | 16종 | 저폴리 메시, 텍스처 0, 필요 시 GLB |
| 공용 3D 이펙트 | 10종 | 셰이더·리본·인스턴싱·파티클 풀 |
| HUD 아이콘 | 20종 | CSS/Canvas 코드 드로잉 |
| 버튼 컴포넌트 | 15종 | HTML/CSS, 상태 변형으로 재사용 |
| AI 생성 런타임 이미지 | **0장** | 승인 시안을 배경으로 깔지 않음 |
| 코드 생성 런타임 텍스처 | 3종 | 글로우·블롭 그림자·파티클 아틀라스 |
| STEP 0 실제 렌더 캡처 | 6장 | PC/모바일 × basic/rich/cinematic |
| 아트 디렉션 기준 이미지 | 1장 | 이미 생성·승인 |

AI 생성 이미지를 런타임에 쓰지 않는 이유는 다음과 같다.

1. 카메라가 움직이면 평면 이미지의 원근이 즉시 깨진다.
2. 모바일 세로 화면에서 구도를 다시 잡을 수 없다.
3. 유닛 위치·통항률·확전 상태를 실제 게임 상태에 맞춰 바꿀 수 없다.
4. 정본이 요구한 텍스처 0·저폴리·발광 와이어 조형과 충돌한다.

승인된 이미지는 **색, 화면 밀도, 카메라 각도, UI 비율을 판단하는 기준 이미지**로만 사용한다.

## 2. 환경·지도 10종

| # | 객체 | 수량 | 구현 | STEP 0 |
|---:|---|---:|---|---|
| E01 | 바다 플레인 | 1 | 64×64 단일 패스 물 셰이더, 웨이브·프레넬·전술 그리드 합성 | 구현 |
| E02 | 이란 본토 해안 | 1 | 실해안선 압출, 무광 암석 + 능선 림라이트 | 근사 구현 |
| E03 | 무산담·UAE 해안 | 1 | 피오르형 저폴리 메시, 정점 노이즈 | 근사 구현 |
| E04 | 케심섬 | 1 | 중앙 랜드마크, 길고 낮은 압출 섬 | 근사 구현 |
| E05 | 소도서 7개 | 7 | 호르무즈·라라크·헹감·아부무사·대/소툰브·쿠오인 | 근사 구현 |
| E06 | IMO TSS 레인 | 3선 | 입항·출항·버퍼 점선 | 구현 |
| E07 | 구역 오버레이 | 6 | 기뢰 위험·배치 존·사거리 부채꼴 | 구현 |
| E08 | 도시 불빛 클러스터 | 8 | 인스턴스 점광원·명멸 | 구현 |
| E09 | 황혼 하늘 돔 | 1 | 남색→호박 그라데이션 | 구현 |
| E10 | 지도 밖 엣지 비콘 | 5 | 바레인·알우데이드·핵시설·자스크·후티 | M2 |

## 3. 고유 3D 유닛 16종

### 미군 9종

| # | 유닛 | 최대 동시 | 폴리 목표 | 식별 포인트 |
|---:|---|---:|---:|---|
| U01 | 니미츠급 항모 CVN | 1 | 800 | 긴 비행갑판, 아일랜드, 갑판 스트로브 |
| U02 | 알레이버크급 구축함 DDG | 4 | 600 | 날카로운 함수, VLS 섬광 |
| U03 | LCS 소해함 | 2 | 500 | 쌍동형에 가까운 넓은 선미, 소해 스캔 |
| U04 | 버지니아급 잠수함 SSN | 1 | 400 | 수면하 반투명 실루엣 |
| U05 | F/A-18 편대 마커 | 3편대 | 350 | 3기 묶음, 항적운 리본 |
| U06 | B-2 폭격기 | 1 | 300 | 전익 실루엣 |
| U07 | P-8A/MQ-9 초계기 | 2 | 300 | 스캔 원뿔 |
| U08 | MH-60R 헬기 | 2 | 350 | 로터 블러 원판 |
| U09 | 무인소해정 USV | 3 | 150 | 소해 미니게임 조작체 |

### 이란 6종

| # | 유닛 | 최대 동시 | 폴리 목표 | 식별 포인트 |
|---:|---|---:|---:|---|
| U10 | IRGC 고속정 | 40 | 150 | V자 웨이크, 스웜 군집 |
| U11 | 연안 미사일 포대 TEL | 6 | 300 | 발사대, 사거리 부채꼴 |
| U12 | 기뢰 | 60 | 60 | 수면하 명멸, EM-52 적색 |
| U13 | 가디르급 잠수정 | 2 | 250 | 짧은 선체, 어뢰 항적 |
| U14 | 샤헤드-136 드론 | 20 | 120 | 삼각익, 점선 진입 궤적 |
| U15 | 공용 미사일 발사체 | 12 | 80 | 발광 헤드, 리본 궤적 |

### 민간 1종

| # | 유닛 | 최대 동시 | 폴리 목표 | 식별 포인트 |
|---:|---|---:|---:|---|
| U16 | 원유 유조선 | 12 | 250 | 백색 항해등, TSS 레인 항행 |

## 4. 공용 3D 이펙트 10종

| # | 이펙트 | 방식 | 색상 |
|---:|---|---|---|
| F01 | 유닛 글로우 | 코드 생성 방사형 CanvasTexture + 가산합성 | 진영색 |
| F02 | 블롭 그림자 | 코드 생성 원형 CanvasTexture | 흑청 |
| F03 | 선박 웨이크 | 재사용 리본 지오메트리 | 청백 |
| F04 | 항공기 항적운 | 재사용 리본 지오메트리 | 백색 |
| F05 | 미사일 궤적 | 커스텀 쿼드/튜브 리본 + 발광 헤드 | 호박·적색 |
| F06 | 폭발 파티클 | 단일 `THREE.Points` 풀 | 백→호박 |
| F07 | 연기·물기둥 | F06과 같은 풀의 셰이프 변형 | 청백·회청 |
| F08 | 요격 섬광 링 | 확장 링 + 중앙 백색 플래시 | 백색 |
| F09 | 레이더 스윕 | 회전 부채꼴 셰이더 | 청록 |
| F10 | 봉쇄 배리어 | 단일 적색 셰이더 평면 | 적색 |

## 5. HUD 아이콘 20종

PNG/SVG 파일을 만들지 않는다. 저해상도 폰에서 깨지지 않도록 CSS 또는 Canvas로 그린다.

| 묶음 | 수량 | 아이콘 |
|---|---:|---|
| 계기판 | 6 | 통항, 유가, 지지, 국제, 탄약, 확전 |
| 시스템 | 6 | 시작, 언어, 스킵, 자동 카메라, 음향, 자동 해결 |
| 미니게임 | 3 | 요격 탭, 소해 드래그, B-2 릴리즈 |
| 선택 분류 | 5 | 군사, 외교, 경제, 여론·정보, 종전 |
| 합계 | **20** |  |

## 6. 버튼 컴포넌트 15종

| # | 컴포넌트 | 주요 화면·상태 |
|---:|---|---|
| B01 | 시작/계속하기 주 CTA | S0 |
| B02 | 한/EN 언어 세그먼트 | S0·설정 |
| B03 | 뉴스릴·연출 스킵 | S1·S2 |
| B04 | 아침 방침 3택 | S3, 15초 타이머 |
| B05 | 긴급 대응 2~3택 | S3, 10초 타이머 |
| B06 | 함대 배치 선택 | S3 |
| B07 | 자동 해결 토글 | S4 |
| B08 | 자동/자유 카메라 토글 | S3·S4 |
| B09 | 미니게임 입력 버튼 | 요격·B-2 |
| B10 | 협상 조항 3단 세그먼트 | S5 × 4조항 |
| B11 | 협상 제출/역제안 | S5 |
| B12 | Google 기록/랭킹 | S6 |
| B13 | 이미지 저장/공유 | S6 |
| B14 | 다시 도전하기 | S6 |
| B15 | 모달 확인/취소 | 공용 |

## 7. 이미지 생산 목록

### AI 이미지 생성

| # | 이미지 | 상태 | 용도 |
|---:|---|---|---|
| I01 | 시네마틱 본편 전체화면 기준 시안 | 완료 | 아트 디렉션 기준 |
| I02 | 호르무즈 해협 시네마틱 클린 플레이트 | 완료 | CINEMATIC 원거리 환경 LOD |
| I03 | 항모전단 전략 LOD | 완료 | 항모·구축함·함재기 원거리 식별 |
| I04 | 유조선 호송대 전략 LOD | 완료 | 민간 선박 원거리 식별 |
| I05 | IRGC 고속정 스웜 전략 LOD | 완료 | 이란 소형정 원거리 식별 |
| I06 | 항만 크레인 전략 LOD | 완료 | 이란 해안 항만 밀도 보강 |

**STEP 0 시안 이후 추가 AI 원본: 5장.** I03~I06은 크로마키 제거 후 투명 PNG로 가공해 사용한다.

최종 M2는 실제 Meshy GLB가 기준이다. I02~I06은 전략 줌에서만 쓰는 시네마틱 LOD이며 근접 줌·품질 게이트에서는 실제 3D 모델로 전환한다.

### 실제 코드 렌더 캡처

| # | 품질 | PC 1600×900 | 모바일 430×932 |
|---:|---|---|---|
| R01–R02 | basic | 1장 | 1장 |
| R03–R04 | rich | 1장 | 1장 |
| R05–R06 | cinematic | 1장 | 1장 |

basic·rich는 Three.js 장면 캡처다. cinematic v4는 실제 Three.js 전술 레이어와 시네마틱 이미지 LOD를 결합한 하이브리드 캡처다.

## 8. 시안과 실제 구현의 일치 판정

픽셀 단위 100% 복제는 이미지 생성 시안과 실시간 3D의 렌더러가 달라 불가능하다. 대신 아래 8항목을 모두 만족하면 시각적 일치로 승인한다.

1. 비스듬한 25~35° 부감과 병목 중심 구도.
2. 화면의 70% 이상을 3D 전장이 차지.
3. 청록/호박/백색/적색 진영색 규율.
4. 중앙 케심섬, 북측 이란, 남동 무산담의 즉시 식별.
5. 항모전단·고속정 스웜·유조선·기뢰밭이 한 프레임에서 식별.
6. 미사일 궤적과 요격 섬광이 30초 안에 최소 1회 재생.
7. HUD가 좌상·우상·중하·최하단 네 구역만 점유.
8. PC와 모바일 모두 작은 글자 없이 선택 버튼과 계기판을 읽을 수 있음.

## 9. 개발 순서

1. STEP 0A: 절차형 핵심 객체와 HUD로 `mockup.html` 제작.
2. STEP 0B: `?q=basic|rich|cinematic` 품질 사다리와 반응형 화면 구현.
3. STEP 0C: PC/모바일 6장 캡처 후 아트 일치 검수.
4. M1: 3D와 분리된 룰 코어·데이터·저장.
5. M2: 고유 유닛 16종과 실제 해안선으로 교체.
6. M3: 랭킹·공유.
7. M4: 재연·영문·공개 패키징.

## 10. Three.js 동봉 파일

Three.js r185의 `three.module.js`는 내부에서 `./three.core.js`를 import한다. 따라서 CDN 없이 실행하려면 아래 두 파일을 같은 폴더에 동봉해야 한다.

| 파일 | 원본 |
|---|---|
| `assets/js/vendor/three.module.js` | `../catAgentGame/node_modules/three/build/three.module.js` |
| `assets/js/vendor/three.core.js` | `../catAgentGame/node_modules/three/build/three.core.js` |

`three.module.js` 단독 복사는 r185에서 모듈 진입이 실패한다. 이는 프레임워크·package.json 추가가 아니라 정본이 지정한 r185 모듈의 필수 동봉 의존성이다.

## 11. 최종 고품질 모델 생산 — Meshy 6

절차형 모델은 STEP 0의 배치·카메라·HUD 검증용 프록시로만 유지한다. M2 최종 유닛은 `catAgentGame`에서 검증한 아래 파이프라인으로 교체한다.

```
단일 객체 기준 이미지
→ Meshy 6 image-to-3D
→ GLB / triangle / 40,000 poly / 4K base color
→ remove_lighting
→ 웹용 2K 텍스처 최적화
→ Three.js GLTFLoader
→ 진영색 emissive·외곽선·글로우 런타임 합성
```

### 검증된 참고값

| 항목 | `catAgentGame` 검증값 | 호르무즈 적용 |
|---|---:|---:|
| Meshy 모델 | meshy-6 | meshy-6 |
| 생성 방식 | image-to-3D | image-to-3D |
| 출력 | GLB | GLB |
| 폴리곤 | 40,000 | 중요 함선 40,000 / 소형 유닛 10,000~20,000 |
| 텍스처 | 4K 생성 → 2K 웹 최적화 | 동일 |
| 조명 제거 | true | true |
| PBR | false | false, 런타임 홀로그램 재질 합성 |
| 실제 소비 | 객체당 30크레딧 | 1차 2종 60크레딧 |

### 1차 품질 게이트

| 순서 | 객체 | 기준 이미지 | 예상 크레딧 |
|---:|---|---|---:|
| 1 | 니미츠급 항모 | `assets/meshy-references/ships-v1/nimitz-carrier-reference-v1.png` | 30 |
| 2 | 알레이버크급 구축함 | `assets/meshy-references/ships-v1/arleigh-burke-destroyer-reference-v1.png` | 30 |

두 모델을 `mockup.html?q=cinematic`에 넣어 승인 기준 이미지와 비교한다. 이 게이트를 통과하기 전에는 나머지 14종을 대량 생성하지 않는다.

### 전체 생산 비용 상한

16종을 모두 Meshy 6 image-to-3D 최고 설정으로 새로 생성하면 최대 약 480크레딧이다. 실제로는 공용 모델·인스턴싱·프록시 유지가 가능한 소형 유닛을 제외해 크레딧을 줄인다. 각 묶음 시작 전 비용을 별도 확인한다.

## 12. Meshy 6 1차 품질 게이트 결과

2026-07-27 사장님 승인 후 함선 대표 2종을 생성하고 실제 Three.js 화면에 연결했다.

| 객체 | 작업 ID | 크레딧 | 실제 삼각형 | 원본 GLB | 웹 GLB |
|---|---|---:|---:|---:|---:|
| 니미츠급 항공모함 | `019fa2c9-b689-7d8c-b3db-2f802de7b000` | 30 | 40,298 | 15,326,048B | 2,761,768B |
| 알레이버크급 구축함 | `019fa2c9-ddc7-7d95-8aa4-0478159f20bf` | 30 | 41,000 | 15,423,880B | 2,798,764B |

- 생성 결과·설정 정본: `assets/models/ships-v1/meshy6-tasks.json`
- 전체 UI 통합 테스트: `mockup.html?q=cinematic`
- 함선 확대 품질 테스트: `output/step0/meshy-ship-quality-gate.html`
- 검증 결과: PC 1600×900 및 모바일 430×932에서 GLB 로딩 성공, 콘솔 오류 0건.
- 기존 절차형 항공모함·구축함은 로딩 오류 시에만 나타나는 폴백으로 유지했다.
- 다음 유료 묶음은 별도 비용 승인 전까지 생성하지 않는다.

## 13. CINEMATIC v4 전략 줌 품질 게이트

`mockup.html?q=cinematic`은 원거리 전략 화면에서 승인 콘셉트의 디테일을 유지하기 위해 아래 순서로 합성한다.

1. 고해상도 호르무즈 클린 플레이트.
2. 투명 PNG 전략 LOD 4종: 항모전단·유조선·고속정·항만 크레인.
3. 코드 렌더 전술 항로·방어권·기뢰밭·타격 섬광.
4. 실제 Three.js 장면을 낮은 불투명도로 합성해 동적 깊이와 전환을 유지.
5. basic·rich 또는 근접 품질 게이트에서는 실제 Meshy GLB와 절차형 폴백을 사용.

이 방식은 전략 줌에서 작은 3D 메시를 그대로 축소해 생기는 실루엣 손실을 막고, 실제 3D 자산이 추가될 때 같은 위치에 단계적으로 교체할 수 있다.

- 기준 대조 이미지: `output/step0/quality-comparison-concept-vs-v4-3200x900.png`
- 드래그 비교 도구: `output/step0/quality-comparison-concept-vs-v4.html`
- v4 PC 캡처: `output/step0/mockup-meshy-cinematic-v4-desktop-1600x900.png`
- v4 모바일 캡처: `output/step0/mockup-meshy-cinematic-v4-mobile-430x932.png`
- 상세 판정: `docs/hormuz-step0-quality-audit-v4.md`

전략 화면의 구도·색상 규율·객체 식별성·HUD 가독성은 STEP 0 승인 기준 범위에 도달했다. 다만 실제 고유 3D 모델은 16종 중 2종만 생성되었으므로 M2 3D 자산 완성도와 동일시하지 않는다.

## 14. Meshy 6 전략 객체 2차 묶음 결과

2026-07-27 사장님이 승인한 120크레딧 범위에서 유조선·IRGC 고속정·항만 크레인·연안 TEL을 생성했다.

| 객체 | 작업 ID | 상태 | 보고 차감 | 웹 GLB |
|---|---|---|---:|---:|
| VLCC 유조선 | `019fa32d-d0d7-7cce-826f-b230299ba125` | 성공 | 30 | 3,282,288B |
| IRGC 고속정 | `019fa32d-da1f-7da9-aa8a-79f857ec1f51` | Meshy 서버 timeout 실패 | 30 | 절차형 폴백 유지 |
| 항만 갠트리 크레인 | `019fa32d-e327-7cdf-8397-89627a3204d5` | 성공 | 30 | 3,828,652B |
| 연안 방어 TEL | `019fa32d-eca6-7cec-a0aa-7f5025060864` | 성공 | 30 | 3,374,808B |

- 작업·설정 정본: `assets/models/strategic-v1/meshy6-tasks.json`
- 확대 검수: `output/step0/meshy-ship-quality-gate.html`
- 실제 GLB 총수: 5종(기존 항모·구축함 + 신규 유조선·크레인·TEL).
- 16종 유닛 목록 중 실제 Meshy 완료: 항모·구축함·유조선·TEL 4종, 25%.
- 크레인은 환경 객체이므로 16종 유닛 생산률에는 포함하지 않는다.
- 고속정 재시도는 이번 승인액을 넘기므로 별도 30크레딧 승인 전에는 실행하지 않는다.

`mockup.html`은 각 전략 모델을 독립적으로 로딩한다. 한 모델이 실패해도 성공한 모델은 그대로 사용하고, 실패한 종류만 절차형 프록시를 유지한다.

## 15. Meshy 6 직접 전투 객체 3차 묶음 결과

2026-07-27 사장님이 승인한 120크레딧 범위에서 직접 조종 전력 3종과 IRGC 고속정을 Meshy 6 최고 설정으로 생성했다.

| 객체 | 작업 ID | 크레딧 | 원본 GLB | 웹 GLB |
|---|---|---:|---:|---:|
| F/A-18E Super Hornet | `019fa3d8-8e5a-73c2-bb29-88456f1f7863` | 30 | 14,075,884B | 2,349,184B |
| MH-60R Seahawk | `019fa3d8-c206-799d-8f0f-7f5f6328454f` | 30 | 15,349,736B | 3,014,480B |
| MCM USV | `019fa3d8-e217-73ce-9066-e8e122683fc7` | 30 | 13,666,852B | 3,066,856B |
| IRGC Fast Attack Craft | `019fa3d9-0734-7a9f-a3c0-f32fac719b2d` | 30 | 15,062,820B | 2,790,380B |

- 생성·최적화 정본: `assets/models/combat-v1/meshy6-tasks.json`
- 입력 기준 이미지는 내장 ImageGen으로 단일 객체·중립 배경·PBR 제품 렌더 방식으로 생성했다. 기존 고속정 기준 이미지는 재사용했다.
- 품질 게이트: `output/validation/meshy-combat-quality-gate-v1.html`
- 본게임 연결: F/A-18E·MH-60R·USV는 직접 조종 전력, IRGC 고속정은 전략 화면과 격침 임무 표적에 사용한다.
- Meshy가 생성한 선수·기수 로컬 X축을 게임의 전진 Z축에 맞추기 위해 Y축 `+90°` 보정을 적용했다.
- 최종 실제 Meshy GLB는 9종이다. 16종 유닛 목록 중 실제 Meshy 완료는 항모·구축함·유조선·TEL·F/A-18E·MH-60R·USV·IRGC 고속정 8종, 50%다. 크레인은 환경 객체로 별도다.

## 16. 전투 런타임 LOD 규율 (2026-07-29)

Meshy 원본은 객체당 40,000 삼각형대다. 이것을 전투 화면에 그대로 넣으면 유닛 몇 기만으로 120,000 삼각형 상한을 넘긴다. 따라서 **런타임에 쓰는 모델은 항상 감축본이며, 원본 GLB는 보관용이다.**

### 런타임 사용 모델

| 유닛 | 런타임 GLB | 삼각형 | 원본 대비 |
|---|---|---:|---:|
| 니미츠급 항모 | `ships-v1/nimitz-carrier-meshy6-web-strategic-v1.glb` | 14,103 | 35% |
| 알레이버크급 구축함 | `ships-v1/arleigh-burke-destroyer-meshy6-web-squad-v1.glb` | 9,333 | 23% |
| VLCC 유조선 | `strategic-v1/vlcc-tanker-meshy6-web-strategic-v2.glb` | 12,000 | 29% |
| 연안 TEL | `strategic-v1/coastal-defense-tel-meshy6-web-strategic-v2.glb` | 17,563 | 43% |
| IRGC 고속정 | `combat-v1/irgc-fast-attack-craft-meshy6-web-strategic-v4.glb` | 10,172 | 25% |
| MCM USV | `combat-v1/mcm-usv-meshy6-web-battle-lod-v1.glb` | 17,767 | 44% |
| F/A-18E (선두) | `combat-v1/fa-18e-super-hornet-meshy6-web-squad-v1.glb` | 6,415 | 16% |
| F/A-18E (편대기·공중 위협) | `combat-v1/fa-18e-super-hornet-meshy6-web-wingman-v1.glb` | 3,833 | 10% |
| MH-60R | `combat-v1/mh-60r-seahawk-meshy6-web-lod3-v1.glb` | 13,323 | 32% |
| 해병·IRGC 지상군 | `combined-arms-v1/*-rigged-web-v1.glb` | 2,518 / 2,407 | Meshopt·WebP 최적화 |

### 감축 방법

Meshy 리메시(유료) 대신 로컬 `@gltf-transform/cli` + meshoptimizer 단순화를 쓴다. 크레딧이 들지 않고 텍스처를 그대로 유지한다.

```
dedup → weld → simplify(ratio, error) → prune
```

UV 이음매가 잠금 경계로 작동해 대략 원본의 40~45%가 실질 하한이다. 그보다 더 줄여야 하면 Meshy 리메시로 새 변형을 받아야 한다. 생성 기록은 `assets/models/battle-lod-report-v1.json`에 남긴다.

### 성능 헌법 준수 규칙

1. 유닛을 추가하거나 모델을 바꾸면 **6개 시나리오 전부를 실제 브라우저에서 다시 측정한다.** 한 시나리오만 보면 안 된다.
2. 상한은 삼각형 120,000, 드로콜 90이다. 2026-07-30 v108 기준 최대치는 `convoy_shield` 116,514 / 61이며, `tanker_rescue`는 114,268 / 47이다.
3. 대규모 전투는 모든 전략 유닛을 **Meshy 원본에서 만든 초경량 LOD**로 통일한다. 절차형 기본 도형은 금지하며, 소규모·근접 전투에서는 기존 정밀 Meshy LOD를 유지한다.
4. 새 유닛 종류를 도입할 때는 감축본을 먼저 만들고 그 경로를 `rts-combat.json`에 넣는다. 원본 `-web-v1.glb`를 런타임 경로로 쓰지 않는다.

## 17. Meshy 결합병과 추가 자산 (v87)

사용자가 새 객체는 Meshy API로 생성하도록 승인한 범위에서 아래 5종을 Meshy T2 Image-to-3D로 만들었다. 보병 2종은 Meshy 리깅과 전진 사격 보행 애니메이션까지 생성했다. 생성·리깅·애니메이션 총 사용량은 91크레딧이다.

| 객체 | 런타임 GLB | 삼각형 | 적용 |
|---|---|---:|---|
| B-2A 스피릿 | `combined-arms-v1/b2-spirit-meshy-t2-web-v1.glb` | 5,572 | 폭격기 편대 2기 |
| 미 해병 소총수 | `combined-arms-v1/us-marine-rifleman-meshy-rigged-web-v1.glb` | 2,518 | 아군 지상군 8명 |
| IRGC 지상 전투원 | `combined-arms-v1/irgc-ground-combatant-meshy-rigged-web-v1.glb` | 2,407 | 적 지상군 12명 |
| M27형 소총 | `combined-arms-v1/m27-rifle-meshy-t2-web-v1.glb` | 820 이하 | 미 해병 장비 |
| AK형 소총 | `combined-arms-v1/ak-rifle-meshy-t2-web-v1.glb` | 826 이하 | IRGC 장비 |

- 미 해병 8명은 `ready`, `low-ready-walk`, `rifle-up-walk`, `aim-fire` 네 상태를 실제 스킨 애니메이션으로 전환한다.
- 적 지상군 12명은 Meshy 전투 자세와 AK형 소총을 유지하면서 3명씩 4개 공간 분대로 인스턴싱한다. 개별 이동·선택·피격·공격 판정은 그대로 유지한다.
- 원본 Meshy 작업 ID·크레딧·다운로드 기록은 `assets/meshy-source/combined-arms-v1/meshy-combined-arms-tasks-v1.json`이 정본이다.
- 입력 기준 이미지는 `assets/meshy-references/combined-arms-v1/` 아래 5개 PNG다.
- v87 Google 3D 결합병과 검증은 54,260삼각형·34드로콜, 오류 0건으로 통과했다.

## 18. 대규모 전투 Meshy 초경량 LOD와 배치 복구 (v101)

대규모 전투의 고속정·유조선·TEL·편대기 등을 절차형 기본 도형으로 바꾸던 성능 폴백을 폐기했다. 기존 Meshy 생성 GLB의 실루엣과 법선을 유지한 444~1,196삼각형 원거리 LOD 9종을 만들었으며 유료 크레딧은 쓰지 않았다. 초감축 과정에서 깨지던 텍스처 아틀라스 UV는 제거하고, 병종별 군용 PBR 팔레트와 높이·상면 명암을 `COLOR_0`에 구워 Google 3D 지도에서 검은 얼룩이나 형광 팀 색 없이 표시한다.

| 유닛 | 초경량 Meshy GLB | 삼각형 |
|---|---|---:|
| B-2A | `battle-ultra-v2/b2-spirit-meshy-ultra-v2.glb` | 444 |
| IRGC 고속정 | `battle-ultra-v2/irgc-fast-attack-craft-meshy-ultra-v2.glb` | 474 |
| F/A-18E | `battle-ultra-v2/fa-18e-super-hornet-meshy-ultra-v2.glb` | 478 |
| MCM USV | `battle-ultra-v2/mcm-usv-meshy-ultra-v2.glb` | 596 |
| MH-60R | `battle-ultra-v2/mh-60r-seahawk-meshy-ultra-v2.glb` | 653 |
| 연안 TEL | `battle-ultra-v2/coastal-defense-tel-meshy-ultra-v2.glb` | 707 |
| 알레이버크급 구축함 | `battle-ultra-v2/arleigh-burke-destroyer-meshy-ultra-v2.glb` | 890 |
| VLCC 유조선 | `battle-ultra-v2/vlcc-tanker-meshy-ultra-v2.glb` | 971 |
| 니미츠급 항모 | `battle-ultra-v2/nimitz-carrier-meshy-ultra-v2.glb` | 1,196 |

- 절반 경량화한 대규모전 전략 유닛 41기와 헬기 3대는 모두 Meshy 계열 모델이다. 절차형 전략 유닛 폴백은 0기다.
- 지상군은 유닛 반경 전체가 해안선 안쪽인 좌표만 사용한다. 이동 명령도 같은 육지 내부 조건으로 보정한다.
- Meshy 리그의 트랙당 키프레임 1개짜리 정적 T포즈는 유휴 클립에서 제외한다. 정지 시 전진 사격 애니메이션의 경계 자세 프레임을 사용한다.
- v101 전체 대규모전은 67,045삼각형·55드로콜, 해상·지상 배치 이탈과 콘솔·HTTP 오류 0건으로 통과했다.
- 생성 정본은 `tools/make-meshy-ultra-lods-v2.ps1`과 `tools/make-meshy-ultra-lods-v2.cjs`, 결과 기록은 `assets/models/battle-ultra-v2/meshy-ultra-lod-report-v2.json`이다.
- 검증 화면은 `output/validation/hormuz-rts-v101-strategic-visibility-1920x1080.jpg`와 `output/validation/hormuz-rts-v101-meshy-combined-arms-1920x1080.jpg`다.

## 19. 나포 유조선 3단계 구출 작전 (v108)

작전 04 `tanker_rescue`는 라락섬 남동 해역에서 진행하는 실제 RTS 임무다. 별도 미니게임이나 1인칭 화면을 쓰지 않고 기존 3D 전장의 선택·이동·공격 명령만 재사용한다.

1. 이란 고속정 6척을 차단한다.
2. 구조 헬기를 유조선 구조 원 안에 5초 동안 유지한다.
3. 확보된 유조선이 안전 해역으로 빠질 때까지 엄호한다.

- 기본 아군: 구축함 1척, 전투기 1대, 헬기 1대, 무인수상정 1척.
- 헬기를 0대로 정할 수는 있지만 임무 시작은 막고 필요한 이유를 한국어로 표시한다.
- 구조 유조선과 이란 고속정은 기존 Meshy 저폴리곤 모델을 공유해 신규 크레딧을 쓰지 않았다.
- 본편 연결: 카드 `marine_rescue`, 사건 `tanker_seizure`, 직접 미션 별칭 `rescue`가 모두 `tanker_rescue`로 연결된다.
- v108 실측: 114,268삼각형 / 47드로콜, 콘솔·페이지·HTTP 오류 0건, 해상 유닛 육지 침범 0건.
- 검증 정본: `output/validation/hormuz-rts-v108-final2-scenario-matrix-validation.json`, `output/validation/hormuz-rts-v108-final-force-selection-evasion-validation.json`, `output/validation/hormuz-v108-final-mission-routing-validation.json`.

## 20. 전 진영 유닛 물리 간격 규율 (v109)

유닛 이동은 같은 팀의 대형만 피하는 방식이 아니라 **같은 물리 영역에 있는 모든 진영·민간 유닛**을 장애물로 처리한다.

- 수면 함정은 수면 함정, 지상 유닛은 지상 유닛, 같은 고도의 공중 유닛끼리 충돌 반경 합계를 최소 간격으로 사용한다.
- 접근 중에는 감속과 좌우 우회를 적용하고, 다음 이동 위치가 다른 선체 내부로 들어가면 해당 프레임의 이동을 차단한다.
- 동시에 이동해 간격이 깨지면 프레임 끝에 양쪽을 분리한다. 고정 유닛과 구조 전 나포 유조선은 움직이지 않고 상대 유닛만 밀려난다.
- 민간 유조선의 항로 이동에도 동일한 충돌 차단을 적용한다. 수면 함정이 항로를 막으면 관통하지 않고 정지한다.
- 구조 헬기는 공중 유닛이므로 수면 유조선 위 구조 원에 진입할 수 있다. 고도 차가 충분한 항공기끼리도 불필요하게 충돌하지 않는다.
- v109 자동 횡단 시험에서 구축함과 나포 유조선의 최소 간격 비율은 0.980, 최종 겹침 0건이며 구축함은 유조선을 우회해 반대편으로 이동했다.
- 검증 정본: `output/validation/hormuz-rts-v109-final-force-selection-evasion-validation.json`, 화면: `output/validation/hormuz-rts-v109-final-google-unit-collision-1920x1080.jpg`.

## 21. 곡괭이산 B-2·GBU-57 제한 타격 (v110)

작전 06 `pickaxe_strike`를 `pickaxe_mountain` 3D RTS 시나리오로 추가했다. 이 작전은 공개자료에서 확인되지 않은 내용을 사실처럼 단정하지 않는 것이 전투 규칙만큼 중요하다.

- 곡괭이산은 나탄즈 농축시설 자체가 아니라 나탄즈 남쪽에 별도로 건설 중인 지하 복합시설로 표기한다.
- IAEA가 용도·내부 배치·핵물질 반입 여부를 확인하지 못했으므로 “핵시설 완전 파괴” 판정을 쓰지 않는다.
- 공개 운용 기준 GBU-57을 투하하는 B-2A 스피릿만 출격할 수 있다. B-2는 전투기가 아니라 스텔스 전략폭격기다.
- B-2가 0대면 임무 시작을 막고, `GBU-57은 B-2만 운반할 수 있습니다`라는 이유를 표시한다.
- B-2 한 대당 GBU-57은 2발이다. 실제 발사체가 지하 진입부에 충돌해야 피해가 들어가며 세 번째 발사는 거부한다.
- 필수 목표는 지하 진입부 2곳뿐이다. 주변 방공 발사 차량 3기는 선택 표적이며, 파괴하지 않아도 성공할 수 있다.
- 승리 결과는 `진입부 봉쇄 · 내부 피해평가 미확정`으로 끝난다.
- Google 3D 실제 지형을 기본으로 사용하고, 로컬 폴백에도 밝은 산악 능선·분지·암반 텍스처를 추가했다.
- 브리핑과 결과는 곡괭이산 전용 이미지로 교체했다. 해협 해전 이미지를 재사용하지 않는다.

공개자료 정리와 표현 금지 목록은 `docs/hormuz-pickaxe-mountain-research-v1.md`가 정본이다. 기능 검증은 `tools/validate-pickaxe-strike.py`가 담당하며 편성 제한, 2발 충돌, 세 번째 발사 거부, 선택 표적 제외, 승리 판정, Meshy B-2 로딩, Google 3D 연결을 실제 브라우저에서 확인한다.

## 전투 목표물 2종 생성 (2026-08-04)

전투 객체 전수조사에서 모델이 아예 없던 것은 둘뿐이었다. 화면에서 기뢰는 빨간
표식처럼, 지하 진입부는 절차형 도형으로 보였다. 사장님 승인 범위 60크레딧 안에서
Meshy 5 text-to-3d(preview + refine)로 만들었고 **실제 사용은 30크레딧**이다.
움직이지 않는 물체라 리깅·애니메이션은 만들지 않았다.

| 객체 | 미리보기 | 다듬기 | 크레딧 | 삼각형 | 원본 GLB | 웹 GLB |
|---|---|---|---|---|---|---|
| 해상 기뢰 | 5 | 10 | 15 | 1,229 | `assets/meshy-source/objectives-v1/naval-mine/naval-mine-meshy-v1.glb` (2.1MB) | `assets/models/objectives-v1/naval-mine-meshy-web-v1.glb` (74KB) |
| 지하 진입부 | 5 | 10 | 15 | 1,414 | `assets/meshy-source/objectives-v1/bunker-entrance/bunker-entrance-meshy-v1.glb` (2.3MB) | `assets/models/objectives-v1/bunker-entrance-meshy-web-v1.glb` (62KB) |

- 생성 스크립트는 `tools/generate-meshy-objectives.mjs`가 정본이다. 승인 크레딧을
  넘으면 중단하도록 상한을 걸어 두었다. 작업 번호는 각 폴더의 `task.json`에 있다.
- 웹 GLB 는 `@gltf-transform/cli optimize --compress meshopt --texture-compress webp
  --texture-size 1024` 로 줄였다. 2MB 대에서 60~70KB 로 내려간다.
- ★ 모델만 붙이면 안 된다. 스폰의 `hero` 도 켜야 한다. 렌더 코드가
  `spawn.hero && !spawn.strategicLod` 일 때만 실제 모델을 쓰고, 아니면 절차형
  도형을 그린다. 모델을 붙이고도 도형이 그대로 나와 한 번 헛돌았다.

### 그때 함께 바로잡은 것

같은 조사에서 "유닛 11종이 임시 도형"이라고 봤는데 **오판이었다**. 유닛의 그룹에
달린 물 위 그림자 표식(높이 0의 평면, 288삼각형)을 유닛 본체로 세었다. 실제로는
대규모 전투의 배·항공기가 `strategic-instance-*` 인스턴스 메시로 정상 렌더링된다
(항모 1,196 · 구축함 3,057 · 고속정 474 삼각형). 유닛 삼각형을 잴 때는 그룹 전체를
훑지 말고 그림자·선택 표식을 빼야 한다.
