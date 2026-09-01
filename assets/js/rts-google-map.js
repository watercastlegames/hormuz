const CONFIG = window.HORMUZ_GOOGLE_MAPS_CONFIG || {};
const GOOGLE_BATTLE_MIN_RANGE_METERS = 4500;
const GOOGLE_BATTLE_MAX_RANGE_METERS = 180000;
const GOOGLE_BATTLE_SAFE_MAX_RANGE_METERS = 178000;

let apiPromise = null;

function loadGoogleMapsApi() {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (!CONFIG.enabled || !CONFIG.apiKey) {
      reject(new Error("Google 지도 설정이 비활성 상태입니다."));
      return;
    }
    const callbackName = "__HORMUZ_RTS_GOOGLE_MAPS_READY__";
    const timer = window.setTimeout(() => {
      reject(new Error("Google 전투 지도 응답 시간이 초과됐습니다."));
    }, 25000);
    window[callbackName] = () => {
      window.clearTimeout(timer);
      delete window[callbackName];
      resolve();
    };
    const params = new URLSearchParams({
      loading: "async",
      key: CONFIG.apiKey,
      libraries: "maps3d",
      language: CONFIG.language || "ko",
      region: CONFIG.region || "KR",
      callback: callbackName
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("Google 전투 지도 스크립트를 불러오지 못했습니다."));
    };
    document.head.append(script);
  });
  return apiPromise;
}

function metersPerWorldUnit(scenario) {
  const { bounds, projection } = scenario;
  const latitudeMeters = (
    Math.abs(bounds.north - bounds.south) * 111320
  ) / Math.max(1, projection.worldDepth);
  const longitudeMeters = (
    Math.abs(bounds.east - bounds.west)
    * 111320
    * Math.cos(projection.centerLat * Math.PI / 180)
  ) / Math.max(1, projection.worldWidth);
  return (latitudeMeters + longitudeMeters) * 0.5;
}

export class RtsGoogleBattleMap {
  constructor({
    shell,
    host,
    badge,
    scenario,
    unproject,
    enabled = true,
    language = "ko",
    onFallback
  }) {
    this.shell = shell;
    this.host = host;
    this.badge = badge;
    this.scenario = scenario;
    this.unproject = unproject;
    this.enabled = Boolean(enabled && CONFIG.enabled && CONFIG.apiKey);
    this.language = language;
    this.onFallback = onFallback;
    this.map = null;
    this.active = false;
    this.ready = false;
    this.lastSyncAt = 0;
    this.lastCamera = null;
    this.shakeSamples = 0;
    this.maxShakePixels = 0;
    this.metersPerUnit = metersPerWorldUnit(scenario);
  }

  getCamera(focus, height, distance, fov = 45) {
    const [lng, lat] = this.unproject(focus);
    const range = Math.hypot(height, distance) * this.metersPerUnit;
    const tilt = Math.atan2(distance, Math.max(1, height)) * 180 / Math.PI;
    return {
      center: { lat, lng, altitude: 0 },
      range: Math.max(
        GOOGLE_BATTLE_MIN_RANGE_METERS,
        Math.min(GOOGLE_BATTLE_MAX_RANGE_METERS, range)
      ),
      tilt: Math.max(28, Math.min(68, tilt)),
      fov: Math.max(5, Math.min(80, fov)),
      heading: 0,
      roll: 0
    };
  }

  getWorldViewLimits() {
    return {
      min: GOOGLE_BATTLE_MIN_RANGE_METERS / this.metersPerUnit,
      max: GOOGLE_BATTLE_SAFE_MAX_RANGE_METERS / this.metersPerUnit
    };
  }

  setBadge(state) {
    if (!this.badge) return;
    this.badge.dataset.state = state;
    if (state === "ready") {
      this.badge.textContent = this.language === "en"
        ? "GOOGLE 3D LIVE TERRAIN"
        : "GOOGLE 3D 실제 전투 지형";
    } else if (state === "loading") {
      this.badge.textContent = this.language === "en"
        ? "CONNECTING LIVE TERRAIN"
        : "실제 전투 지형 연결 중";
    } else {
      this.badge.textContent = this.language === "en"
        ? "LOCAL TACTICAL TERRAIN"
        : "로컬 전술 지형";
    }
  }

