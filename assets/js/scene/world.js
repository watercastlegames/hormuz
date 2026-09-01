import { t, pick } from "../core/i18n.js";
import * as THREE from "../vendor/three.module.js";
import { GLTFLoader } from "../vendor/GLTFLoader.js";
import { MeshoptDecoder } from "../vendor/meshopt_decoder.module.js";
import { mergeGeometries } from "../utils/BufferGeometryUtils.js";

const MODEL_URLS = {
  carrier: "assets/models/ships-v1/nimitz-carrier-meshy6-web-strategic-v1.glb",
  destroyer: "assets/models/meshy-remesh-v6/arleigh-burke-destroyer-remesh-3k-web-v106.glb",
  tanker: "assets/models/meshy-remesh-v6/vlcc-tanker-remesh-3p5k-web-v106.glb",
  crane: "assets/models/strategic-v1/port-gantry-crane-meshy6-web-strategic-v1.glb",
  tel: "assets/models/strategic-v1/coastal-defense-tel-meshy6-web-strategic-v1.glb",
  fighter: "assets/models/meshy-remesh-v6/fa-18e-super-hornet-remesh-2k-web-v106.glb",
  helicopter: "assets/models/combat-v1/mh-60r-seahawk-meshy6-web-lod3-v1.glb",
  usv: "assets/models/meshy-remesh-v6/mcm-usv-remesh-3k-web-v106.glb",
  fastBoat: "assets/models/combat-v1/irgc-fast-attack-craft-meshy6-web-strategic-v1.glb"
};

const ALWAYS_TEXTURED_MODEL_KEYS = new Set([
  "destroyer",
  "tanker",
  "fighter",
  "usv"
]);

const OVERVIEW_CAMERA = new THREE.Vector3(0, 80, 124);
/* 상황판 카메라가 바라보는 지점.
 *
 * ★ 이 값이 화면에서 호르무즈 해협의 높이를 정한다.
 *   예전 값(z = -2)에서는 해협이 화면의 57% 지점, 즉 한가운데보다 아래에 찍혔고
 *   아부다비 쪽 남쪽 해안은 86% 까지 내려가 하단 브리핑 패널에 가렸다.
 *   보는 지점을 남쪽으로 물리면 북쪽(해협)이 화면 위로 올라온다.
 *   ★ 기준은 '화면 한가운데' 가 아니라 '지도가 실제로 보이는 구간의 한가운데' 다.
 *   결정 패널이 열리면 지도가 보이는 곳은 그 위쪽뿐이다. 넓고 낮은 창
 *   (1588x843)에서는 그 구간이 y 156~402 로 246px 밖에 안 되는데,
 *   z = 12 에서는 해협이 377 에 찍혀 패널까지 25px 만 남았다. 걸쳐 보인다.
 *   z = 26 에서 해협이 그 구간 안으로 들어왔고, 사장님 요청으로 한 단계 더 올려 34 로 뒀다.
 *   더 올릴수록 남쪽(두바이·아부다비)이 화면 밖으로 밀려난다. 그게 상한이다. */
const OVERVIEW_TARGET = new THREE.Vector3(0, 1, 34);
/* Google 3D 지도가 실제로 따라올 수 있는 기울기 한계.
 *
 * ★ 이 값은 반드시 한 곳에서만 정해야 한다.
 *   예전에는 드래그 쪽이 18.3°~77.3° 를 허용하고 지도로 보내는 값만 25°~72° 로
 *   잘랐다. 그 바깥 구간에서는 지도가 멈춘 채 three.js 카메라만 계속 움직여,
 *   화면에서 지도는 가만히 있는데 함선·지명만 밀려 올라갔다. */
const GOOGLE_TILT_MIN_DEG = 25;
const GOOGLE_TILT_MAX_DEG = 72;
const GOOGLE_TILT_MIN = GOOGLE_TILT_MIN_DEG * Math.PI / 180;
const GOOGLE_TILT_MAX = GOOGLE_TILT_MAX_DEG * Math.PI / 180;
/* 로컬 지형만 그릴 때는 맞출 상대가 없으므로 조금 더 넓게 움직여도 된다. */
const LOCAL_TILT_MIN = 0.32;
const LOCAL_TILT_MAX = 1.35;

const CAMERA_MIN_DISTANCE = 92;
const CAMERA_MAX_DISTANCE = 158;
const MAIN_CARRIER_DEPLOYMENT = Object.freeze({
  lon: 53.65,
  lat: 26.25,
  rotation: -0.18,
  scale: 0.88
});
const MAX_TRANSIT_SHIPS = 6;
const TRANSIT_SHIP_SCALE = 0.26;
const TSS_ROUTE_Y = -0.52;
const MODEL_BASE_Y = {
  carrier: -0.44,
  destroyer: -0.43,
  tanker: -0.44,
  fastBoat: -0.40,
  usv: -0.40,
  crane: 1.48,
  tel: 1.48,
  fighter: 5.5,
  helicopter: 3.4
};

const ENVIRONMENT_TEXTURE_URLS = {
  ocean: "assets/textures/rts-v2/hormuz-ocean-bluehour-tile-v1.webp",
  northLand: "assets/textures/rts-v2/iran-mountain-rock-tile-v1.webp",
  southLand: "assets/textures/rts-v2/oman-limestone-desert-tile-v1.webp"
};

const COLORS = {
  ocean: 0x03131c,
  deep: 0x01070b,
  cyan: 0x31d9f4,
  ally: 0x75e6ff,
  hostile: 0xff6a50,
  amber: 0xffb65c,
  iran: 0x243c33,
  south: 0x3a3022,
  coast: 0x8ff3e5
};

function area(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum / 2);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const xi = ring[index][0];
    const yi = ring[index][1];
    const xj = ring[previous][0];
    const yj = ring[previous][1];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 0.0000001) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInCoastPolygon(point, polygon) {
  if (!pointInRing(point, polygon.outer)) return false;
  return !(polygon.holes || []).some((hole) => pointInRing(point, hole));
}

function hashNoise(a, b, seed = 0) {
  const value = Math.sin(a * 12.9898 + b * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
    else child.material?.dispose?.();
  });
}

export class HormuzWorld {
  constructor({ canvas, labels, coastline, geo }) {
    this.canvas = canvas;
    this.labelsRoot = labels;
    this.coastline = coastline;
    this.geo = geo;
    this.lastFrameAt = performance.now();
    this.elapsed = 0;
    this.mixers = [];
    this.dynamic = [];
    this.transitShipCount = -1;
    this.labels = [];
    this.models = {};
    this.environmentTextures = {};
    this.autoCamera = true;
    this.target = OVERVIEW_TARGET.clone();
    this.cameraGoal = OVERVIEW_CAMERA.clone();
    this.pointer = new THREE.Vector2();
    this.drag = null;
    this.fxPulse = 0;
    this.day = 1;
    this.mapMode = false;
    this.renderEnabled = true;
    this.googleTerrainActive = false;
    this.googleCameraSync = null;
    this.localTerrainObjects = [];
    this.perfDebug = new URLSearchParams(location.search).get("perf") === "1";
    this.mission = null;
    this.missionKeys = {};
    this.missionEffects = [];
    this.init();
  }

  project(lon, lat, y = 0) {
    const { bounds, projection } = this.geo;
    return new THREE.Vector3(
      ((lon - projection.centerLon) / (bounds.east - bounds.west)) * projection.worldWidth,
      y,
      -((lat - projection.centerLat) / (bounds.north - bounds.south)) * projection.worldDepth
    );
  }

  unproject(point) {
    const { bounds, projection } = this.geo;
    return {
      lng: projection.centerLon
        + (point.x / projection.worldWidth) * (bounds.east - bounds.west),
      lat: projection.centerLat
        - (point.z / projection.worldDepth) * (bounds.north - bounds.south)
    };
  }

  getGoogleCameraState() {
    const { bounds, projection } = this.geo;
    const focus = this.unproject(this.target);
    const offset = this.camera.position.clone().sub(this.target);
    const horizontalDistance = Math.hypot(offset.x, offset.z);
    const latitudeMeters = (
      Math.abs(bounds.north - bounds.south) * 111320
    ) / Math.max(1, projection.worldDepth);
    const longitudeMeters = (
      Math.abs(bounds.east - bounds.west)
      * 111320
      * Math.cos(projection.centerLat * Math.PI / 180)
    ) / Math.max(1, projection.worldWidth);
    const metersPerUnit = (latitudeMeters + longitudeMeters) * 0.5;
    const heading = (
      Math.atan2(-offset.x, offset.z) * 180 / Math.PI + 360
    ) % 360;
    return {
      center: { lat: focus.lat, lng: focus.lng, altitude: 0 },
      range: THREE.MathUtils.clamp(offset.length() * metersPerUnit, 7000, 1800000),
      tilt: THREE.MathUtils.clamp(
        Math.atan2(horizontalDistance, Math.max(0.1, offset.y))
          * 180 / Math.PI,
        GOOGLE_TILT_MIN_DEG,
        GOOGLE_TILT_MAX_DEG
      ),
      heading,
      roll: 0,
      fov: this.camera.fov
    };
  }

