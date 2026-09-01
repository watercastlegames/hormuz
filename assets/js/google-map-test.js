const CONFIG = window.HORMUZ_GOOGLE_MAPS_CONFIG || {};
const MODEL_BASE_SCALE = 4500;
const MODEL_SELECTED_SCALE = 4800;
const MODEL_RELATIVE_ALTITUDE = 900;

const REGIONS = Object.freeze({
  hormuz: {
    name: "호르무즈 해협",
    description: "무산담 반도와 이란 남부 사이의 실제 해안·산악 지형을 확인합니다.",
    center: { lat: 26.42, lng: 56.45, altitude: 1450 },
    range: 30500 / 3,
    tilt: 68,
    heading: 306,
    ship: { lat: 26.443, lng: 56.485, altitude: MODEL_RELATIVE_ALTITUDE, heading: 72 }
  },
  western_gulf: {
    name: "바레인·카타르 해역",
    description: "페르시아만 서부 공중 방어 전장의 실제 섬과 연안 지형을 확인합니다.",
    center: { lat: 25.86, lng: 51.18, altitude: 1650 },
    range: 43000 / 3,
    tilt: 65,
    heading: 330,
    ship: { lat: 25.94, lng: 50.82, altitude: MODEL_RELATIVE_ALTITUDE, heading: 42 }
  },
  gulf_of_oman: {
    name: "오만만",
    description: "푸자이라 동쪽 기뢰 회랑과 오만만 해안의 실제 지형을 확인합니다.",
    center: { lat: 25.28, lng: 57.12, altitude: 1600 },
    range: 39000 / 3,
    tilt: 66,
    heading: 292,
    ship: { lat: 25.22, lng: 56.9, altitude: MODEL_RELATIVE_ALTITUDE, heading: 88 }
  },
  bushehr: {
    name: "부셰르 연안",
    description: "연안 미사일 발사 차량 타격 전장의 실제 이란 남부 해안을 확인합니다.",
    center: { lat: 28.86, lng: 50.84, altitude: 1450 },
    range: 31500 / 3,
    tilt: 67,
    heading: 318,
    ship: { lat: 28.58, lng: 50.62, altitude: MODEL_RELATIVE_ALTITUDE, heading: 35 }
  }
});

const MODEL_URL = new URL(
  "assets/models/ships-v1/arleigh-burke-destroyer-meshy6-web-v1.glb",
  location.href
).href;
const MODEL_TILT = 270;
const MODEL_ROLL = 90;

const shell = document.getElementById("google-map-shell");
const host = document.getElementById("google-map-host");
const loadingLayer = document.getElementById("loading-layer");
const loadingDetail = document.getElementById("loading-detail");
const fatal = document.getElementById("fatal-error");
const fatalMessage = document.getElementById("fatal-message");
const missionTitle = document.getElementById("mission-title");
const missionDescription = document.getElementById("mission-description");
const coordinateValue = document.getElementById("coordinate-value");
const interactionStatus = document.getElementById("interaction-status");
const apiStatus = document.getElementById("status-api");
const mapStatus = document.getElementById("status-map");
const modelStatus = document.getElementById("status-model");

let map = null;
let shipModel = null;
let activeRegionId = "hormuz";
let selected = false;
let orbiting = false;

function setStatus(element, text, state) {
  element.textContent = text;
  element.className = `status-chip ${state}`;
}

function markMapReady() {
  if (shell.dataset.mapStatus === "ready") return;
  shell.dataset.mapStatus = "ready";
  setStatus(mapStatus, "실제 3D 지형 준비 완료", "ready");
  loadingLayer.classList.add("hidden");
  interactionStatus.textContent = "연결 완료. 지역을 바꾸거나 구축함 근접 보기를 눌러 확인하세요.";
}

function showFatal(message) {
  shell.dataset.mapStatus = "error";
  loadingLayer.classList.add("hidden");
  fatal.hidden = false;
  fatalMessage.textContent = message;
  setStatus(mapStatus, "3D 지형 연결 실패", "error");
}