  async init(initialFocus, height, distance, fov = 45) {
    this.shell.dataset.googleBattleMapStatus = this.enabled ? "loading" : "disabled";
    this.setBadge(this.enabled ? "loading" : "fallback");
    if (!this.enabled) {
      this.shell.dataset.terrainProvider = "local-three";
      return false;
    }
    try {
      await loadGoogleMapsApi();
      const { Map3DElement } = await google.maps.importLibrary("maps3d");
      this.map = new Map3DElement({
        ...this.getCamera(initialFocus, height, distance, fov),
        mode: "HYBRID",
        mapId: CONFIG.mapId || undefined,
        defaultUIHidden: true,
        minAltitude: 80,
        maxAltitude: 240000
      });
      this.map.id = "rts-google-3d-map";
      this.map.setAttribute("aria-label", "Google 3D 실제 지형 기반 전투 지도");
      this.host.append(this.map);

      this.map.addEventListener("gmp-map-id-error", () => {
        this.shell.dataset.googleBattleMapId = "fallback";
        this.map.mapId = null;
      });
      this.map.addEventListener("gmp-error", (event) => {
        const message = event?.error?.message
          || event?.detail?.message
          || "Google 3D 전투 지도 오류";
        this.fail(new Error(message));
      });

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        this.map.addEventListener("gmp-steadychange", () => {
          if (typeof this.map.steady === "boolean" && !this.map.steady) return;
          finish();
        });
        window.setTimeout(finish, 9000);
      });

      if (!this.map) return false;
      this.active = true;
      this.ready = true;
      this.shell.classList.add("google-battle-map-active");
      this.shell.dataset.googleBattleMapStatus = "ready";
      this.shell.dataset.googleBattleMapId = CONFIG.mapId ? "applied" : "not-set";
      this.shell.dataset.terrainProvider = "google-3d";
      this.setBadge("ready");
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  syncCamera(focus, height, distance, fov = 45, force = false) {
    if (!this.active || !this.map) return;
    const now = performance.now();
    const camera = this.getCamera(focus, height, distance, fov);
    const previous = this.lastCamera;
    const changed = !previous
      || Math.abs(previous.center.lat - camera.center.lat) > 0.00008
      || Math.abs(previous.center.lng - camera.center.lng) > 0.00008
      || Math.abs(previous.range - camera.range) > 90
      || Math.abs(previous.tilt - camera.tilt) > 0.08
      || Math.abs((previous.fov || 0) - camera.fov) > 0.01;
    if (!force && (!changed || now - this.lastSyncAt < 90)) return;
    this.lastSyncAt = now;
    this.lastCamera = camera;
    this.map.stopCameraAnimation?.();
    this.map.center = camera.center;
    this.map.range = camera.range;
    this.map.tilt = camera.tilt;
    this.map.fov = camera.fov;
    this.map.heading = camera.heading;
    this.map.roll = 0;
    this.shell.dataset.googleBattleRange = String(Math.round(camera.range));
    this.shell.dataset.googleBattleFov = camera.fov.toFixed(2);
    this.shell.dataset.googleBattleCenter = [
      camera.center.lng.toFixed(5),
      camera.center.lat.toFixed(5)
    ].join(",");
  }

  syncShake(offsetX, offsetY, offsetZ, strength, cameraHeight, cameraDistance) {
    if (!this.active || !this.host) return;
    if (strength <= 0.002) {
      if (this.host.style.transform) this.host.style.transform = "";
      this.shell.dataset.googleTerrainShake = "0,0";
      return;
    }
    const viewDistance = Math.max(1, Math.hypot(cameraHeight, cameraDistance));
    const pixelsPerUnit = (
      this.host.clientHeight
      / (2 * viewDistance * Math.tan(45 * Math.PI / 360))
    );
    const x = Math.max(-42, Math.min(42, -offsetX * pixelsPerUnit));
    const y = Math.max(
      -30,
      Math.min(30, (offsetY - offsetZ * 0.72) * pixelsPerUnit)
    );
    const displacement = Math.hypot(x, y);
    const scale = 1.025 + Math.min(0.035, displacement / 1100);
    this.host.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(4)})`;
    this.shakeSamples += 1;
    this.maxShakePixels = Math.max(this.maxShakePixels, displacement);
    this.shell.dataset.googleTerrainShake = `${x.toFixed(2)},${y.toFixed(2)}`;
    this.shell.dataset.googleTerrainShakeSamples = String(this.shakeSamples);
    this.shell.dataset.googleTerrainMaxShakePx = this.maxShakePixels.toFixed(2);
  }

  fail(error) {
    if (this.shell.dataset.googleBattleMapStatus === "fallback") return;
    console.warn("Google 3D 전투 지도 폴백", error);
    this.active = false;
    this.ready = false;
    this.shell.classList.remove("google-battle-map-active");
    this.shell.dataset.googleBattleMapStatus = "fallback";
    this.shell.dataset.terrainProvider = "local-three";
    this.setBadge("fallback");
    this.host.style.transform = "";
    this.host.replaceChildren();
    this.map = null;
    this.onFallback?.(error);
  }
}
