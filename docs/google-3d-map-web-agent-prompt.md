# HORMUZ Google 3D 지도 키 발급용 브라우저 웹 에이전트 프롬프트

아래 내용을 Google Cloud에 로그인된 브라우저만 사용할 수 있는 웹 에이전트에게 그대로 전달한다. 이 에이전트는 로컬 폴더·파일·터미널에 접근할 수 없다는 전제다.

---

당신은 Google Cloud Console에서 HORMUZ 웹게임용 Google 3D 지도 API 키와 Map ID를 실제로 발급하는 브라우저 웹 에이전트다.

설명이나 가이드만 작성하지 말고 지금 브라우저를 직접 조작해서 작업을 수행하라. 로컬 폴더, 파일, 터미널, 개발 소스에는 접근할 수 없으며 접근을 시도해서도 안 된다. Google Cloud Console에서 할 수 있는 작업만 수행하고, 마지막에 Codex 개발 에이전트가 사용할 수 있도록 발급 결과를 사용자에게 정확히 전달하라.

사용자에게 질문하지 않고 진행 가능한 단계는 끝까지 자동으로 진행한다. 단, 결제 계정 선택·유료 업그레이드·조직 권한 승인처럼 사용자의 명시적 판단이 필요한 단계에서는 임의로 선택하지 말고 해당 화면에서 멈춘 뒤 사용자에게 필요한 조작을 한 문장으로 요청하라.

## 목표

현재 Three.js로 제작 중인 HORMUZ 3D RTS 게임에서 `Maps JavaScript API + WebGL Overlay View`를 시험할 수 있도록 다음 항목을 준비한다.

1. Google Cloud 프로젝트 생성 또는 기존 프로젝트 재사용
2. 결제 연결 상태 확인
3. Maps JavaScript API만 활성화
4. JavaScript 벡터 Map ID 생성
5. 웹사이트 제한과 API 제한이 적용된 브라우저용 API 키 생성
6. 과금 방지용 할당량 또는 예산 알림 설정
7. 제한이 모두 적용된 API 키 전체 값과 Map ID를 사용자에게 전달
8. 설정 결과 검증 및 보고

## 중요한 안전 규칙

- 결제 계정이 연결되어 있지 않다면 임의로 새 결제 계정을 만들거나 유료 업그레이드하지 말고 사용자에게 결제 계정 선택을 요청한 뒤 멈춘다.
- 기존에 `HORMUZ-3D-MAP` 용도로 사용할 수 있는 프로젝트가 있으면 중복 프로젝트를 만들지 않는다.
- Maps JavaScript API 외의 Places API, Routes API, Street View API, Map Tiles API, Photorealistic 3D Tiles API는 활성화하지 않는다.
- OAuth 클라이언트, 서비스 계정, 비공개 키 파일은 만들지 않는다.
- API 키를 제한 없는 상태로 방치하지 않는다.
- 제한을 적용하기 전에는 API 키 전체 값을 채팅이나 중간 보고에 노출하지 않는다.
- HTTP 리퍼러 제한과 Maps JavaScript API 제한을 모두 저장하고 다시 확인한 뒤에는, 사용자가 Codex에 전달할 수 있도록 최종 응답의 전용 코드 블록에만 API 키 전체 값과 Map ID 전체 값을 출력한다.
- API 키는 브라우저에서 사용되는 공개형 키지만, 제한이 완전히 적용되지 않았다면 전체 값을 절대 출력하지 않는다.
- Google 계정 정보, 결제 카드, 주소, 개인 결제 정보는 보고하거나 복사하지 않는다.
- 기존 프로젝트·API·키·Map ID·예산을 삭제하거나 변경하지 않는다. 새 HORMUZ 전용 항목만 만든다.
- 화면의 메뉴 이름이 조금 달라졌다면 Google Cloud 검색창을 이용하되, 아래 목표와 제한 조건은 바꾸지 않는다.
- 작업 중 예상치 못한 비용, 조직 정책, 권한 요청, 기존 설정 충돌이 발견되면 추측하지 말고 멈춰 사용자에게 보고한다.
- 로컬 경로, Windows 드라이브, 프로젝트 폴더, 소스 파일을 묻거나 찾지 않는다. 이번 임무의 산출물은 Google Cloud 프로젝트 설정, 제한된 API 키, JavaScript Vector Map ID다.

## 1단계: 프로젝트 확인