  setGoogleCameraSync(listener) {
    this.googleCameraSync = typeof listener === "function" ? listener : null;
    if (this.googleCameraSync) this.googleCameraSync(this.getGoogleCameraState(), true);
  }

  registerLocalTerrainObject(object) {
    this.localTerrainObjects.push(object);
    this.scene.add(object);
    return object;
  }

  setGoogleTerrainActive(enabled) {
    this.googleTerrainActive = Boolean(enabled);
    this.canvas.dataset.googleTacticalOverlay = String(this.googleTerrainActive);
    for (const object of this.localTerrainObjects) {
      object.visible = !this.googleTerrainActive;
    }
    if (this.googleTerrainActive) {
      this.scene.background = null;
      this.scene.fog = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.scene.background = this.localSceneBackground;
      this.scene.fog = this.localSceneFog;
      this.renderer.setClearColor(0x0b2b3a, 1);
    }
    this.lastFrameAt = performance.now();
    this.resize();
    this.googleCameraSync?.(this.getGoogleCameraState(), true);
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b2b3a);
    this.scene.fog = new THREE.FogExp2(0x2b6572, 0.00225);
    this.localSceneBackground = this.scene.background;
    this.localSceneFog = this.scene.fog;
    this.camera = new THREE.PerspectiveCamera(49, 1, 0.2, 600);
    this.cameraGoal.copy(OVERVIEW_CAMERA);
    this.camera.position.copy(this.cameraGoal);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.48;
    this.renderer.shadowMap.enabled = false;

    this.loadEnvironmentTextures();
    this.addSky();
    this.scene.add(new THREE.HemisphereLight(0xd7f7ff, 0x66513c, 3.2));
    const moon = new THREE.DirectionalLight(0xffddb0, 4.15);
    moon.position.set(-52, 86, -40);
    this.scene.add(moon);
    const fill = new THREE.DirectionalLight(0x8cecff, 2.75);
    fill.position.set(70, 34, 58);
    this.scene.add(fill);