function loadGoogleMapsApi() {
  if (!CONFIG.enabled) {
    return Promise.reject(new Error("Google 지도 설정이 비활성화되어 있습니다."));
  }
  if (!CONFIG.apiKey) {
    return Promise.reject(new Error("Google Maps API 키가 없습니다."));
  }
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const callbackName = "__HORMUZ_GOOGLE_MAPS_READY__";
    const timer = window.setTimeout(() => {
      reject(new Error("Google Maps API 응답 시간이 초과됐습니다."));
    }, 25000);
    window[callbackName] = () => {
      window.clearTimeout(timer);
      delete window[callbackName];
      resolve();
    };
    const script = document.createElement("script");
    const params = new URLSearchParams({
      loading: "async",
      key: CONFIG.apiKey,
      libraries: "maps3d",
      language: CONFIG.language || "ko",
      region: CONFIG.region || "KR",
      callback: callbackName
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("Google Maps JavaScript API 스크립트를 불러오지 못했습니다."));
    };
    document.head.append(script);
  });
}

async function verifyModelAsset() {
  const response = await fetch(MODEL_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Meshy 구축함 GLB HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length")) || 0;
  return contentLength;
}

function getCamera(region) {
  return {
    center: { ...region.center },
    range: region.range,
    tilt: region.tilt,
    heading: region.heading,
    roll: 0
  };
}

function updateRegionText(regionId) {
  const region = REGIONS[regionId];
  missionTitle.textContent = region.name;
  missionDescription.textContent = region.description;
  coordinateValue.textContent = `${region.center.lat.toFixed(2)}, ${region.center.lng.toFixed(2)}`;
  shell.dataset.activeRegion = regionId;
  document.querySelectorAll("[data-region]").forEach((button) => {
    button.classList.toggle("active", button.dataset.region === regionId);
  });
}

function updateShip(region) {
  if (!shipModel) return;
  shipModel.position = { ...region.ship };
  shipModel.orientation = {
    heading: region.ship.heading,
    tilt: MODEL_TILT,
    roll: MODEL_ROLL
  };
  shipModel.scale = selected ? MODEL_SELECTED_SCALE : MODEL_BASE_SCALE;
}

function moveToRegion(regionId, animate = true) {
  const region = REGIONS[regionId];
  if (!region || !map) return;
  activeRegionId = regionId;
  orbiting = false;
  map.stopCameraAnimation?.();
  updateRegionText(regionId);
  updateShip(region);
  const camera = getCamera(region);
  if (animate && typeof map.flyCameraTo === "function") {
    map.flyCameraTo({ endCamera: camera, durationMillis: 1800 });
  } else {
    map.center = camera.center;
    map.range = camera.range;
    map.tilt = camera.tilt;
    map.heading = camera.heading;
    map.roll = 0;
  }
  interactionStatus.textContent = `${region.name} 실제 3D 지형으로 이동했습니다.`;
}

function bindControls() {
  document.querySelectorAll("[data-region]").forEach((button) => {
    button.addEventListener("click", () => moveToRegion(button.dataset.region));
  });
  document.getElementById("reset-camera").addEventListener("click", () => {
    moveToRegion(activeRegionId, true);
  });
  document.getElementById("focus-ship").addEventListener("click", () => {
    if (!map || !shipModel) return;
    const region = REGIONS[activeRegionId];
    orbiting = false;
    map.stopCameraAnimation?.();
    map.flyCameraTo?.({
      endCamera: {
        center: {
          lat: region.ship.lat,
          lng: region.ship.lng,
          altitude: MODEL_RELATIVE_ALTITUDE
        },
        range: 10500,
        tilt: 69,
        heading: (region.ship.heading + 215) % 360,
        roll: 0
      },
      durationMillis: 1600
    });
    interactionStatus.textContent = "Meshy 구축함을 실제 지형 위에서 근접 확인합니다.";
  });
  document.getElementById("orbit-camera").addEventListener("click", () => {
    if (!map) return;
    if (orbiting) {
      map.stopCameraAnimation?.();
      orbiting = false;
      interactionStatus.textContent = "지형 회전을 멈췄습니다.";
      return;
    }
    const region = REGIONS[activeRegionId];
    orbiting = true;
    map.flyCameraAround?.({
      camera: getCamera(region),
      durationMillis: 18000,
      repeatCount: 1
    });
    interactionStatus.textContent = `${region.name} 지형을 한 바퀴 확인합니다.`;
  });
}

async function init() {
  loadingDetail.textContent = "Google Maps JavaScript API 키와 리퍼러 제한을 확인하고 있습니다.";
  await loadGoogleMapsApi();
  shell.dataset.googleApi = "ready";
  setStatus(apiStatus, "지도 API 연결 완료", "ready");

  loadingDetail.textContent = "Google 3D Maps 라이브러리를 준비하고 있습니다.";
  const {
    Map3DElement,
    Model3DInteractiveElement
  } = await google.maps.importLibrary("maps3d");

  const region = REGIONS[activeRegionId];
  map = new Map3DElement({
    ...getCamera(region),
    mode: "HYBRID",
    mapId: CONFIG.mapId || undefined,
    defaultUIHidden: true,
    minAltitude: 180,
    maxAltitude: 6500
  });
  map.id = "google-3d-map";
  map.setAttribute("aria-label", "Google 3D 호르무즈 실제 지형");
  host.append(map);

  map.addEventListener("gmp-map-id-error", () => {
    shell.dataset.mapIdStatus = "fallback";
    interactionStatus.textContent = "Map ID 스타일을 적용하지 못해 기본 Google 3D 지형으로 전환했습니다.";
    map.mapId = null;
  });
  map.addEventListener("gmp-error", (event) => {
    const message = event?.error?.message || event?.detail?.message || "Google 3D 지도 오류";
    showFatal(message);
  });
  map.addEventListener("gmp-steadychange", () => {
    if (typeof map.steady === "boolean" && !map.steady) return;
    markMapReady();
  });

  loadingDetail.textContent = "Meshy 구축함 GLB를 확인하고 있습니다.";
  const modelBytes = await verifyModelAsset();
  shipModel = new Model3DInteractiveElement({
    src: MODEL_URL,
    position: { ...region.ship },
    orientation: {
      heading: region.ship.heading,
      tilt: MODEL_TILT,
      roll: MODEL_ROLL
    },
    scale: MODEL_BASE_SCALE,
    altitudeMode: "RELATIVE_TO_MESH",
    title: "알레이버크급 구축함"
  });
  shipModel.addEventListener("gmp-click", () => {
    selected = !selected;
    shipModel.scale = selected ? MODEL_SELECTED_SCALE : MODEL_BASE_SCALE;
    shell.dataset.shipSelected = String(selected);
    interactionStatus.textContent = selected
      ? "알레이버크급 구축함을 선택했습니다."
      : "구축함 선택을 해제했습니다.";
  });
  shipModel.addEventListener("gmp-error", (event) => {
    shell.dataset.modelStatus = "error";
    const message = event?.error?.message || "구축함 GLB 표시 오류";
    setStatus(modelStatus, "구축함 표시 실패", "error");
    interactionStatus.textContent = message;
  });
  map.append(shipModel);
  shell.dataset.modelStatus = "mounted";
  shell.dataset.modelBytes = String(modelBytes);
  shell.dataset.mapIdStatus = CONFIG.mapId ? "applied" : "not-set";
  setStatus(modelStatus, "Meshy 구축함 연결 완료", "ready");
  updateRegionText(activeRegionId);
  bindControls();

  window.setTimeout(() => {
    if (shell.dataset.mapStatus !== "ready") {
      markMapReady();
    }
  }, 12000);
}

init().catch((error) => {
  console.error(error);
  shell.dataset.googleApi = "error";
  setStatus(apiStatus, "지도 API 연결 실패", "error");
  showFatal(error?.message || String(error));
});