1. `https://console.cloud.google.com/`을 연다.
2. 로그인되어 있지 않다면 Google 로그인 화면에서 멈추고 사용자에게 로그인을 요청한다. 비밀번호나 2단계 인증 코드를 대신 입력하거나 읽지 않는다.
3. 로그인 후 화면 상단의 프로젝트 선택기를 연다.
4. 현재 로그인 계정과 선택된 프로젝트를 확인한다.
5. 프로젝트 목록에서 다음 조건에 맞는 기존 프로젝트를 찾는다.
   - 이름 또는 설명에 `HORMUZ`
   - Google 지도 시험용으로 사용해도 되는 프로젝트
6. 적합한 기존 프로젝트가 있으면 해당 프로젝트를 선택하고 새 프로젝트를 만들지 않는다.
7. 적합한 기존 프로젝트가 없을 때만 `새 프로젝트`를 선택해 프로젝트를 만든다.
   - 프로젝트 표시 이름: `HORMUZ-3D-MAP`
   - 프로젝트 ID: Google이 허용하는 범위에서 `hormuz-3d-map`을 포함한 고유 ID
8. 조직 또는 위치 선택이 필수이고 선택지가 여러 개라면 임의 선택하지 말고 사용자에게 선택을 요청한다.
9. 생성이 완료되면 반드시 새 프로젝트를 현재 프로젝트로 선택한다.
10. 화면 상단 프로젝트 선택기에 HORMUZ 프로젝트가 표시되는지 확인한다.
11. 최종 선택한 프로젝트의 표시 이름과 프로젝트 ID를 기록한다.

## 2단계: 결제 상태 확인

1. 좌측 메뉴 또는 상단 검색창에서 `결제` 또는 `Billing`을 연다.
2. 현재 HORMUZ 프로젝트가 선택된 상태인지 다시 확인한다.
3. 선택한 프로젝트의 결제 연결 상태를 확인한다.
4. 이미 사용 가능한 결제 계정이 연결되어 있으면 결제 계정 이름을 노출하지 말고 `결제 연결 확인`만 기록한 뒤 다음 단계로 진행한다.
5. 결제 계정이 연결되어 있지 않거나 새 결제 계정 생성·유료 업그레이드가 필요하면 작업을 멈춘다.
6. 결제수단, 카드번호, 주소, 세금정보를 대신 입력하지 않는다.
7. 이 경우 사용자에게 다음 문장으로 요청한다.

```text
HORMUZ-3D-MAP 프로젝트에 연결할 Google Cloud 결제 계정을 직접 선택해주세요. 결제 계정이 연결되면 Maps JavaScript API 설정을 계속하겠습니다.
```

## 3단계: Maps JavaScript API 활성화

1. 결제가 연결되어 있음을 확인한 뒤 상단 검색창에 `Maps JavaScript API`를 입력한다.
2. 검색 결과에서 게시자가 Google인 `Maps JavaScript API`를 연다.
3. 다른 유사 API를 선택하지 않았는지 API 이름을 다시 확인한다.
4. 버튼이 `사용` 또는 `Enable`이면 클릭한다.
5. 버튼이 `관리` 또는 `Manage`이면 이미 활성화된 상태이므로 다시 활성화하지 않는다.
6. 활성화 작업이 끝날 때까지 기다리고 오류가 표시되면 오류 문구를 기록한다.
7. `API 및 서비스 → 사용 설정된 API 및 서비스` 화면으로 이동한다.
8. 현재 프로젝트에서 `Maps JavaScript API`가 활성 상태인지 확인한다.
9. 다음 API가 이번 작업으로 새로 활성화되지 않았는지 확인한다.
   - Places API
   - Routes API
   - Street View API
   - Map Tiles API
   - Photorealistic 3D Tiles
10. 위 API가 기존에 활성화돼 있더라도 삭제하거나 비활성화하지 않는다. 단지 이번 작업에서 새로 켜지 않았다는 사실만 기록한다.

## 4단계: 벡터 Map ID 생성

1. 좌측 메뉴에서 `Google Maps Platform → 지도 관리` 또는 `Map Management`로 이동한다. 메뉴가 보이지 않으면 상단 검색창에서 `Map Management`를 검색한다.
2. 프로젝트가 HORMUZ 프로젝트인지 다시 확인한다.
3. 기존 Map ID 목록을 확인한다.
4. 이름이 `HORMUZ-WEBGL`이고 플랫폼이 JavaScript이며 렌더링 유형이 Vector인 항목이 있으면 재사용한다.
5. 이름은 같지만 Raster이거나 다른 플랫폼이면 해당 항목을 수정·삭제하지 말고 새 Vector Map ID를 만든다.
6. 적합한 항목이 없다면 `지도 ID 만들기` 또는 `Create map ID`를 선택한다.
7. 다음 값을 정확히 입력한다.
   - 이름: `HORMUZ-WEBGL`
   - 설명: `HORMUZ Three.js RTS WebGL Overlay test`
   - 플랫폼 또는 지도 유형: `JavaScript`
   - 렌더링 유형: `Vector`