    this.addOcean();
    this.addLand();
    this.addTerrainDetails();
    this.addTss();
    this.addPlaces();
    this.addTacticalObjects();
    this.loadModels();
    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.animate();
  }

  loadEnvironmentTextures() {
    const loader = new THREE.TextureLoader();
    for (const [key, url] of Object.entries(ENVIRONMENT_TEXTURE_URLS)) {
      const texture = loader.load(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.repeat.set(key === "ocean" ? 5.5 : 0.12, key === "ocean" ? 5.5 : 0.12);
      this.environmentTextures[key] = texture;
    }
  }

  addSky() {
    const geometry = new THREE.SphereGeometry(360, 32, 18);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x164f6c) },
        midColor: { value: new THREE.Color(0x76b8c8) },
        horizonColor: { value: new THREE.Color(0xffc88e) },
        sunDirection: { value: new THREE.Vector3(-0.58, 0.16, -0.79).normalize() },
        sunColor: { value: new THREE.Color(0xffca8c) }
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = normalize(world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        varying vec3 vWorld;
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          float h = clamp(vWorld.y * .5 + .5, 0.0, 1.0);
          vec3 color = mix(midColor, topColor, smoothstep(.56, .95, h));
          float lowerFade = smoothstep(.36, .48, h);
          color = mix(midColor * .68, color, lowerFade);
          float band = exp(-pow((h - .495) * 22.0, 2.0)) * .3;
          float sunDot = max(dot(normalize(vWorld), sunDirection), 0.0);
          float sunDisc = smoothstep(.9992, .99975, sunDot);
          float sunGlow = pow(sunDot, 80.0) * .65;
          vec2 cloudUv = vec2(atan(vWorld.z, vWorld.x) * 3.1, vWorld.y * 9.0);
          float cloudNoise = noise(cloudUv * 1.7) * .62 + noise(cloudUv * 3.4) * .38;
          float cloudBand = smoothstep(.56, .76, cloudNoise) * smoothstep(.46, .54, h) * (1.0 - smoothstep(.67, .78, h));
          color += horizonColor * band + sunColor * (sunDisc * 1.9 + sunGlow * .42);
          color = mix(color, vec3(.62, .75, .78), cloudBand * .22);
          gl_FragColor = vec4(color, 1.0);
        }
      `
    });
    this.sky = new THREE.Mesh(geometry, material);
    this.registerLocalTerrainObject(this.sky);
  }

  addOcean() {
    const geometry = new THREE.PlaneGeometry(240, 220, 44, 44);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        surfaceMap: { value: this.environmentTextures.ocean },
        deepColor: { value: new THREE.Color(0x07526d) },
        midColor: { value: new THREE.Color(0x1499b9) },
        crestColor: { value: new THREE.Color(0x93eff6) },
        gridColor: { value: new THREE.Color(0x7ee8f1) },
        sunColor: { value: new THREE.Color(0xffc084) }
      },
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vWave;
        float waveHeight(vec2 p) {
          return sin(p.x * .17 + time * .68) * .14
               + cos(p.y * .12 - time * .51) * .10
               + sin((p.x + p.y) * .34 + time * .29) * .045;
        }
        void main() {
          vUv = uv;
          vec3 p = position;
          float wave = waveHeight(p.xy);
          p.z += wave;
          vWave = wave;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 deepColor;
        uniform vec3 midColor;
        uniform vec3 crestColor;
        uniform vec3 gridColor;
        uniform vec3 sunColor;
        uniform sampler2D surfaceMap;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vWave;
        float gridLine(float value, float density) {
          float cell = abs(fract(value * density) - .5);
          return 1.0 - smoothstep(.47, .5, cell);
        }
        void main() {
          vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          if (normal.y < 0.0) normal *= -1.0;
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.2);
          vec3 sunDir = normalize(vec3(-.46, .72, .33));
          float sunGlint = pow(max(dot(reflect(-sunDir, normal), viewDir), 0.0), 82.0);
          float crest = smoothstep(.08, .24, vWave);
          vec2 textureUv = vUv * 5.5 + vec2(time * .0017, -time * .0011);
          vec3 surface = texture2D(surfaceMap, textureUv).rgb;
          float surfaceDetail = dot(surface, vec3(.2126, .7152, .0722));
          vec3 color = mix(deepColor, midColor, .42 + fresnel * .52);
          color = mix(color, surface * vec3(.84, 1.02, 1.08), .31 + fresnel * .12);
          color = mix(color, crestColor, crest * .26);
          color += crestColor * max(0.0, surfaceDetail - .34) * .16;
          color += sunColor * sunGlint * 1.45;
          float grid = max(gridLine(vUv.x, 42.0), gridLine(vUv.y, 42.0));
          float scan = .5 + .5 * sin((vUv.x + vUv.y) * 35.0 - time * .35);
          color += gridColor * grid * (.018 + scan * .012);
          gl_FragColor = vec4(color, 1.0);
        }
      `
    });
    const ocean = new THREE.Mesh(geometry, material);
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = -0.75;
    this.registerLocalTerrainObject(ocean);
    this.ocean = ocean;

    const grid = new THREE.GridHelper(190, 42, 0x116174, 0x0b3440);
    grid.position.y = -0.58;
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    this.registerLocalTerrainObject(grid);

    const stars = new THREE.BufferGeometry();
    const positions = [];
    for (let i = 0; i < 520; i++) {
      positions.push((Math.random() - 0.5) * 360, 65 + Math.random() * 100, (Math.random() - 0.5) * 300);
    }
    stars.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.registerLocalTerrainObject(new THREE.Points(stars, new THREE.PointsMaterial({
      color: 0xd8f7ff, size: 0.26, transparent: true, opacity: 0.16, sizeAttenuation: true
    })));
  }

  addLand() {
    this.landGroup = new THREE.Group();
    const significant = this.coastline.polygons.filter((polygon) => area(polygon.outer) > 0.000006);
    this.landPolygons = significant;
    const geometries = { north: [], south: [] };
    const coastPoints = { north: [], south: [] };
    const landMaterials = {
      north: new THREE.MeshStandardMaterial({
        color: 0xd0d6bc,
        map: this.environmentTextures.northLand,
        roughness: 0.86,
        metalness: 0.06,
        emissive: 0x355b44,
        emissiveIntensity: 0.2
      }),
      south: new THREE.MeshStandardMaterial({
        color: 0xe3c994,
        map: this.environmentTextures.southLand,
        roughness: 0.86,
        metalness: 0.06,
        emissive: 0x72562c,
        emissiveIntensity: 0.2
      })
    };
    for (const polygon of significant) {
      if (!polygon.outer || polygon.outer.length < 3) continue;
      const shape = new THREE.Shape();
      polygon.outer.forEach(([lon, lat], index) => {
        const point = this.project(lon, lat);
        if (index === 0) shape.moveTo(point.x, -point.z);
        else shape.lineTo(point.x, -point.z);
      });
      for (const ring of polygon.holes || []) {
        const hole = new THREE.Path();
        ring.forEach(([lon, lat], index) => {
          const point = this.project(lon, lat);
          if (index === 0) hole.moveTo(point.x, -point.z);
          else hole.lineTo(point.x, -point.z);
        });
        shape.holes.push(hole);
      }
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 1.15,
        bevelEnabled: true,
        bevelThickness: 0.18,
        bevelSize: 0.14,
        bevelSegments: 1
      });
      // The coastline already uses project().z (-latitude).  A positive
      // rotation mirrors the filled land surface north/south, so rotate the
      // extruded XY shape in the negative direction to keep both on one map.
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0.38, 0);
      const centerLat = polygon.outer.reduce((sum, point) => sum + point[1], 0) / polygon.outer.length;
      const region = centerLat > 26.55 ? "north" : "south";
      geometries[region].push(geometry);

      if (polygon.outer.length >= 7 && area(polygon.outer) > 0.0002) {
        const points = polygon.outer.map(([lon, lat]) => this.project(lon, lat, 1.65));
        for (let index = 0; index < points.length; index++) {
          coastPoints[region].push(points[index], points[(index + 1) % points.length]);
        }
      }
    }
    for (const region of ["north", "south"]) {
      if (geometries[region].length) {
        const merged = mergeGeometries(geometries[region]);
        geometries[region].forEach((geometry) => geometry.dispose());
        this.landGroup.add(new THREE.Mesh(merged, landMaterials[region]));
      }
      if (coastPoints[region].length) {
        this.landGroup.add(new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(coastPoints[region]),
          new THREE.LineBasicMaterial({
            color: region === "north" ? 0xffa84e : 0x4dd7e2,
            transparent: true,
            opacity: region === "north" ? 0.44 : 0.38
          })
        ));
      }
    }
    this.registerLocalTerrainObject(this.landGroup);
  }

  addTss() {
    this.tssGroup = new THREE.Group();
    const transitRoute = this.tankerRoute();
    this.tssGroup.add(this.makeRoute(transitRoute, COLORS.cyan, false, 0.24));
    const north = transitRoute.map(([lon, lat]) => [lon, lat + 0.032]);
    const south = transitRoute.map(([lon, lat]) => [lon, lat - 0.032]);
    this.tssGroup.add(this.makeRoute(north, COLORS.ally, true, 0.14));
    this.tssGroup.add(this.makeRoute(south, COLORS.ally, true, 0.14));

    const markerMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.32, 1.15, 3),
      new THREE.MeshBasicMaterial({
        color: COLORS.cyan,
        transparent: true,
        opacity: 0.16,
        depthWrite: false
      }),
      22
    );
    markerMesh.renderOrder = -10;
    const markerDummy = new THREE.Object3D();
    for (let index = 0; index < 22; index++) {
      const point = this.routePoint(south, index / 21);
      markerDummy.rotation.set(Math.PI / 2, 0, -Math.PI / 2);
      markerDummy.position.copy(point).setY(TSS_ROUTE_Y + 0.04);
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
    }
    markerMesh.instanceMatrix.needsUpdate = true;
    this.tssGroup.add(markerMesh);
    this.scene.add(this.tssGroup);
  }

  addTerrainDetails() {
    this.terrainDetailGroup = new THREE.Group();
    const vertices = { north: [], south: [] };
    const uvs = { north: [], south: [] };
    const materials = {
      north: new THREE.MeshStandardMaterial({
        color: 0xc2c9ae,
        map: this.environmentTextures.northLand,
        roughness: 0.96,
        metalness: 0.02,
        emissive: 0x31513d,
        emissiveIntensity: 0.2,
        flatShading: true
      }),
      south: new THREE.MeshStandardMaterial({
        color: 0xd8bd89,
        map: this.environmentTextures.southLand,
        roughness: 0.96,
        metalness: 0.02,
        emissive: 0x654b26,
        emissiveIntensity: 0.2,
        flatShading: true
      })
    };
    const polygons = [...(this.landPolygons || [])]
      .filter((polygon) => area(polygon.outer) > 0.00004)
      .sort((a, b) => area(b.outer) - area(a.outer))
      .slice(0, 20);
    const west = 54.9;
    const east = 57.0;
    const south = 25.0;
    const north = 27.3;
    const step = 0.034;
    const reliefHeight = (lon, lat) => {
      const ridgeA = Math.pow(Math.abs(Math.sin(lon * 19.7 + lat * 7.3)), 2.4);
      const ridgeB = Math.pow(Math.abs(Math.cos(lon * 11.2 - lat * 17.6)), 3.1);
      const detail = hashNoise(lon * 9, lat * 9, 4) * 0.34;
      const northMainland = Math.max(0, Math.min(1, (lat - 26.88) / 0.22));
      const qeshmRelief = Math.exp(
        -Math.pow((lon - 55.72) / 0.62, 2) - Math.pow((lat - 26.79) / 0.18, 2)
      );
      const musandamRelief = Math.exp(
        -Math.pow((lon - 56.25) / 0.34, 2) - Math.pow((lat - 26.10) / 0.43, 2)
      );
      const omanRelief = Math.exp(
        -Math.pow((lon - 56.55) / 0.58, 2) - Math.pow((lat - 25.45) / 0.58, 2)
      );
      const amplitude = 0.22
        + northMainland * 2.5
        + qeshmRelief * 0.82
        + musandamRelief * 2.25
        + omanRelief * 0.72;
      return 1.46 + amplitude * (0.18 + ridgeA * 0.5 + ridgeB * 0.28 + detail);
    };
    const addTriangle = (region, triangle) => {
      for (const [lon, lat] of triangle) {
        const point = this.project(lon, lat, reliefHeight(lon, lat));
        vertices[region].push(point.x, point.y, point.z);
        uvs[region].push((lon - west) * 20, (lat - south) * 20);
      }
    };
    for (let lat = south; lat < north - step; lat += step) {
      for (let lon = west; lon < east - step; lon += step) {
        const center = [lon + step * 0.5, lat + step * 0.5];
        const polygon = polygons.find((candidate) => pointInCoastPolygon(center, candidate));
        if (!polygon) continue;
        const corners = [
          [lon, lat],
          [lon + step, lat],
          [lon + step, lat + step],
          [lon, lat + step]
        ];
        if (corners.some((corner) => !pointInCoastPolygon(corner, polygon))) continue;
        const region = center[1] > 26.55 ? "north" : "south";
        addTriangle(region, [corners[0], corners[1], corners[2]]);
        addTriangle(region, [corners[0], corners[2], corners[3]]);
      }
    }
    for (const region of ["north", "south"]) {
      if (!vertices[region].length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices[region], 3)
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs[region], 2));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, materials[region]);
      this.terrainDetailGroup.add(mesh);
    }
    this.registerLocalTerrainObject(this.terrainDetailGroup);
  }

  makeRoute(coords, color, dashed = false, opacity = 1) {
    const geometry = new THREE.BufferGeometry().setFromPoints(
      coords.map(([lon, lat]) => this.project(lon, lat, TSS_ROUTE_Y))
    );
    const material = dashed
      ? new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        dashSize: 1.4,
        gapSize: 0.8
      })
      : new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false
      });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = -10;
    if (dashed) line.computeLineDistances();
    return line;
  }

  routePoint(coords, t) {
    const scaled = Math.max(0, Math.min(0.999, t)) * (coords.length - 1);
    const index = Math.floor(scaled);
    const local = scaled - index;
    const a = this.project(...coords[index]);
    const b = this.project(...coords[Math.min(coords.length - 1, index + 1)]);
    return a.lerp(b, local);
  }

  tankerRoute() {
    return this.geo.tss.safeTransitVisualization || [
      ...this.geo.tss.approachVisualization,
      ...this.geo.tss.separationCenter.slice(1),
      [56.84, 26.19]
    ];
  }

  measureRouteCoastClearanceKm(route) {
    let minimum = Infinity;
    const coastlines = this.coastline.polygons.flatMap((polygon) => polygon.outer || []);
    for (let segment = 0; segment < route.length - 1; segment += 1) {
      const start = route[segment];
      const end = route[segment + 1];
      for (let sample = 0; sample <= 40; sample += 1) {
        const t = sample / 40;
        const lon = start[0] + (end[0] - start[0]) * t;
        const lat = start[1] + (end[1] - start[1]) * t;
        const lonScale = 111.32 * Math.cos(lat * Math.PI / 180);
        for (const point of coastlines) {
          const dx = (lon - point[0]) * lonScale;
          const dy = (lat - point[1]) * 111.32;
          minimum = Math.min(minimum, Math.hypot(dx, dy));
        }
      }
    }
    return minimum;
  }

  setDynamicRoutePose(unit, route) {
    const next = this.routePoint(route, unit.offset);
    const lookT = Math.min(0.999, unit.offset + 0.008);
    const ahead = this.routePoint(route, lookT);
    const direction = ahead.clone().sub(next);
    unit.object.position.copy(next).setY(MODEL_BASE_Y[unit.key] ?? -0.4);
    if (direction.lengthSq() > 0.0001) {
      // The bundled VLCC mesh has its bow on local -X. Align that axis with
      // the verified route tangent so it never sails stern-first.
      unit.object.rotation.set(0, Math.atan2(direction.x, direction.z) + Math.PI / 2, 0);
    }
  }

  addPlaces() {
    const keyPlaces = new Set([
      "bandar_abbas", "qeshm", "hormuz_island", "musandam", "khasab", "fujairah",
      "kuwait_city", "manama", "doha", "abu_dhabi", "dubai", "muscat", "bushehr", "chabahar"
    ]);
    const beacons = { iran: [], south: [] };
    const glowPositions = [];
    const glowColors = [];
    const iranGlow = new THREE.Color(COLORS.amber);
    const southGlow = new THREE.Color(COLORS.cyan);
    for (const place of this.geo.places) {
      const point = this.project(place.lon, place.lat, 2.5);
      const color = place.country === "IRAN" ? COLORS.amber : COLORS.cyan;
      beacons[place.country === "IRAN" ? "iran" : "south"].push(point);
      const glowColor = place.country === "IRAN" ? iranGlow : southGlow;
      for (let index = 0; index < 9; index++) {
        glowPositions.push(
          point.x + (index % 5 - 2) * 0.38,
          1.64 + (index % 3) * 0.05,
          point.z + (Math.floor(index / 5) - 0.5) * 0.42
        );
        glowColors.push(glowColor.r, glowColor.g, glowColor.b);
      }
      if (keyPlaces.has(place.id)) this.createLabel(pick(place, "name"), point, place.kind);
    }
    const beaconGeometry = new THREE.CylinderGeometry(0.15, 0.34, 2.1, 8);
    for (const [region, points] of Object.entries(beacons)) {
      if (!points.length) continue;
      const material = new THREE.MeshBasicMaterial({
        color: region === "iran" ? COLORS.amber : COLORS.cyan,
        transparent: true,
        opacity: 0.88
      });
      const mesh = new THREE.InstancedMesh(beaconGeometry, material, points.length);
      const matrix = new THREE.Matrix4();
      points.forEach((point, index) => {
        matrix.makeTranslation(point.x, 1.25, point.z);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(glowPositions, 3)
    );
    glowGeometry.setAttribute("color", new THREE.Float32BufferAttribute(glowColors, 3));
    this.scene.add(new THREE.Points(
      glowGeometry,
      new THREE.PointsMaterial({
        size: 0.42,
        transparent: true,
        opacity: 0.82,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
      })
    ));
    this.createLabel(t("geo.persianGulf"), this.project(55.18, 26.2, 0.8), "sea major");
    this.createLabel(t("geo.gulfOfOman"), this.project(56.72, 25.45, 0.8), "sea major");
    this.createLabel(t("geo.straitOfHormuz"), this.project(56.29, 26.52, 3.2), "strait major");
  }

  createLabel(text, position, kind) {
    const element = document.createElement("div");
    element.className = `map-label ${kind}`;
    element.textContent = text;
    this.labelsRoot.appendChild(element);
    this.labels.push({ element, position });
  }

  addTacticalObjects() {
    this.unitGroup = new THREE.Group();
    this.scene.add(this.unitGroup);
    this.mineGroup = new THREE.Group();
    const minePositions = [];
    for (let index = 0; index < 10; index++) {
      const p = this.project(55.95 + (index % 5) * 0.055, 26.05 + Math.floor(index / 5) * 0.06, 0.12);
      minePositions.push(p);
    }
    const mineMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f3b3c,
      roughness: 0.42,
      metalness: 0.58,
      emissive: 0x5e130e,
      emissiveIntensity: 0.16
    });
    const mineBodies = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.34, 12, 8),
      mineMaterial,
      minePositions.length
    );
    const mineSpikes = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.11, 0.42, 7),
      mineMaterial,
      minePositions.length * 6
    );
    const mineDummy = new THREE.Object3D();
    const spikeDirections = [
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
    ];
    minePositions.forEach((position, mineIndex) => {
      mineDummy.position.copy(position).setY(-0.38);
      mineDummy.rotation.set(0, 0, 0);
      mineDummy.scale.setScalar(1);
      mineDummy.updateMatrix();
      mineBodies.setMatrixAt(mineIndex, mineDummy.matrix);
      spikeDirections.forEach((direction, directionIndex) => {
        mineDummy.position.copy(position).setY(-0.38).addScaledVector(direction, 0.48);
        mineDummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        mineDummy.updateMatrix();
        mineSpikes.setMatrixAt(mineIndex * 6 + directionIndex, mineDummy.matrix);
      });
    });
    mineBodies.instanceMatrix.needsUpdate = true;
    mineSpikes.instanceMatrix.needsUpdate = true;
    this.mineGroup.add(mineBodies, mineSpikes);
    this.scene.add(this.mineGroup);

    this.swarmGroup = new THREE.Group();
    this.scene.add(this.swarmGroup);

    const hazardGeometry = new THREE.RingGeometry(3.4, 3.65, 64);
    const hazard = new THREE.Mesh(hazardGeometry, new THREE.MeshBasicMaterial({
      color: COLORS.hostile, transparent: true, opacity: 0.45, side: THREE.DoubleSide
    }));
    hazard.rotation.x = -Math.PI / 2;
    hazard.position.copy(this.project(56.05, 26.08, 0.02));
    this.scene.add(hazard);
    this.hazard = hazard;
  }

  createFastBoat() {
    const group = new THREE.Group();
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0x2c3130,
      metalness: 0.48,
      roughness: 0.36,
      emissive: 0x7d1008,
      emissiveIntensity: 0.48
    });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.34, 0.7), hullMaterial);
    hull.geometry.translate(0, 0.05, 0);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4), hullMaterial);
    bow.rotation.x = Math.PI / 2;
    bow.rotation.z = Math.PI / 4;
    bow.position.z = 1.05;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.42, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x171e20, emissive: 0xff3b20, emissiveIntensity: 0.2 })
    );
    cabin.position.set(0, 0.38, -0.15);
    const gun = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6),
      new THREE.MeshBasicMaterial({ color: COLORS.hostile })
    );
    gun.rotation.x = Math.PI / 2;
    gun.position.set(0, 0.55, 0.62);
    group.add(hull, bow, cabin, gun);
    const wake = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 4.2),
      new THREE.MeshBasicMaterial({
        color: 0x52dff2,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    wake.rotation.x = -Math.PI / 2;
    wake.position.set(0, -0.12, -2.2);
    group.add(wake);
    return group;
  }

  async loadModels() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const entries = Object.entries(MODEL_URLS);
    await Promise.all(entries.map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        this.models[key] = this.normalizeModel(gltf.scene, key);
      } catch (error) {
        console.warn(`Model fallback: ${key}`, error);
        this.models[key] = this.fallbackModel(key);
      }
    }));
    this.deployModels();
  }

  normalizeModel(source, key) {
    const object = source;
    if (["fighter", "helicopter", "usv", "fastBoat"].includes(key)) {
      object.rotation.y = Math.PI / 2;
      object.updateMatrixWorld(true);
    }
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const desired = {
      carrier: 15,
      destroyer: 7.5,
      tanker: 12,
      crane: 5,
      tel: 3.4,
      fighter: 5.8,
      helicopter: 5.4,
      usv: 3.2,
      fastBoat: 2.8
    }[key];
    const scale = desired / Math.max(size.x, size.y, size.z, 0.001);
    object.scale.setScalar(scale);
    const scaled = new THREE.Box3().setFromObject(object);
    const center = scaled.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.z -= center.z;
    object.position.y -= scaled.min.y;
    object.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (child.material) {
        child.material.metalness = Math.min(0.55, child.material.metalness ?? 0.25);
        child.material.roughness = Math.max(0.26, child.material.roughness ?? 0.48);
        if (ALWAYS_TEXTURED_MODEL_KEYS.has(key) && child.material.map) {
          child.material.color?.setHex(0xffffff);
          child.material.map.colorSpace = THREE.SRGBColorSpace;
          child.material.map.anisotropy = Math.min(
            8,
            this.renderer.capabilities.getMaxAnisotropy()
          );
          if (child.material.emissive) {
            child.material.emissive.setHex(0x000000);
            child.material.emissiveIntensity = 0;
          }
          child.material.needsUpdate = true;
        } else if (child.material.emissive) {
          child.material.emissive.setHex(
            key === "tel" || key === "fastBoat" ? 0x541307
              : key === "tanker" || key === "crane" ? 0x18282c
                : 0x063c4b
          );
          child.material.emissiveIntensity = key === "tel" || key === "fastBoat" ? 0.34 : 0.18;
        }
      }
    });
    const anchor = new THREE.Group();
    anchor.name = `${key}-waterline-anchor`;
    anchor.userData.modelKey = key;
    anchor.add(object);
    return anchor;
  }

  fallbackModel(key) {
    const group = new THREE.Group();
    const collapseGroup = (target, material) => {
      const geometries = target.children
        .filter((child) => child.isMesh)
        .map((child) => {
          child.updateMatrix();
          return child.geometry.clone().applyMatrix4(child.matrix);
        });
      target.clear();
      target.add(new THREE.Mesh(mergeGeometries(geometries), material));
      geometries.forEach((geometry) => geometry.dispose());
      return target;
    };
    if (key === "crane") {
      const material = new THREE.MeshStandardMaterial({
        color: 0xd18c38,
        roughness: 0.58,
        metalness: 0.46,
        emissive: 0x5a2a08,
        emissiveIntensity: 0.26
      });
      const addBox = (size, position, rotationZ = 0) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
        mesh.position.set(...position);
        mesh.rotation.z = rotationZ;
        group.add(mesh);
      };
      addBox([0.3, 3.6, 0.34], [-0.72, 1.8, 0]);
      addBox([0.3, 3.6, 0.34], [0.72, 1.8, 0]);
      addBox([1.9, 0.28, 0.38], [0, 3.48, 0]);
      addBox([3.1, 0.2, 0.24], [1.28, 3.42, 0], -0.13);
      addBox([0.08, 2.1, 0.08], [2.72, 2.28, 0]);
      return collapseGroup(group, material);
    }
    if (key === "tel") {
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0x69744e,
        roughness: 0.72,
        metalness: 0.22,
        emissive: 0x221f0b,
        emissiveIntensity: 0.22
      });
      const base = new THREE.Mesh(new THREE.BoxGeometry(3, 0.55, 1.1), bodyMaterial);
      base.position.y = 0.36;
      group.add(base);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.76, 1), bodyMaterial);
      cab.position.set(0.92, 0.92, 0);
      group.add(cab);
      const rack = new THREE.Group();
      for (let index = 0; index < 4; index++) {
        const tube = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.13, 2.3, 8),
          bodyMaterial
        );
        tube.rotation.z = Math.PI / 2;
        tube.position.set(-0.35, 0, (index - 1.5) * 0.25);
        rack.add(tube);
      }
      rack.position.set(-0.35, 1.2, 0);
      rack.rotation.z = -0.28;
      group.add(rack);
      rack.updateMatrix();
      for (const tube of [...rack.children]) {
        tube.updateMatrix();
        const combined = new THREE.Matrix4().multiplyMatrices(rack.matrix, tube.matrix);
        tube.geometry = tube.geometry.clone().applyMatrix4(combined);
        tube.position.set(0, 0, 0);
        tube.rotation.set(0, 0, 0);
        tube.scale.set(1, 1, 1);
        tube.updateMatrix();
        group.add(tube);
      }
      group.remove(rack);
      return collapseGroup(group, bodyMaterial);
    }
    const dims = {
      carrier: [14, 0.6, 3.5], destroyer: [7, 0.55, 1.3], tanker: [11, 0.9, 2.1],
      crane: [1.2, 4.5, 1.2], tel: [3, 0.7, 1]
    }[key];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...dims),
      new THREE.MeshStandardMaterial({ color: key === "tel" ? 0x4d5e35 : 0x73848a, roughness: 0.55 })
    );
    mesh.castShadow = true;
    group.add(mesh);
    return group;
  }

  cloneModel(key, lon, lat, rotation = 0, scale = 1) {
    const source = this.models[key];
    if (!source) return null;
    const object = source.clone(true);
    object.position.copy(this.project(lon, lat, MODEL_BASE_Y[key] ?? 0.05));
    object.rotation.y = rotation;
    object.scale.multiplyScalar(scale);
    object.userData.modelKey = key;
    object.userData.geoAnchor = { lng: lon, lat };
    this.unitGroup.add(object);
    return object;
  }

  deployModels() {
    const carrier = this.cloneModel(
      "carrier",
      MAIN_CARRIER_DEPLOYMENT.lon,
      MAIN_CARRIER_DEPLOYMENT.lat,
      MAIN_CARRIER_DEPLOYMENT.rotation,
      MAIN_CARRIER_DEPLOYMENT.scale
    );
    if (carrier) {
      this.canvas.dataset.carrierAnchor = [
        MAIN_CARRIER_DEPLOYMENT.lon.toFixed(2),
        MAIN_CARRIER_DEPLOYMENT.lat.toFixed(2)
      ].join(",");
    }
    for (let index = 0; index < MAX_TRANSIT_SHIPS; index++) {
      const tanker = this.cloneModel(
        "tanker",
        55.46,
        26.25,
        -1.02,
        TRANSIT_SHIP_SCALE
      );
      if (tanker) {
        tanker.visible = false;
        const unit = {
          object: tanker,
          key: "tanker",
          speed: 0.012,
          offset: 0,
          route: "tanker"
        };
        this.dynamic.push(unit);
      }
    }
    this.setTransitTraffic(30);
    this.cloneModel("crane", 56.22, 27.09, -0.4, 0.62);
    this.cloneModel("tel", 56.50, 26.95, 1.8, 0.68);
    const fastBoatSource = this.models.fastBoat;
    if (fastBoatSource) {
      for (let index = 0; index < 1; index++) {
        const boat = fastBoatSource.clone(true);
        boat.position.copy(this.project(
          56.16 + (index % 4) * 0.045,
          26.49 - Math.floor(index / 4) * 0.055,
          MODEL_BASE_Y.fastBoat
        ));
        boat.rotation.y = -0.45 + (index % 3 - 1) * 0.08;
        boat.scale.multiplyScalar(0.68);
        boat.userData.baseY = MODEL_BASE_Y.fastBoat;
        boat.userData.phase = index * 0.73;
        this.swarmGroup.add(boat);
      }
      const contactPositions = [];
      for (let index = 1; index < 8; index++) {
        const point = this.project(
          56.16 + (index % 4) * 0.045,
          26.49 - Math.floor(index / 4) * 0.055,
          0
        );
        contactPositions.push(point.x, 0, point.z);
      }
      const contacts = new THREE.Points(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(contactPositions, 3)
        ),
        new THREE.PointsMaterial({
          color: COLORS.hostile,
          size: 0.62,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true
        })
      );
      contacts.name = "IRGC tactical contact markers";
      contacts.userData.baseY = MODEL_BASE_Y.fastBoat;
      contacts.userData.phase = 0.4;
      this.swarmGroup.add(contacts);
    }
  }

  createAircraft(kind) {
    const group = new THREE.Group();
    const allyMaterial = new THREE.MeshStandardMaterial({
      color: kind === "b2" ? 0x27343b : 0x718b91,
      metalness: 0.7,
      roughness: 0.28,
      emissive: 0x08768b,
      emissiveIntensity: 0.36
    });
    const shape = new THREE.Shape();
    if (kind === "b2") {
      shape.moveTo(0, 2.6);
      shape.lineTo(5.3, -1.5);
      shape.lineTo(1.4, -0.65);
      shape.lineTo(0, -2.0);
      shape.lineTo(-1.4, -0.65);
      shape.lineTo(-5.3, -1.5);
    } else {
      shape.moveTo(0, 2.8);
      shape.lineTo(2.7, -0.3);
      shape.lineTo(0.75, 0.05);
      shape.lineTo(0.48, -2.15);
      shape.lineTo(0, -1.55);
      shape.lineTo(-0.48, -2.15);
      shape.lineTo(-0.75, 0.05);
      shape.lineTo(-2.7, -0.3);
    }
    const wing = new THREE.Mesh(new THREE.ShapeGeometry(shape), allyMaterial);
    wing.rotation.x = -Math.PI / 2;
    wing.position.y = 0.02;
    group.add(wing);
    if (kind !== "b2") {
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.42, 4.8, 10), allyMaterial);
      fuselage.rotation.x = Math.PI / 2;
      fuselage.position.y = 0.22;
      group.add(fuselage);
      const canopy = new THREE.Mesh(
        new THREE.SphereGeometry(0.38, 10, 6),
        new THREE.MeshStandardMaterial({ color: 0x071921, metalness: 0.85, roughness: 0.16, emissive: 0x1f8fa5, emissiveIntensity: 0.2 })
      );
      canopy.scale.set(0.72, 0.55, 1.25);
      canopy.position.set(0, 0.48, 0.65);
      group.add(canopy);
    }
    return group;
  }

  createHelicopter() {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: 0x5c777c,
      metalness: 0.52,
      roughness: 0.34,
      emissive: 0x075b6a,
      emissiveIntensity: 0.3
    });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.82, 12, 8), material);
    body.scale.set(0.92, 0.72, 1.45);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 2.5), material);
    tail.position.z = -1.7;
    const rotorMaterial = new THREE.MeshBasicMaterial({
      color: 0x9df5ff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 0.025, 32), rotorMaterial);
    rotor.position.y = 0.9;
    group.add(body, tail, rotor);
    group.userData.rotor = rotor;
    return group;
  }

  createUsv() {
    const group = this.createFastBoat();
    group.scale.setScalar(0.78);
    group.traverse((child) => {
      if (child.isMesh && child.material?.emissive) {
        child.material = child.material.clone();
        child.material.emissive.setHex(0x036f82);
      }
    });
    return group;
  }

  createMissionAsset(asset) {
    const wrapper = new THREE.Group();
    let model;
    if (this.models[asset.model]) model = this.models[asset.model].clone(true);
    else if (asset.model === "destroyer") model = this.fallbackModel("destroyer");
    else if (asset.model === "helicopter") model = this.createHelicopter();
    else if (asset.model === "usv") model = this.createUsv();
    else model = this.createAircraft(asset.model);
    wrapper.add(model);
    const ringSize = asset.model === "destroyer" ? 6.2 : asset.model === "usv" ? 2.5 : 3.8;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ringSize * 0.72, ringSize, 48),
      new THREE.MeshBasicMaterial({
        color: COLORS.cyan,
        transparent: true,
        opacity: 0.58,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -asset.altitude + 0.05;
    wrapper.add(ring);
    wrapper.userData.selectionRing = ring;
    return wrapper;
  }

  createMissionTarget(type) {
    const wrapper = new THREE.Group();
    let model;
    if (type === "fast_boat") {
      model = this.models.fastBoat ? this.models.fastBoat.clone(true) : this.createFastBoat();
    } else if (type === "drone") {
      model = new THREE.Group();
      const hostile = new THREE.MeshStandardMaterial({
        color: 0x38312e,
        metalness: 0.42,
        roughness: 0.4,
        emissive: 0x9c190e,
        emissiveIntensity: 0.55
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 2.3, 8), hostile);
      body.rotation.x = Math.PI / 2;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.08, 0.62), hostile);
      model.add(body, wing);
    } else if (type === "mine") {
      model = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.72, 1),
        new THREE.MeshStandardMaterial({ color: 0x2c1716, emissive: 0xff2517, emissiveIntensity: 0.8, roughness: 0.38 })
      );
    } else if (this.models.tel) {
      model = this.models.tel.clone(true);
      model.scale.multiplyScalar(1.25);
    } else {
      model = this.fallbackModel("tel");
    }
    wrapper.add(model);
    const size = type === "tel" ? 3.5 : 2.1;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(size * 0.72, size, 40),
      new THREE.MeshBasicMaterial({
        color: COLORS.hostile,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = type === "drone" ? -4.9 : 0.06;
    wrapper.add(ring);
    wrapper.userData.targetRing = ring;
    return wrapper;
  }

  runMission(mission, asset, onStatus) {
    if (this.mission) this.finishMission(false, true);
    if (this.swarmGroup) this.swarmGroup.visible = false;
    if (this.mineGroup) this.mineGroup.visible = false;
    if (this.hazard) this.hazard.visible = false;
    const group = new THREE.Group();
    this.scene.add(group);
    const controlled = this.createMissionAsset(asset);
    const strategic = mission.targetType === "tel";
    const start = strategic
      ? this.project(56.02, 26.28, asset.altitude)
      : this.project(55.72, 26.08, asset.altitude);
    controlled.position.copy(start);
    group.add(controlled);

    const center = strategic
      ? this.project(56.35, 26.67, 0.2)
      : this.project(56.07, 26.30, mission.targetType === "drone" ? 5.1 : 0.18);
    const initialHeading = Math.atan2(center.x - start.x, center.z - start.z);
    controlled.rotation.y = initialHeading;
    const targets = [];
    for (let index = 0; index < mission.targetCount; index++) {
      const target = this.createMissionTarget(mission.targetType);
      const angle = (index / mission.targetCount) * Math.PI * 2 + 0.35;
      const radius = 7.5 + (index % 3) * 3.2;
      target.position.set(
        center.x + Math.cos(angle) * radius,
        mission.targetType === "drone" ? 4.4 + (index % 3) * 1.1 : mission.targetType === "tel" ? 1.0 : 0.18,
        center.z + Math.sin(angle) * radius
      );
      target.rotation.y = angle + Math.PI;
      target.userData.hp = mission.targetType === "tel" ? 2 : 1;
      target.userData.alive = true;
      target.userData.phase = angle;
      group.add(target);
      targets.push(target);
    }

    this.autoCamera = false;
    this.camera.up.set(0, 1, 0);
    this.missionKeys = {};
    return new Promise((resolve) => {
      this.mission = {
        config: mission,
        asset,
        group,
        controlled,
        targets,
        projectiles: [],
        effects: [],
        destroyed: 0,
        health: asset.armor,
        ammo: asset.ammo,
        heading: initialHeading,
        currentSpeed: asset.speed * 0.08,
        startedAt: performance.now(),
        lastFireAt: 0,
        statusAt: 0,
        locked: null,
        controls: {},
        resolve,
        onStatus,
        completed: false,
        completeAt: 0,
        success: false
      };
      this.updateMissionStatus(performance.now(), true);
    });
  }

  setMissionControl(action, active) {
    if (!this.mission) return;
    this.mission.controls[action] = Boolean(active);
  }

  findMissionLock() {
    const mission = this.mission;
    if (!mission) return null;
    const origin = mission.controlled.position;
    const forward = new THREE.Vector3(Math.sin(mission.heading), 0, Math.cos(mission.heading));
    let best = null;
    let bestScore = Infinity;
    for (const target of mission.targets) {
      if (!target.userData.alive || target.userData.incoming > 0) continue;
      const offset = target.position.clone().sub(origin);
      const distance = offset.length();
      const planar = offset.clone().setY(0).normalize();
      const dot = planar.dot(forward);
      const score = distance * (1.3 - Math.max(-0.6, dot) * 0.3);
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }
    return best;
  }

  fireMissionWeapon() {
    const mission = this.mission;
    if (!mission || mission.completed) return false;
    const now = performance.now();
    if (mission.ammo <= 0 || now - mission.lastFireAt < mission.asset.cooldown * 1000) return false;
    const target = this.findMissionLock();
    if (!target) return false;
    mission.lastFireAt = now;
    mission.ammo--;
    target.userData.incoming = (target.userData.incoming || 0) + 1;
    const projectile = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.12, 0.68, 3, 6),
      new THREE.MeshBasicMaterial({
        color: 0xc8fbff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    projectile.position.copy(mission.controlled.position);
    projectile.position.y += 0.35;
    mission.group.add(projectile);
    mission.projectiles.push({ object: projectile, target, life: 3.6, speed: 78 });
    this.fxPulse = Math.max(this.fxPulse, 0.35);
    return true;
  }

  addMissionExplosion(position, hostile = true) {
    const mission = this.mission;
    if (!mission) return;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 8),
      new THREE.MeshBasicMaterial({
        color: hostile ? 0xff9b4d : 0x9ff7ff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    sphere.position.copy(position);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.58, 36),
      new THREE.MeshBasicMaterial({
        color: hostile ? 0xff6a38 : 0xb7fbff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(position).setY(Math.max(0.25, position.y));
    mission.group.add(sphere, ring);
    mission.effects.push({ sphere, ring, life: 0.9 });
    this.fxPulse = 1;
  }

  updateMissionStatus(now, force = false) {
    const mission = this.mission;
    if (!mission || (!force && now - mission.statusAt < 100)) return;
    mission.statusAt = now;
    mission.onStatus?.({
      destroyed: mission.destroyed,
      remaining: Math.max(0, mission.config.duration - (now - mission.startedAt)),
      health: mission.health,
      ammo: mission.ammo,
      locked: Boolean(mission.locked)
    });
  }

  updateMission(delta, now) {
    const mission = this.mission;
    if (!mission) return;
    if (mission.completed) {
      this.updateMissionEffects(delta);
      if (now >= mission.completeAt) this.finishMission(mission.success);
      return;
    }

    const active = (name) => mission.controls[name] || this.missionKeys[name];
    const throttle = active("throttle");
    const braking = active("brake");
    const targetSpeed = mission.asset.speed * (throttle ? 1 : braking ? 0 : 0.12);
    mission.currentSpeed += (targetSpeed - mission.currentSpeed) * Math.min(1, delta * 2.4);
    const turnInput = (active("turnLeft") ? 1 : 0) - (active("turnRight") ? 1 : 0);
    mission.heading += turnInput * mission.asset.turn * delta;
    const forward = new THREE.Vector3(Math.sin(mission.heading), 0, Math.cos(mission.heading));
    mission.controlled.position.addScaledVector(forward, mission.currentSpeed * delta);
    mission.controlled.position.x = THREE.MathUtils.clamp(mission.controlled.position.x, -72, 72);
    mission.controlled.position.z = THREE.MathUtils.clamp(mission.controlled.position.z, -78, 78);
    mission.controlled.position.y = mission.asset.altitude + Math.sin(now * 0.0025) * (mission.asset.altitude > 1 ? 0.14 : 0.04);
    mission.controlled.rotation.y = mission.heading;
    if (mission.controlled.children[0]?.userData?.rotor) {
      mission.controlled.children[0].userData.rotor.rotation.y += delta * 24;
    }
    if (mission.controlled.userData.selectionRing) {
      mission.controlled.userData.selectionRing.rotation.z += delta * 0.42;
    }

    mission.locked = this.findMissionLock();
    mission.targets.forEach((target, index) => {
      if (!target.userData.alive) return;
      target.userData.phase += delta * (0.18 + index * 0.008);
      if (mission.config.targetType === "fast_boat") {
        target.position.x += Math.sin(target.userData.phase) * delta * 0.9;
        target.position.z += Math.cos(target.userData.phase * 0.8) * delta * 0.7;
      } else if (mission.config.targetType === "drone") {
        const pursuit = mission.controlled.position.clone().sub(target.position).setY(0).normalize();
        target.position.addScaledVector(pursuit, delta * 1.35);
      }
      target.userData.targetRing.rotation.z += delta * 0.55;
      target.userData.targetRing.material.opacity = target === mission.locked
        ? 0.95
        : 0.42 + Math.sin(now * 0.005 + index) * 0.16;
      const threatDistance = target.position.distanceTo(mission.controlled.position);
      if (threatDistance < 7.5 && mission.config.targetType !== "mine") {
        mission.health -= delta * 1.8;
      }
    });

    for (let index = mission.projectiles.length - 1; index >= 0; index--) {
      const shot = mission.projectiles[index];
      shot.life -= delta;
      if (!shot.target.userData.alive || shot.life <= 0) {
        shot.target.userData.incoming = Math.max(0, (shot.target.userData.incoming || 1) - 1);
        mission.group.remove(shot.object);
        mission.projectiles.splice(index, 1);
        continue;
      }
      const direction = shot.target.position.clone().sub(shot.object.position);
      const distance = direction.length();
      const travel = shot.speed * delta;
      if (distance <= travel + 0.9) {
        shot.target.userData.incoming = Math.max(0, (shot.target.userData.incoming || 1) - 1);
        shot.target.userData.hp--;
        this.addMissionExplosion(shot.target.position, true);
        mission.group.remove(shot.object);
        mission.projectiles.splice(index, 1);
        if (shot.target.userData.hp <= 0) {
          shot.target.userData.alive = false;
          shot.target.visible = false;
          mission.destroyed++;
        }
        continue;
      }
      direction.normalize();
      shot.object.position.addScaledVector(direction, travel);
      shot.object.lookAt(shot.target.position);
    }
    this.updateMissionEffects(delta);

    const cameraHeight = mission.asset.altitude > 1 ? 8.5 : 11.5;
    const cameraBack = mission.asset.model === "destroyer" ? 18 : 13;
    const desired = mission.controlled.position.clone()
      .addScaledVector(forward, -cameraBack)
      .add(new THREE.Vector3(0, cameraHeight, 0));
    this.camera.position.lerp(desired, 0.085);
    const aim = mission.controlled.position.clone().addScaledVector(forward, 8);
    this.target.lerp(aim, 0.12);
    this.camera.lookAt(this.target);

    const remaining = mission.config.duration - (now - mission.startedAt);
    if (mission.destroyed >= mission.config.targetCount) {
      mission.completed = true;
      mission.success = true;
      mission.completeAt = now + 850;
    } else if (remaining <= 0 || mission.health <= 0 || (mission.ammo <= 0 && mission.projectiles.length === 0)) {
      mission.completed = true;
      mission.success = false;
      mission.completeAt = now + 650;
    }
    this.updateMissionStatus(now);
  }

  updateMissionEffects(delta) {
    const mission = this.mission;
    if (!mission) return;
    for (let index = mission.effects.length - 1; index >= 0; index--) {
      const effect = mission.effects[index];
      effect.life -= delta;
      effect.sphere.scale.multiplyScalar(1 + delta * 3.8);
      effect.ring.scale.multiplyScalar(1 + delta * 5.4);
      effect.sphere.material.opacity = Math.max(0, effect.life);
      effect.ring.material.opacity = Math.max(0, effect.life * 0.85);
      if (effect.life <= 0) {
        mission.group.remove(effect.sphere, effect.ring);
        mission.effects.splice(index, 1);
      }
    }
  }

  finishMission(success, immediate = false) {
    const mission = this.mission;
    if (!mission) return;
    const result = {
      success: Boolean(success),
      destroyed: mission.destroyed,
      health: Math.max(0, Math.round(mission.health)),
      ammo: mission.ammo
    };
    this.scene.remove(mission.group);
    this.mission = null;
    this.missionKeys = {};
    if (this.swarmGroup) this.swarmGroup.visible = true;
    if (this.mineGroup) this.mineGroup.visible = true;
    if (this.hazard) this.hazard.visible = true;
    this.autoCamera = true;
    this.camera.up.set(0, 1, 0);
    this.target.copy(OVERVIEW_TARGET);
    this.cameraGoal.copy(OVERVIEW_CAMERA);
    mission.resolve(result);
  }

  setDay(state) {
    this.day = state.day;
    this.setTransitTraffic(state.dials.transit);
    this.mineGroup.visible = state.dials.transit < 60;
    this.swarmGroup.visible = state.dials.esc >= 3;
    this.hazard.material.opacity = 0.18 + state.dials.esc * 0.07;
  }

  setTransitTraffic(transitValue) {
    const transit = THREE.MathUtils.clamp(Number(transitValue) || 0, 0, 100);
    const count = Math.round((transit / 100) * MAX_TRANSIT_SHIPS);
    const tankers = this.dynamic.filter((unit) => unit.key === "tanker");
    const visibleCount = tankers.filter((unit) => unit.object.visible).length;
    if (count !== this.transitShipCount || visibleCount !== count) {
      const route = this.tankerRoute();
      tankers.forEach((unit, index) => {
        unit.object.visible = index < count;
        if (index >= count) return;
        unit.offset = (0.06 + index / Math.max(1, count)) % 1;
        this.setDynamicRoutePose(unit, route);
      });
      this.transitShipCount = count;
    }
    this.canvas.dataset.transitValue = String(Math.round(transit));
    this.canvas.dataset.transitShipCount = String(count);
    this.canvas.dataset.transitShipPool = String(tankers.length);
    this.canvas.dataset.transitShipScale = String(TRANSIT_SHIP_SCALE);
    this.canvas.dataset.transitRouteClearanceKm = this.measureRouteCoastClearanceKm(
      this.tankerRoute()
    ).toFixed(1);
  }

  playPreset(name) {
    this.fxPulse = 1;
    const targets = {
      deploy: [0, 72, 66],
      patrol: [-4, 80, 72],
      convoy: [0, 66, 60],
      minesweep: [0, 58, 54],
      minefield: [0, 56, 52],
      swarm: [5, 52, 48],
      missile: [4, 62, 56],
      strike: [5, 60, 52],
      bombrun: [0, 76, 64],
      diplomacy: [0, 86, 76],
      negotiation: [0, 84, 74],
      ending: [0, 94, 84]
    };
    const selected = targets[name] || [12, 58, 54];
    this.cameraGoal.set(...selected);
    this.clampCameraGoal();
  }

  clampCameraGoal() {
    const offset = this.cameraGoal.clone().sub(this.target);
    const distance = offset.length();
    if (distance < 0.001) offset.set(0, 1, 1).normalize();
    else offset.normalize();
    const limited = THREE.MathUtils.clamp(distance, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
    this.cameraGoal.copy(this.target).addScaledVector(offset, limited);
    // 기울기도 같은 한계 안에 둔다. 드래그만 막으면 자동 카메라가 그 밖으로 나간다.
    const spherical = new THREE.Spherical().setFromVector3(
      this.cameraGoal.clone().sub(this.target)
    );
    const tiltMin = this.googleTerrainActive ? GOOGLE_TILT_MIN : LOCAL_TILT_MIN;
    const tiltMax = this.googleTerrainActive ? GOOGLE_TILT_MAX : LOCAL_TILT_MAX;
    const clamped = THREE.MathUtils.clamp(spherical.phi, tiltMin, tiltMax);
    if (clamped !== spherical.phi) {
      spherical.phi = clamped;
      this.cameraGoal.copy(this.target)
        .add(new THREE.Vector3().setFromSpherical(spherical));
    }
  }

  /** 아래쪽 패널이 화면을 가릴 때를 대비한 자리. 지금은 고정 시선을 쓴다. */
  setViewLift() {}

  setAutoCamera(value) {
    if (this.mapMode) return;
    this.autoCamera = Boolean(value);
  }

  setRenderEnabled(value) {
    this.renderEnabled = Boolean(value);
    this.canvas.dataset.renderEnabled = String(this.renderEnabled);
    if (this.renderEnabled) {
      this.lastFrameAt = performance.now();
      this.resize();
    }
  }

  setMapMode(enabled) {
    this.mapMode = Boolean(enabled);
    if (!this.mapMode) return;
    this.autoCamera = false;
    // The north-up validation camera is much farther away than gameplay.
    // Disable distance fog there so the filled land/coastline registration is
    // clearly inspectable in screenshots.
    this.scene.fog = null;
    this.target.set(0, 0, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.position.set(0, 205, 0.01);
    this.cameraGoal.copy(this.camera.position);
    this.unitGroup.visible = false;
    this.mineGroup.visible = false;
    this.swarmGroup.visible = false;
    this.hazard.visible = false;
  }

  bindInput() {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (this.mission) {
        this.fireMissionWeapon();
        return;
      }
      this.autoCamera = false;
      this.drag = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture?.(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
      const offset = this.camera.position.clone().sub(this.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.005;
      // 지도가 따라올 수 있는 만큼만 기울인다. 더 기울여 봐야 지도는 안 따라오고
      // 그 위에 얹힌 함선·지명만 어긋난다.
      const tiltMin = this.googleTerrainActive ? GOOGLE_TILT_MIN : LOCAL_TILT_MIN;
      const tiltMax = this.googleTerrainActive ? GOOGLE_TILT_MAX : LOCAL_TILT_MAX;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + dy * 0.004, tiltMin, tiltMax);
      this.camera.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(spherical));
      this.cameraGoal.copy(this.camera.position);
      this.clampCameraGoal();
      this.camera.position.copy(this.cameraGoal);
      this.googleCameraSync?.(this.getGoogleCameraState(), true);
    });
    const release = () => { this.drag = null; };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      if (this.mission) return;
      this.autoCamera = false;
      const direction = this.camera.position.clone().sub(this.target).normalize();
      this.cameraGoal.addScaledVector(direction, event.deltaY * 0.024);
      this.clampCameraGoal();
    }, { passive: false });

    const keyMap = {
      KeyW: "throttle", ArrowUp: "throttle",
      KeyS: "brake", ArrowDown: "brake",
      KeyA: "turnLeft", ArrowLeft: "turnLeft",
      KeyD: "turnRight", ArrowRight: "turnRight"
    };
    window.addEventListener("keydown", (event) => {
      if (!this.mission) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) this.fireMissionWeapon();
        return;
      }
      const action = keyMap[event.code];
      if (!action) return;
      event.preventDefault();
      this.missionKeys[action] = true;
    });
    window.addEventListener("keyup", (event) => {
      const action = keyMap[event.code];
      if (!action) return;
      this.missionKeys[action] = false;
    });
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 지명 라벨을 화면 좌표에 얹는다.
   *
   * 좁은 화면에서는 지명들이 서로 가까워져 글자가 겹쳐 읽을 수 없게 된다.
   * 430px 폭에서 17개 중 12쌍이 겹쳤다. 겹치면 둘 다 못 읽으므로, 큰 지명을
   * 먼저 놓고 그 위에 걸리는 작은 지명은 숨긴다. 지도를 가리는 것보다
   * 몇 개를 감추는 편이 낫다.
   *
   * 라벨 크기는 글자가 정해지면 바뀌지 않으므로 화면 크기가 바뀔 때만 다시 잰다.
   * 매 프레임 offsetWidth 를 읽으면 유닛 수만큼 강제 리플로우가 난다.
   */
  updateLabels() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width < 1 || height < 1) return;
    // ★ 글자 크기를 한 번만 재고 캐시하면 안 된다. 글꼴이 늦게 붙으면 글자가 넓어지고,
    //   좁게 잰 상자로 배치한 결과가 그대로 남아 실제로는 겹친 채 표시된다.
    //   (`document.fonts.ready` 만으로는 나중에 요청된 글꼴을 못 잡는다.)
    //   지명은 17개뿐이라 1초에 한 번 다시 재도 비용이 거의 없다.
    const now = performance.now();
    const sizeKey = `${width}x${height}`;
    if (this.labelSizeAt !== sizeKey || now - (this.labelMeasuredAt || 0) > 1000) {
      this.labelSizeAt = sizeKey;
      this.labelMeasuredAt = now;
      for (const label of this.labels) {
        label.halfWidth = label.element.offsetWidth / 2;
        label.halfHeight = label.element.offsetHeight / 2;
        // 해협·바다 같은 큰 지명이 먼저 자리를 잡는다.
        label.rank = label.element.classList.contains("major") ? 0 : 1;
      }
    }
    for (const label of this.labels) {
      // 새로 만들어진 지명(언어 전환·장면 재구성)은 그 자리에서 잰다.
      if (label.halfWidth !== undefined) continue;
      label.halfWidth = label.element.offsetWidth / 2;
      label.halfHeight = label.element.offsetHeight / 2;
      label.rank = label.element.classList.contains("major") ? 0 : 1;
    }

    const placed = [];
    const hits = (box) => placed.some((other) => (
      box.left < other.right && box.right > other.left
      && box.top < other.bottom && box.bottom > other.top
    ));
    // 같은 등급이면 이미 떠 있던 지명이 자리를 지킨다. 순서를 매번 새로 정하면
    // 카메라가 조금만 움직여도 두 지명이 서로 자리를 뺏어 깜빡인다.
    const ordered = [...this.labels].sort((a, b) => (
      (a.rank || 0) - (b.rank || 0)
      || (a.shown ? 0 : 1) - (b.shown ? 0 : 1)
    ));
    for (const label of ordered) {
      const point = label.position.clone().project(this.camera);
      const onScreen = point.z > -1 && point.z < 1;
      const x = (point.x * 0.5 + 0.5) * width;
      const y = (-point.y * 0.5 + 0.5) * height;
      if (!onScreen) {
        label.element.style.opacity = "0";
        label.shown = false;
        label.element.style.transform =
          `translate(-50%,-50%) translate(${x}px,${y}px)`;
        continue;
      }
      const halfWidth = label.halfWidth || 0;
      const halfHeight = label.halfHeight || 0;
      const step = (halfHeight * 2) + 3;
      // 겹치면 곧바로 숨기지 않는다. 먼저 위아래로 조금씩 비켜 본다.
      // 바로 숨기면 지도가 확대됐을 때 지명이 하나만 남아 지도를 읽을 수 없다.
      let chosen = null;
      for (const offset of [0, -step, step, -step * 2, step * 2]) {
        const box = {
          left: x - halfWidth, right: x + halfWidth,
          top: y + offset - halfHeight, bottom: y + offset + halfHeight
        };
        if (!hits(box)) {
          chosen = { offset, box };
          break;
        }
      }
      const offset = chosen ? chosen.offset : 0;
      label.element.style.transform =
        `translate(-50%,-50%) translate(${x}px,${y + offset}px)`;
      label.element.style.opacity = chosen ? "1" : "0";
      label.shown = Boolean(chosen);
      if (chosen) placed.push(chosen.box);
    }
  }

  animate() {
    this.raf = requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    if (!this.renderEnabled) return;
    this.elapsed += delta;
    const elapsed = this.elapsed;
    if (this.ocean?.material?.uniforms?.time) {
      this.ocean.material.uniforms.time.value = elapsed;
    }
    if (this.mission) {
      this.updateMission(delta, now);
    } else {
      if (this.autoCamera && !this.drag && !this.mapMode) {
        this.cameraGoal.x += (0 - this.cameraGoal.x) * 0.02;
        this.cameraGoal.z += (124 + Math.sin(elapsed * 0.035) * 3 - this.cameraGoal.z) * 0.0015;
        this.cameraGoal.y += (80 + Math.sin(elapsed * 0.025) * 2 - this.cameraGoal.y) * 0.0012;
        this.clampCameraGoal();
      }
      this.camera.position.lerp(this.cameraGoal, 0.028);
      this.camera.lookAt(this.target);
    }

    const tankerRoute = this.tankerRoute();
    for (const unit of this.dynamic) {
      unit.offset = (unit.offset + delta * unit.speed) % 1;
      this.setDynamicRoutePose(unit, tankerRoute);
    }
    this.swarmGroup.children.forEach((boat, index) => {
      const phase = boat.userData.phase ?? index;
      boat.position.y = (boat.userData.baseY ?? MODEL_BASE_Y.fastBoat)
        + (Math.sin(elapsed * 2.1 + phase) + 1) * 0.012;
    });
    this.hazard.scale.setScalar(1 + Math.sin(elapsed * 1.7) * 0.05);
    this.fxPulse = Math.max(0, this.fxPulse - delta * 0.3);
    this.renderer.toneMappingExposure = this.googleTerrainActive
      ? 1.08 + this.fxPulse * 0.08
      : this.mapMode
        ? 1.56
        : (this.mission ? 1.54 : 1.48) + this.fxPulse * 0.16;
    this.updateLabels();
    this.googleCameraSync?.(this.getGoogleCameraState());
    this.renderer.render(this.scene, this.camera);
    if (this.perfDebug) {
      this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
      this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
      const groups = [];
      for (const child of this.scene.children) {
        let triangles = 0;
        let draws = 0;
        if (child.visible) child.traverseVisible((object) => {
          if (!object.isMesh || !object.geometry) return;
          const count = object.geometry.index?.count
            ?? object.geometry.attributes.position?.count
            ?? 0;
          triangles += Math.floor(count / 3) * (object.isInstancedMesh ? object.count : 1);
          draws += 1;
        });
        if (triangles || draws) {
          groups.push({
            name: child.name || child.type,
            triangles,
            draws
          });
        }
      }
      this.canvas.dataset.triangleGroups = JSON.stringify(
        groups.sort((a, b) => b.triangles - a.triangles)
      );
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    disposeObject(this.scene);
    this.renderer.dispose();
    this.labelsRoot.replaceChildren();
  }
}
