/*
 * HORMUZ Google 3D 지도 연동 예시 설정.
 * 이 파일을 google-maps-config.js로 복사한 뒤 발급받은 값을 입력한다.
 * 브라우저용 API 키는 화면에 노출되므로 반드시 HTTP 리퍼러와 API 종류를 제한한다.
 */
window.HORMUZ_GOOGLE_MAPS_CONFIG = Object.freeze({
  enabled: false,
  apiKey: "",
  mapId: "",
  language: "ko",
  region: "KR",
  provider: "webgl-overlay",
  fallbackProvider: "local-three"
});
