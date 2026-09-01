import { t } from "../core/i18n.js";
const CONFIG = window.HORMUZ_GOOGLE_MAPS_CONFIG || {};

const HORMUZ_CAMERA = Object.freeze({
  center: { lat: 27.0, lng: 55.5, altitude: 0 },
  range: 1250000,
  tilt: 58,
  heading: 0,
  roll: 0
});
const CAMERA_SYNC_INTERVAL_MS = 16;

let apiPromise = null;

function loadGoogleMapsApi() {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (!CONFIG.enabled || !CONFIG.apiKey) {
      reject(new Error(t("gmap.disabled")));
      return;
    }
    const callbackName = "__HORMUZ_GAME_GOOGLE_MAPS_READY__";
    const timer = window.setTimeout(() => {
      reject(new Error(t("gmap.timeout")));
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
      reject(new Error(t("gmap.scriptFail")));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export class GoogleMapGameLayer {
  constructor({ root, host, loading, toggle, labels, legend, world, defaultActive = true }) {
    this.root = root;
    this.host = host;
    this.loading = loading;
    this.toggle = toggle;
    this.labels = labels;
    this.legend = legend;
    this.world = world;
    this.defaultActive = defaultActive;
    this.ready = false;
    this.active = false;
    this.map = null;
    this.lastCamera = null;
    this.lastSyncAt = 0;
    this.syncCount = 0;
    this.syncIntervals = [];
    this.initCancelled = false;
    this.resolveInit = null;
    this.root.dataset.googleMapSyncMode = "frame";
    this.root.dataset.googleMapSyncThrottleMs = String(CAMERA_SYNC_INTERVAL_MS);
    this.localLegend = legend?.innerHTML || "";
    if (this.defaultActive) {
      this.root.classList.add("google-map-pending");
      this.root.dataset.mapProvider = "google-loading";
      this.world?.setGoogleTerrainActive?.(true);
    }
    this.world?.setGoogleCameraSync?.((camera, force = false) => {
      this.syncCamera(camera, force);
    });
    this.toggle?.addEventListener("click", () => {
      if (!this.ready) return;
      this.setActive(!this.active);
    });
  }

  async init() {
    this.initCancelled = false;
    this.root.dataset.googleMapStatus = "loading";
    if (this.toggle) {
      this.toggle.disabled = true;
      this.toggle.textContent = t("gmap.connecting");
    }
    await loadGoogleMapsApi();
    const { Map3DElement } = await google.maps.importLibrary("maps3d");

    this.map = new Map3DElement({
      ...(this.world?.getGoogleCameraState?.() || HORMUZ_CAMERA),
      mode: "HYBRID",
      mapId: CONFIG.mapId || undefined,
      defaultUIHidden: true,
      minAltitude: 100,
      maxAltitude: 2200000
    });
    this.map.id = "google-game-map";
    this.map.setAttribute("aria-label", t("gmap.ariaLabel"));
    this.host.append(this.map);

    this.map.addEventListener("gmp-map-id-error", () => {
      this.root.dataset.googleMapId = "fallback";
      this.map.mapId = null;
    });
    this.map.addEventListener("gmp-error", (event) => {
      const message = event?.error?.message || event?.detail?.message || t("gmap.genericError");
      this.fail(new Error(message));
    });

    this.root.dataset.googleShipStatus = "three-overlay";
    this.root.dataset.googleTacticalOverlay = "loading";
    this.root.dataset.googleMapId = CONFIG.mapId ? "applied" : "not-set";

    return new Promise((resolve) => {
      this.resolveInit = resolve;
      let marked = false;
      const finish = (value) => {
        this.resolveInit?.(value);
        this.resolveInit = null;
      };
      const markReady = () => {
        if (marked) return;
        marked = true;
        if (this.initCancelled) {
          finish(false);
          return;
        }
        this.ready = true;
        this.root.dataset.googleMapStatus = "ready";
        this.root.dataset.googleTacticalOverlay = "ready";
        if (this.toggle) {
          this.toggle.disabled = false;
          this.toggle.title = t("gmap.toggleTitle");
        }
        this.setActive(this.defaultActive);
        this.root.classList.remove("google-map-pending");
        this.loading?.classList.add("hidden");
        finish(true);
      };
      this.map.addEventListener("gmp-steadychange", () => {
        if (typeof this.map.steady === "boolean" && !this.map.steady) return;
        markReady();
      });
      window.setTimeout(markReady, 9000);
    });
  }

  syncCamera(camera, force = false) {
    if (!this.active || !this.map || !camera) return;
    const now = performance.now();
    const previous = this.lastCamera;
    const changed = !previous
      || Math.abs(previous.center.lat - camera.center.lat) > 0.000005
      || Math.abs(previous.center.lng - camera.center.lng) > 0.000005
      || Math.abs(previous.range - camera.range) > 10
      || Math.abs(previous.tilt - camera.tilt) > 0.005
      || Math.abs(previous.heading - camera.heading) > 0.005
      || Math.abs(previous.fov - camera.fov) > 0.005;
    const syncInterval = this.lastSyncAt ? now - this.lastSyncAt : 0;
    if (!force && (!changed || syncInterval < CAMERA_SYNC_INTERVAL_MS)) return;
    this.lastSyncAt = now;
    this.syncCount += 1;
    if (syncInterval > 250) {
      this.syncIntervals.length = 0;
    } else if (syncInterval > 0) {
      this.syncIntervals.push(syncInterval);
      if (this.syncIntervals.length > 120) this.syncIntervals.shift();
    }
    this.lastCamera = {
      ...camera,
      center: { ...camera.center }
    };
    this.map.center = camera.center;
    this.map.range = camera.range;
    this.map.tilt = camera.tilt;
    this.map.heading = camera.heading;
    this.map.roll = 0;
    this.map.fov = camera.fov;
    this.root.dataset.googleMapCenter = [
      camera.center.lng.toFixed(5),
      camera.center.lat.toFixed(5)
    ].join(",");
    this.root.dataset.googleMapRange = String(Math.round(camera.range));
    this.root.dataset.googleMapHeading = camera.heading.toFixed(2);
    this.root.dataset.googleMapSyncCount = String(this.syncCount);
    this.root.dataset.googleMapSyncIntervalMs = syncInterval.toFixed(1);
    const averageInterval = this.syncIntervals.length
      ? this.syncIntervals.reduce((sum, value) => sum + value, 0)
        / this.syncIntervals.length
      : 0;
    this.root.dataset.googleMapSyncAverageMs = averageInterval.toFixed(1);
  }

  setActive(value) {
    if (!this.ready && value) return;
    this.active = Boolean(value);
    this.root.classList.toggle("google-terrain-active", this.active);
    this.root.dataset.mapProvider = this.active ? "google-3d" : "local-three";
    this.world?.setGoogleTerrainActive?.(this.active);
    if (this.labels) this.labels.hidden = false;
    if (this.toggle) {
      this.toggle.classList.toggle("active", this.active);
      this.toggle.textContent = t(this.active ? "gmap.toLocal" : "gmap.toGoogle");
      this.toggle.setAttribute("aria-pressed", String(this.active));
    }
    if (this.legend) {
      this.legend.innerHTML = this.active
        ? `<span><i class="line official"></i>${t("gmap.legendHybrid")}</span>
           <span><i class="line approach"></i>${t("gmap.legendAssets")}</span>
           <small>${t("gmap.legendNote")}</small>`
        : this.localLegend;
    }
    if (this.active) this.syncCamera(this.world?.getGoogleCameraState?.(), true);
  }

  fail(error) {
    console.warn("Google 3D map fallback", error);
    this.ready = false;
    this.active = false;
    this.initCancelled = true;
    this.resolveInit?.(false);
    this.resolveInit = null;
    this.root.dataset.googleMapStatus = "fallback";
    this.root.dataset.googleTacticalOverlay = "fallback";
    this.root.dataset.mapProvider = "local-three";
    this.root.classList.remove("google-terrain-active");
    this.root.classList.remove("google-map-pending");
    this.loading?.classList.add("hidden");
    this.world?.setGoogleTerrainActive?.(false);
    if (this.labels) this.labels.hidden = false;
    if (this.toggle) {
      this.toggle.disabled = true;
      this.toggle.textContent = t("gmap.localFallback");
      this.toggle.title = error?.message || t("gmap.fallbackTitle");
    }
  }
}