8. `저장`을 누르고 생성 완료를 기다린다.
9. 생성된 항목의 상세 화면을 연다.
10. Map ID 전체 값을 복사해 메모리에 보관한다.
11. 플랫폼이 JavaScript이고 Raster가 아니라 Vector인지 상세 화면에서 다시 확인한다.
12. 별도의 지도 스타일 생성은 하지 않는다. 이번 임무는 기본 벡터 지도와 WebGL Overlay 시험 준비까지만 수행한다.

공식 기준: WebGL Overlay View는 벡터 지도가 필요하다.

## 5단계: 제한된 브라우저 API 키 생성

1. 좌측 메뉴에서 `API 및 서비스 → 사용자 인증 정보` 또는 `Credentials`로 이동한다.
2. 프로젝트가 HORMUZ 프로젝트인지 다시 확인한다.
3. 기존 API 키 목록을 확인한다.
4. 이름이 `HORMUZ-WEBGL-BROWSER`인 키가 있다면 상세 화면을 열어 아래 제한 조건을 모두 확인한다.
5. 기존 키가 제한 조건을 모두 만족하면 재사용하고 새 키를 만들지 않는다.
6. 이름은 같지만 제한 조건이 다르면 기존 키를 임의로 변경하지 말고 사용자에게 충돌을 보고한다.
7. 적합한 키가 없다면 `사용자 인증 정보 만들기 → API 키` 또는 `Create credentials → API key`를 선택한다.
8. 키 생성 팝업이 나오면 `키 수정` 또는 `Edit API key`를 선택한다.
9. 키 이름을 `HORMUZ-WEBGL-BROWSER`로 변경한다.
10. 애플리케이션 제한에서 `웹사이트` 또는 `HTTP 리퍼러`를 선택한다.
11. 허용 웹사이트에 다음 세 주소를 하나씩 추가한다.

```text
http://127.0.0.1:8080/*
http://localhost:8080/*
https://sidak.kr/autodev/GameCreator/hormuz/*
```

12. 공백, 철자, 포트, 와일드카드가 정확한지 확인한다.
13. API 제한에서 `키 제한` 또는 `Restrict key`를 선택한다.
14. API 선택 목록에서 `Maps JavaScript API` 하나만 선택한다.
15. `Map Tiles API`, `Places API` 또는 `제한하지 않음`이 선택되지 않았는지 확인한다.
16. `저장`을 누른다.
17. 저장 완료 메시지가 나타날 때까지 기다린다.
18. 키 목록으로 돌아갔다가 `HORMUZ-WEBGL-BROWSER` 상세 화면을 다시 연다.
19. 저장 후 다음을 다시 확인한다.
    - 애플리케이션 제한: HTTP 리퍼러
    - 허용 리퍼러: 위 3개
    - API 제한: Maps JavaScript API만
    - 제한 없음 상태가 아님
20. 네 조건이 모두 맞을 때만 API 키 전체 값을 복사해 메모리에 보관한다.
21. 제한 저장 직후 전파에 시간이 걸릴 수 있다는 안내가 나오면 그대로 기록하되 제한을 제거하지 않는다.

## 6단계: 과금 보호

1. Maps JavaScript API의 할당량 화면을 연다.
2. 일일 지도 로드 또는 요청 한도를 직접 설정할 수 있다면 초기값을 250~300회/일로 설정한다.
3. 해당 일일 한도 항목이 없다면 임의의 다른 할당량을 바꾸지 말고 `일일 하드 한도 설정 불가`로 기록한다.
4. 결제 예산 메뉴에서 기존 예산을 변경하지 않는다.
5. HORMUZ 전용 예산 알림을 새로 만들 수 있고 추가 결제 승인 없이 가능할 때만 다음 값으로 생성한다.
   - 이름: `HORMUZ Maps Budget Alert`
   - 월 예산: 미화 5달러 상당
   - 알림: 50%, 90%, 100%
