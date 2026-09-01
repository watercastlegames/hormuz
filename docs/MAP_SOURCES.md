# HORMUZ 지도 고증 출처

게임 전장은 동경 54.9~57.0도, 북위 25.0~27.3도를 사용한다. 첨부된 페르시아만 광역도에서 호르무즈 해협 원 안쪽을 확대한 범위다.

## 해안선·섬

- Natural Earth 1:10m `ne_10m_land`
- 원본 프로젝트: https://www.naturalearthdata.com/downloads/10m-physical-vectors/
- 라이선스: Public Domain
- 토폴로지 클리핑:
  `npx --yes mapshaper tools/sources/ne_10m_land.geojson -clip "bbox=54.9,25,57,27.3" -clean -simplify dp 8% keep-shapes -o format=geojson precision=0.000001 tools/sources/ne_10m_land_hormuz_clipped.geojson`
- 런타임 정규화: `python tools/build_coastline.py`
- 런타임 데이터: `assets/data/coastline.json`

기존 단일 링 클리퍼는 화면 밖에서 연결된 이란·아라비아 본토를 한 면으로
이어 자기교차를 만들었다. 현재는 Mapshaper의 MultiPolygon 결과를 보존해
이란 본토와 아라비아반도를 서로 다른 두 폴리곤으로 유지한다. 결과는
18개 폴리곤, 자기교차 0건이다.

## 통항분리대(TSS)

- IMO Resolution A.161 (ES.IV), 1968-11-27, Hormuz Strait section.
- 분리대 중심점:
  - 26°27.2′N, 56°22.8′E
  - 26°27.2′N, 56°30.3′E
  - 26°26.2′N, 56°33.9′E
  - 26°21.4′N, 56°37.9′E
- 공식 문서상 분리대 폭 1해리, 남측 통항로 폭 1.5해리.
- IMO 현재 안내 페이지도 이란·오만이 제안하고 1968년 채택된 기존 TSS를 사용한다고 명시한다.

서쪽 접근부는 게임 화면 범위 안에서 항로 연결을 이해시키기 위한 시각화다. 공식 중심점과 혼동하지 않도록 `approachVisualization`으로 별도 저장한다.

## 지명·방향 검수

- 이란 본토: 전장 북쪽.
- 오만 무산담 반도: 전장 남동쪽.
- 케심섬: 전장 중앙~서쪽의 길고 큰 섬.
- 호르무즈·라라크섬: 최협부 북쪽.
- 페르시아만: 서쪽, 오만만: 동쪽.

경도는 중앙 위도 26.15도의 축척을 반영한다. 전장 실제 비율은 동서 약
209.8km, 남북 약 256.0km, 가로/세로 약 0.820이며 Three.js 월드는
112×136.6(약 0.820)으로 맞춘다. `?mapcheck=1&autostart=1`은 북쪽이 위인
정사영 검수 화면으로, 일반 게임 카메라의 원근·기울기와 분리해 확인한다.

이 데이터는 게임·교육용 시각화이며 항해용 해도가 아니다.