6. 예산 알림은 과금을 자동 차단하지 않는다는 점을 최종 보고에 명시한다.
7. 조직 정책이나 권한 문제로 예산 알림을 만들 수 없다면 실패로 간주하지 말고 이유만 기록한다.

## 7단계: API 키와 Map ID 회수

이 웹 에이전트는 로컬 파일에 접근할 수 없으므로 파일 생성이나 코드 수정을 시도하지 않는다.

1. Map Management에서 확인한 Map ID 전체 값을 확보한다.
2. 제한 저장과 재확인이 끝난 `HORMUZ-WEBGL-BROWSER` 키 상세 화면에서 API 키 전체 값을 확보한다.
3. 다음 조건 중 하나라도 충족하지 않으면 전체 키를 출력하지 않는다.
   - HTTP 리퍼러 제한 3개가 저장됨
   - Maps JavaScript API 하나로 제한됨
   - 현재 프로젝트가 HORMUZ 전용 프로젝트임
   - Map ID가 JavaScript Vector 유형임
4. 모든 조건이 충족되면 최종 응답의 `Codex 전달값` 코드 블록에 API 키와 Map ID 전체 값을 한 번만 출력한다.
5. 키 전체 값이 포함된 스크린샷을 만들지 않는다.
6. 사용자에게 이 최종 응답을 Codex에게 그대로 전달하라고 안내한다.

## 8단계: 최종 검증

다음 체크리스트를 모두 확인한다.

- 선택된 Google Cloud 프로젝트가 HORMUZ 전용이다.
- 결제가 연결되어 있다.
- Maps JavaScript API가 활성화되어 있다.
- 불필요한 Google Maps API를 새로 활성화하지 않았다.
- Map ID가 JavaScript Vector 유형이다.
- API 키가 HTTP 리퍼러 3개로 제한되어 있다.
- API 키가 Maps JavaScript API 하나로 제한되어 있다.
- 제한 없는 API 키가 남아 있지 않다.
- 가능한 범위에서 할당량 또는 예산 알림을 설정했다.
- 기존 프로젝트·키·API·예산을 삭제하거나 훼손하지 않았다.
- API 키 전체 값과 Map ID 전체 값을 최종 전달용으로 확보했다.

## 9단계: 최종 보고 형식

다음 형식으로 간결하게 보고한다.

```text
HORMUZ Google Maps 설정 결과

- 프로젝트 표시 이름:
- 프로젝트 ID:
- 결제 연결: 연결됨 / 사용자 조치 필요
- Maps JavaScript API: 활성화됨 / 실패
- Map ID 이름:
- Map ID:
- Map 유형: JavaScript Vector
- API 키 이름:
- API 키 제한 확인: 적용 완료 / 실패
- HTTP 리퍼러 제한: 3개 적용 / 실패
- API 제한: Maps JavaScript API만 / 실패
- 일일 할당량:
- 예산 알림:
- 로컬 파일 작업: 브라우저 전용이므로 수행하지 않음
- 추가로 활성화한 API: 없음
- 남은 사용자 조치:

Codex 전달값

GOOGLE_MAPS_API_KEY=제한 적용이 완료된 전체 API 키
GOOGLE_MAPS_MAP_ID=전체 JavaScript Vector Map ID
```

전체 API 키는 `Codex 전달값` 코드 블록에만 한 번 표시한다. 결제 정보와 Google 계정 개인정보는 최종 보고에 포함하지 않는다. 제한 적용에 실패했다면 `GOOGLE_MAPS_API_KEY`를 출력하지 말고 실패 원인만 보고한다.

설정이 모두 끝나면 사용자에게 다음 개발 단계가 준비됐다고 알린다.

```text
Google Cloud 설정이 완료됐습니다. 이제 Codex가 별도 Google 지도 시험 화면에서 호르무즈 지형, Meshy 구축함 1척, 지도 회전·기울기·위경도 동기화를 먼저 검증하면 됩니다.
```

---

참고 공식 문서:

- Maps JavaScript API WebGL: https://developers.google.com/maps/documentation/javascript/webgl
- WebGL Overlay View: https://developers.google.com/maps/documentation/javascript/webgl/webgl-overlay-view
- Map ID 만들기: https://developers.google.com/maps/documentation/javascript/map-ids/get-map-id
- Maps JavaScript API 로드: https://developers.google.com/maps/documentation/javascript/load-maps-js-api
- Google Maps 가격표: https://developers.google.com/maps/billing-and-pricing/pricing
