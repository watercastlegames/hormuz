import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/meshopt_decoder.module.js";
import { mergeGeometries } from "./utils/BufferGeometryUtils.js";
import { clone as cloneSkeleton } from "./utils/SkeletonUtils.js";
import { CombatFx } from "./rts-vfx.js";
import { RtsAudioManager } from "./rts-audio.js";
import { RtsGoogleBattleMap } from "./rts-google-map.js";

const DATA_URLS = {
  combat: "assets/data/rts-combat.json?v=37",
  coastline: "assets/data/coastline.json",
  geo: "assets/data/geo_features.json?v=37",
  audio: "assets/data/rts-audio.json"
};
const RTS_RUNTIME_VERSION = "138";

const ENVIRONMENT_TEXTURE_URLS = {
  ocean: "assets/textures/rts-v2/hormuz-ocean-bluehour-tile-v1.webp",
  northLand: "assets/textures/rts-v2/iran-mountain-rock-tile-v1.webp",
  southLand: "assets/textures/rts-v2/oman-limestone-desert-tile-v1.webp"
};

const MISSION_CUE_IMAGES = Object.freeze({
  briefing: "assets/images/radio/mission-cues/01-briefing-v1.webp",
  contact: "assets/images/radio/mission-cues/02-contact-v1.webp",
  targetLock: "assets/images/radio/mission-cues/03-target-lock-v1.webp",
  weaponFire: "assets/images/radio/mission-cues/04-weapon-fire-v1.webp",
  targetHit: "assets/images/radio/mission-cues/05-target-hit-v1.webp",
  allyHit: "assets/images/radio/mission-cues/06-ally-hit-v1.webp",
  convoyThreat: "assets/images/radio/mission-cues/07-convoy-threat-v1.webp",
  reentry: "assets/images/radio/mission-cues/08-reentry-v1.webp",
  success: "assets/images/radio/mission-cues/09-success-v1.webp",
  failure: "assets/images/radio/mission-cues/10-failure-v1.webp"
});

// 화면비 보정 기준. fov 는 세로 기준이라 세로 화면에서 가로 시야만 좁아진다.
// 16:9 에서 보이던 가로 폭을 기준으로 삼아, fov 를 상한까지 넓히고
// 모자란 몫만 카메라를 물려 채운다.
const RTS_BASE_FOV = 45;
const RTS_BASE_ASPECT = 16 / 9;
const RTS_MAX_FOV = 62;          // 이 이상은 원근이 과장돼 함선이 휘어 보인다
const RTS_MAX_PULLBACK = 1.75;   // 이 이상 물리면 유닛이 알아보기 어려워진다
const RTS_PORTRAIT_ASPECT = 9 / 16;
const RTS_PORTRAIT_TILT = 1.34;  // 9:16 에서 높이를 이만큼 더 세워 하늘을 덜 담는다

const TEAM_COLORS = {
  ally: 0x64e4ee,
  enemy: 0xff5b50,
  civilian: 0xe6efed
};

const TEAM_EMISSIVE = {
  ally: 0x074f60,
  enemy: 0x62160f,
  civilian: 0x263a3d
};

const PROJECTILE_FORWARD = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const RESULT_REVEAL_DELAY_MS = 3000;
const RESULT_REVIEW_MIN_SECONDS = RESULT_REVEAL_DELAY_MS / 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const moveToward = (value, target, maxDelta) => (
  value < target
    ? Math.min(target, value + maxDelta)
    : Math.max(target, value - maxDelta)
);

function shortestAngle(from, to) {
  let difference = to - from;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function polygonArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(sum) * 0.5;
}

function planarDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

function pointToSegmentDistance(point, start, end) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentZ = end.z - start.z;
  const lengthSq = segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ;
  if (lengthSq < 0.000001) return point.distanceTo(start);
  const pointX = point.x - start.x;
  const pointY = point.y - start.y;
  const pointZ = point.z - start.z;
  const t = clamp(
    (pointX * segmentX + pointY * segmentY + pointZ * segmentZ) / lengthSq,
    0,
    1
  );
  const closestX = start.x + segmentX * t;
  const closestY = start.y + segmentY * t;
  const closestZ = start.z + segmentZ * t;
  return Math.hypot(
    point.x - closestX,
    point.y - closestY,
    point.z - closestZ
  );
}

function createShipHullGeometry(length, beam, height) {
  const stations = [
    { z: -length * 0.5, width: beam * 0.06 },
    { z: -length * 0.34, width: beam * 0.46 },
    { z: length * 0.3, width: beam * 0.5 },
    { z: length * 0.5, width: beam * 0.34 }
  ];
  const vertices = [];
  for (const station of stations) {
    vertices.push(
      -station.width, height, station.z,
      station.width, height, station.z,
      -station.width * 0.72, 0, station.z,
      station.width * 0.72, 0, station.z
    );
  }
  const indices = [];
  for (let index = 0; index < stations.length - 1; index++) {
    const a = index * 4;
    const b = (index + 1) * 4;
    indices.push(
      a, b, b + 1, a, b + 1, a + 1,
      a + 2, a + 3, b + 3, a + 2, b + 3, b + 2,
      a, a + 2, b + 2, a, b + 2, b,
      a + 1, b + 1, b + 3, a + 1, b + 3, a + 3
    );
  }
  indices.push(
    0, 1, 3, 0, 3, 2,
    12, 14, 15, 12, 15, 13
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

const SCENARIO_MAPS = {
  convoy_shield: {
    id: "hormuz_strait",
    nameKo: "호르무즈 해협",
    nameEn: "STRAIT OF HORMUZ",
    bounds: { west: 54.9, south: 25.0, east: 57.0, north: 27.3 },
    projection: {
      centerLon: 55.95,
      centerLat: 26.15,
      worldWidth: 112,
      worldDepth: 136.6,
      type: "local-equirectangular-cos26"
    },
    camera: { centerLon: 55.98, centerLat: 26.36, height: 44, distance: 38 },
    route: [
      [55.12, 26.20],
      [55.48, 26.28],
      [55.85, 26.35],
      [56.18, 26.40],
      [56.38, 26.453333],
      [56.505, 26.453333],
      [56.565, 26.436667],
      [56.631667, 26.356667],
      [56.82, 26.28]
    ]
  },
  tanker_rescue: {
    id: "larak_tanker_rescue",
    nameKo: "라락섬 남동 해역 · 나포 유조선 구출 구역",
    nameEn: "SOUTHEAST OF LARAK ISLAND · TANKER RESCUE AREA",
    bounds: { west: 55.6, south: 25.9, east: 57.05, north: 27.15 },
    projection: {
      centerLon: 56.325,
      centerLat: 26.525,
      worldWidth: 112,
      worldDepth: 118,
      type: "larak-rescue-local"
    },
    camera: { centerLon: 56.34, centerLat: 26.60, height: 38, distance: 32 },
    route: [
      [56.34, 26.66],
      [56.46, 26.60],
      [56.58, 26.52],
      [56.72, 26.42],
      [56.88, 26.30],
      [57.00, 26.20]
    ]
  },
  large_fleet_battle: {
    id: "jask_joint_battle",
    nameKo: "오만만 북서부 · 자스크 남쪽 가상 교전구역",
    nameEn: "NORTHWEST GULF OF OMAN · FICTIONAL SECTOR SOUTH OF JASK",
    bounds: { west: 56.3, south: 24.7, east: 59.2, north: 26.2 },
    projection: {
      centerLon: 57.75,
      centerLat: 25.45,
      worldWidth: 134,
      worldDepth: 110,
      type: "jask-joint-battle-local"
    },
    camera: { centerLon: 57.75, centerLat: 25.45, height: 54, distance: 48 },
    route: [
      [56.45, 25.02],
      [56.78, 25.10],
      [57.12, 25.18],
      [57.48, 25.27],
      [57.84, 25.35],
      [58.18, 25.41],
      [58.54, 25.45],
      [58.90, 25.48]
    ]
  },
  missile_screen: {
    id: "western_gulf",
    nameKo: "페르시아만 서부 · 바레인-카타르 해역",
    nameEn: "WESTERN PERSIAN GULF · BAHRAIN-QATAR SECTOR",
    bounds: { west: 49.3, south: 24.1, east: 53.1, north: 27.4 },
    projection: {
      centerLon: 51.2,
      centerLat: 25.75,
      worldWidth: 136,
      worldDepth: 124,
      type: "western-gulf-local"
    },
    camera: { centerLon: 51.1, centerLat: 26.0, height: 47, distance: 41 },
    route: [
      [50.20, 25.80],
      [50.60, 25.85],
      [51.00, 26.00],
      [51.40, 26.15],
      [51.80, 26.30],
      [52.30, 26.45],
      [52.80, 26.60]
    ]
  },
  mine_corridor: {
    id: "gulf_of_oman",
    nameKo: "오만만 · 푸자이라 동쪽 해역",
    nameEn: "GULF OF OMAN · EAST OF FUJAIRAH",
    bounds: { west: 55.5, south: 24.3, east: 58.7, north: 26.5 },
    projection: {
      centerLon: 57.1,
      centerLat: 25.4,
      worldWidth: 132,
      worldDepth: 112,
      type: "gulf-of-oman-local"
    },
    camera: { centerLon: 57.15, centerLat: 25.32, height: 46, distance: 40 },
    route: [
      [56.45, 25.00],
      [56.75, 25.10],
      [57.10, 25.30],
      [57.70, 25.45],
      [58.25, 25.55]
    ]
  },
  coastal_battery: {
    id: "bushehr_coast",
    nameKo: "이란 남부 · 부셰르 연안 가상 작전구역",
    nameEn: "SOUTHERN IRAN · FICTIONAL BUSHEHR COAST SECTOR",
    bounds: { west: 49.7, south: 27.8, east: 52.0, north: 30.1 },
    projection: {
      centerLon: 50.85,
      centerLat: 28.95,
      worldWidth: 118,
      worldDepth: 128,
      type: "bushehr-coast-local"
    },
    camera: { centerLon: 50.86, centerLat: 28.82, height: 48, distance: 42 },
    route: [
      [50.20, 28.30],
      [50.45, 28.42],
      [50.70, 28.55],
      [50.95, 28.64],
      [51.25, 28.68]
    ]
  },
  pickaxe_mountain: {
    id: "pickaxe_mountain",
    nameKo: "나탄즈 남쪽 · 곡괭이산 의심 지하시설",
    nameEn: "SOUTH OF NATANZ · PICKAXE MOUNTAIN SUSPECTED UNDERGROUND SITE",
    surface: "land",
    bounds: { west: 51.5, south: 33.5, east: 51.9, north: 33.9 },
    projection: {
      centerLon: 51.7,
      centerLat: 33.7,
      worldWidth: 112,
      worldDepth: 112,
      type: "pickaxe-mountain-local"
    },
    camera: { centerLon: 51.70, centerLat: 33.70, height: 42, distance: 35 },
    route: [
      [51.53, 33.58],
      [51.58, 33.62],
      [51.63, 33.66],
      [51.68, 33.70],
      [51.73, 33.74],
      [51.80, 33.80]
    ]
  }
};

function repositionSpawns(spawns, coordinates) {
  return spawns.map((spawn, index) => {
    const fallback = coordinates[coordinates.length - 1];
    const extraIndex = Math.max(0, index - coordinates.length);
    const angle = extraIndex / 4 * Math.PI * 2;
    const radius = 0.11 + Math.floor(extraIndex / 4) * 0.05;
    const coordinate = coordinates[index] || [
      fallback[0] + Math.cos(angle) * radius,
      fallback[1] + Math.sin(angle) * radius
    ];
    return { ...spawn, lon: coordinate[0], lat: coordinate[1] };
  });
}

function createTelDefinition() {
  return {
    name: "이란 이동식 미사일 발사 차량",
    nameEn: "Iranian mobile missile launcher",
    shortName: "TEL",
    model: "assets/models/strategic-v1/coastal-defense-tel-meshy6-web-strategic-v2.glb",
    strategicModel: "assets/models/battle-ultra-v2/coastal-defense-tel-meshy-ultra-v2.glb",
    heroModel: true,
    desiredSize: 3.2,
    strategicDisplayScale: 1.0,
    strategicEmissive: 0,
    domain: "land",
    modelYaw: 1.5707963268,
    fallbackYaw: 1.5707963268,
    acceleration: 0,
    deceleration: 8,
    turnRate: 0,
    slowRadius: 1,
    collisionRadius: 1.5,
    weapon: "missile",
    sockets: { missile: [0, 1.25, 0] },
    altitude: 1.05,
    maxHp: 165,
    speed: 0,
    range: 19,
    vision: 24,
    damage: 32,
    cooldown: 5.8,
    projectileSpeed: 29,
    contactShadow: {
      width: 4.3,
      depth: 2.15,
      opacity: 0.72,
      offsetX: -0.18,
      offsetZ: 0.22
    },
    cost: 0
  };
}

function createEnemyMarineDefinition(baseMarine, overrides = {}) {
  return {
    ...baseMarine,
    name: "이란 혁명수비대 지상 전투원",
    nameEn: "IRGC ground combatant",
    shortName: "IRGC-G",
    maxHp: 64,
    damage: 6,
    cooldown: 0.56,
    cost: 0,
    model: "assets/models/combined-arms-v1/irgc-ground-combatant-meshy-rigged-web-v1.glb",
    walkAnimation: "assets/models/combined-arms-v1/irgc-ground-combatant-meshy-walk-armature-web-v1.glb",
    combatAnimation: "assets/models/combined-arms-v1/irgc-ground-combatant-meshy-combat-web-v1.glb",
    weaponModel: "assets/models/combined-arms-v1/ak-rifle-meshy-t2-web-v1.glb",
    weaponDesiredSize: 0.86,
    weaponOffset: [0.1449, 0.0916, 0.068],
    weaponRotation: [-1.8228, -0.4597, -0.7207],
    weaponGripPoint: [-0.18, -0.04, 0],
    weaponMuzzleOffset: [0.49, 0, 0],
    weaponAimYawCorrection: -0.724,
    strategicCombatBasePoseFraction: 0.1,
    readyPoseFraction: 0.4,
    heroModel: true,
    ...overrides
  };
}

function createEnemyUsvDefinition(baseUsv) {
  return {
    ...baseUsv,
    name: "이란 무인수상정",
    nameEn: "Iranian unmanned surface vessel",
    shortName: "USV",
    maxHp: 82,
    speed: 6.2,
    range: 8.2,
    vision: 20,
    damage: 14,
    cooldown: 0.9,
    cost: 0
  };
}

function createAirThreatDefinition(baseFighter) {
  return {
    ...baseFighter,
    name: "이란 공중위협기",
    nameEn: "Iranian air threat",
    shortName: "공중위협",
    model: baseFighter.formationModel || baseFighter.model,
    formationModel: null,
    desiredSize: 1.2,
    modelYaw: baseFighter.modelYaw,
    altitude: 5.2,
    maxHp: 62,
    speed: 7.1,
    range: 7.2,
    vision: 18,
    damage: 16,
    cooldown: 3.8,
    projectileSpeed: 28,
    cost: 0
  };
}

function createBunkerEntranceDefinition() {
  return {
    name: "곡괭이산 지하 진입부",
    nameEn: "Pickaxe Mountain underground entrance",
    shortName: "진입부",
    /* 타격 목표인데 모델이 없어 도형으로 그려지고 있었다.
     * Meshy 로 만든 콘크리트 갱구를 붙인다(1,414 삼각형). */
    model: "assets/models/objectives-v1/bunker-entrance-meshy-web-v1.glb",
    heroModel: true,
    desiredSize: 5.8,
    domain: "land",
    modelYaw: 0,
    fallbackYaw: 0,
    acceleration: 0,
    deceleration: 8,
    turnRate: 0,
    slowRadius: 1,
    collisionRadius: 2.55,
    weapon: "none",
    altitude: 0.08,
    maxHp: 230,
    speed: 0,
    range: 0,
    vision: 0,
    damage: 0,
    cooldown: 99,
    projectileSpeed: 0,
    contactShadow: {
      width: 5.4,
      depth: 4.4,
      opacity: 0.62,
      offsetX: 0,
      offsetZ: 0.18
    },
    cost: 0
  };
}

function polygonIntersectsBounds(polygon, bounds) {
  if (!polygon?.outer?.length) return false;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of polygon.outer) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return maxLon >= bounds.west
    && minLon <= bounds.east
    && maxLat >= bounds.south
    && minLat <= bounds.north;
}

function clipRingToBounds(ring, bounds) {
  let points = ring.slice();
  if (
    points.length > 1
    && points[0][0] === points[points.length - 1][0]
    && points[0][1] === points[points.length - 1][1]
  ) points = points.slice(0, -1);
  const clip = (input, inside, intersect) => {
    if (!input.length) return [];
    const output = [];
    let previous = input[input.length - 1];
    let previousInside = inside(previous);
    for (const current of input) {
      const currentInside = inside(current);
      if (currentInside !== previousInside) output.push(intersect(previous, current));
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
    return output;
  };
  const verticalIntersection = (x) => (a, b) => {
    const ratio = (x - a[0]) / ((b[0] - a[0]) || 0.0000001);
    return [x, a[1] + (b[1] - a[1]) * ratio];
  };
  const horizontalIntersection = (y) => (a, b) => {
    const ratio = (y - a[1]) / ((b[1] - a[1]) || 0.0000001);
    return [a[0] + (b[0] - a[0]) * ratio, y];
  };
  points = clip(points, (point) => point[0] >= bounds.west, verticalIntersection(bounds.west));
  points = clip(points, (point) => point[0] <= bounds.east, verticalIntersection(bounds.east));
  points = clip(points, (point) => point[1] >= bounds.south, horizontalIntersection(bounds.south));
  points = clip(points, (point) => point[1] <= bounds.north, horizontalIntersection(bounds.north));
  return points;
}

function applyScenarioProfile(config, scenarioId) {
  config.scenarioMap = SCENARIO_MAPS[scenarioId] || SCENARIO_MAPS.convoy_shield;
  Object.assign(config.battle.camera, config.scenarioMap.camera);
  const baseAllies = config.spawns.filter((spawn) => spawn.team === "ally");
  const baseTankers = config.spawns.filter((spawn) => spawn.team === "civilian");
  let allySpawns = baseAllies;
  let tankerSpawns = baseTankers.map((spawn, index) => ({
    ...spawn,
    forceCount: 1,
    routeOffset: index === 0 ? 0.03 : 0.42
  }));
  const setStrings = (values) => {
    Object.assign(config.strings.ko, values.ko);
    Object.assign(config.strings.en, values.en);
  };

  if (scenarioId === "large_fleet_battle") {
    config.fleetSelection.budget = 2700;
    config.fleetSelection.supplementalAmount = 500;
    /* 추천 편성이 예산 2700 중 1790 만 쓰고 있었다. 라락과 같은 이유로 올린다. */
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 3,
      default: 3
    });
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 8,
      default: 4
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 5,
      default: 3
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 1,
      default: 1
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 4,
      default: 4
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 1,
      default: 0
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 0,
      default: 0
    });
    config.unitTypes.enemyUsv = createEnemyUsvDefinition(config.unitTypes.usv);
    config.unitTypes.airThreat = createAirThreatDefinition(config.unitTypes.fighter);
    config.unitTypes.fastBoat.heroModel = false;
    config.unitTypes.tanker.heroModel = false;
    config.unitTypes.fighter.heroModel = false;
    config.unitTypes.airThreat.heroModel = false;
    config.unitTypes.enemyUsv.heroModel = false;
    config.unitTypes.usv.heroModel = false;
    config.unitTypes.bomber.heroModel = false;
    config.unitTypes.helicopter = {
      ...config.unitTypes.helicopter,
      model: config.unitTypes.helicopter.strategicModel,
      formationModel: null,
      strategicModel: null,
      heroModel: true
    };
    allySpawns = repositionSpawns(baseAllies, [
      [56.76, 25.10],
      [56.60, 25.02],
      [56.82, 25.18],
      [56.50, 24.98],
      [56.92, 25.16],
      [56.42, 24.94]
    ]);
    tankerSpawns = [
      [56.72, 25.12, 0.08],
      [57.02, 25.19, 0.34],
      [57.32, 25.26, 0.60]
    ].map(([lon, lat, routeOffset], index) => ({
      ...baseTankers[index % baseTankers.length],
      id: `large-tanker-${index + 1}`,
      callsign: `유조선 ${index + 1}`,
      lon,
      lat,
      routeOffset,
      forceCount: 1,
      hero: true,
      strategicLod: true,
      instancedLod: true,
      wake: index === 0
    }));
    const fastBoatSpawns = Array.from({ length: 12 }, (_, index) => {
      const wing = Math.floor(index / 4);
      const wingIndex = index % 4;
      const column = wingIndex % 2;
      const row = Math.floor(wingIndex / 2);
      return {
        id: `large-fac-${index + 1}`,
        team: "enemy",
        type: "fastBoat",
        callsign: `고속정 ${index + 1}`,
        callsignKey: "largeFastBoatCallsign",
        callsignIndex: index + 1,
        lon: [57.62, 58.02, 58.42][wing] + column * 0.08,
        lat: [25.30, 25.38, 25.46][wing] + row * 0.07,
        forceCount: 1,
        hero: true,
        modelVariant: index < 4 ? "hero" : "formation",
        strategicLod: true,
        instancedLod: true,
        wake: index === 0,
        aiIndex: index,
        fireStagger: (index % 6) * 0.13,
        damageMultiplier: 0.22
      };
    });
    const enemyUsvSpawns = Array.from({ length: 4 }, (_, index) => ({
      id: `large-enemy-usv-${index + 1}`,
      team: "enemy",
      type: "enemyUsv",
      callsign: `무인수상정 ${index + 1}`,
      callsignKey: "largeEnemyUsvCallsign",
      callsignIndex: index + 1,
      lon: 57.48 + (index % 2) * 0.22,
      lat: 25.20 + Math.floor(index / 2) * 0.12,
      forceCount: 1,
      hero: false,
      strategicLod: true,
      instancedLod: true,
      wake: index === 0,
      aiIndex: index,
      fireStagger: (index % 4) * 0.11
    }));
    const airThreatSpawns = Array.from({ length: 4 }, (_, index) => ({
      id: `large-air-threat-${index + 1}`,
      team: "enemy",
      type: "airThreat",
      callsign: `공중위협 ${index + 1}`,
      callsignKey: "largeAirThreatCallsign",
      callsignIndex: index + 1,
      lon: 57.90 + (index % 2) * 0.28,
      lat: 25.18 + Math.floor(index / 2) * 0.18,
      forceCount: 1,
      hero: false,
      strategicLod: true,
      instancedLod: true,
      aiIndex: index,
      fireStagger: index * 0.16
    }));
    config.spawns = [
      ...allySpawns,
      ...tankerSpawns,
      ...fastBoatSpawns,
      ...enemyUsvSpawns,
      ...airThreatSpawns
    ];
    Object.assign(config.battle, {
      id: "jask_large_joint_battle_v3",
      scale: "large",
      durationSeconds: 600,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 20,
      minimumTankersToSave: 2
    });
    setStrings({
      ko: {
        title: config.strings.ko.largeTitle,
        subtitle: config.strings.ko.largeSubtitle,
        objective: config.strings.ko.largeObjective,
        operationName: config.strings.ko.largeOperationName,
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: config.strings.ko.largeThreatValue,
        briefProtectedValue: config.strings.ko.largeProtectedValue,
        fleetTitle: config.strings.ko.largeFleetTitle,
        contactCountdown: config.strings.ko.largeContactCountdown,
        contactCountdownNow: config.strings.ko.largeContactNow,
        enemyGroupCallsign: config.strings.ko.largeEnemyGroupCallsign,
        largeFastBoatCallsign: config.strings.ko.largeFastBoatCallsign,
        largeEnemyUsvCallsign: config.strings.ko.largeEnemyUsvCallsign,
        largeAirThreatCallsign: config.strings.ko.largeAirThreatCallsign,
        enemyProgress: config.strings.ko.largeEnemyProgress,
        resultEnemyLabel: config.strings.ko.largeResultEnemyLabel,
        victoryTitle: config.strings.ko.largeVictoryTitle,
        victoryText: config.strings.ko.largeVictoryText,
        defeatTitle: config.strings.ko.largeDefeatTitle,
        defeatText: config.strings.ko.largeDefeatText
      },
      en: {
        title: config.strings.en.largeTitle,
        subtitle: config.strings.en.largeSubtitle,
        objective: config.strings.en.largeObjective,
        operationName: config.strings.en.largeOperationName,
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: config.strings.en.largeThreatValue,
        briefProtectedValue: config.strings.en.largeProtectedValue,
        fleetTitle: config.strings.en.largeFleetTitle,
        contactCountdown: config.strings.en.largeContactCountdown,
        contactCountdownNow: config.strings.en.largeContactNow,
        enemyGroupCallsign: config.strings.en.largeEnemyGroupCallsign,
        largeFastBoatCallsign: config.strings.en.largeFastBoatCallsign,
        largeEnemyUsvCallsign: config.strings.en.largeEnemyUsvCallsign,
        largeAirThreatCallsign: config.strings.en.largeAirThreatCallsign,
        enemyProgress: config.strings.en.largeEnemyProgress,
        resultEnemyLabel: config.strings.en.largeResultEnemyLabel,
        victoryTitle: config.strings.en.largeVictoryTitle,
        victoryText: config.strings.en.largeVictoryText,
        defeatTitle: config.strings.en.largeDefeatTitle,
        defeatText: config.strings.en.largeDefeatText
      }
    });
    return;
  }

  if (scenarioId === "tanker_rescue") {
    config.fleetSelection.budget = 600;
    config.fleetSelection.supplementalAmount = 240;
    /* 추천 편성이 예산을 다 쓰게 한다.
     *
     * 예전 추천은 구축함1·전투기1·헬기1 로 380 이었다. 예산 600 중 220 을 남긴다.
     * 적이 개전과 동시에 사격하게 되자 이 여유분이 그대로 패배로 돌아왔다 —
     * 구조 헬기가 한 대뿐이라 그것만 떨어지면 임무 자체가 불가능해졌고,
     * 난이도 3·5 에서 자동전투로 이길 수 없었다. 예산 안에서 짠 편성으로 다시
     * 재보니 세 가지 조합 모두 난이도 5 를 33~40초에 이겼다. 부족했던 것은
     * 적의 강함이 아니라 안 쓰고 남긴 예산이었다. */
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 2,
      default: 1
    });
    /* 화면에 올릴 수 있는 삼각형에는 한계가 있다. 예산을 다 쓰는 편성(6대)은
     * 예산 120,000 을 넘겨(130,308) 프레임이 떨어진다. 헬기는 격추되면 임무
     * 자체가 불가능해지므로 2대를 유지하고, 나머지를 줄인다. */
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 3,
      default: 1
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 3,
      default: 2
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 0,
      default: 0
    });
    allySpawns = repositionSpawns(baseAllies, [
      [56.05, 26.45],
      [55.98, 26.39],
      [56.10, 26.42],
      [55.82, 26.30],
      [56.14, 26.46],
      [55.90, 26.34]
    ]);
    const rescueTanker = {
      ...baseTankers[0],
      id: "captured-tanker",
      callsign: "나포 유조선",
      lon: 56.34,
      lat: 26.66,
      routeOffset: -0.13,
      forceCount: 1,
      hero: true,
      strategicLod: true,
      instancedLod: true,
      rescueTarget: true,
      captured: true,
      wake: true
    };
    config.unitTypes.enemyUsv = createEnemyUsvDefinition(config.unitTypes.usv);
    const rescueFastBoats = [
      [56.24, 26.60],
      [56.31, 26.57],
      [56.40, 26.58],
      [56.47, 26.63]
    ].map(([lon, lat], index) => ({
      id: `rescue-fac-${index + 1}`,
      team: "enemy",
      type: "fastBoat",
      callsign: `고속정 ${index + 1}`,
      callsignKey: "rescueFastBoatCallsign",
      callsignIndex: index + 1,
      lon,
      lat,
      forceCount: 1,
      hero: true,
      strategicLod: true,
      instancedLod: true,
      wake: index < 2,
      aiIndex: index,
      fireStagger: index * 0.16,
      damageMultiplier: 0.72
    }));
    const rescueUsvs = [
      [56.27, 26.71],
      [56.44, 26.72]
    ].map(([lon, lat], index) => ({
      id: `rescue-usv-${index + 1}`,
      team: "enemy",
      type: "enemyUsv",
      callsign: `무인수상정 ${index + 1}`,
      callsignKey: "rescueEnemyUsvCallsign",
      callsignIndex: index + 1,
      lon,
      lat,
      forceCount: 1,
      hero: true,
      strategicLod: true,
      instancedLod: true,
      wake: true,
      aiIndex: index + 4,
      fireStagger: (index + 4) * 0.16,
      damageMultiplier: 0.68
    }));
    config.spawns = [
      ...allySpawns,
      rescueTanker,
      ...rescueFastBoats,
      ...rescueUsvs
    ];
    Object.assign(config.battle, {
      id: "tanker_rescue_rts_v1",
      durationSeconds: 300,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 6,
      minimumTankersToSave: 1,
      requiredFleetType: "helicopter",
      rescueRadius: 4.8,
      rescueHoldSeconds: 5
    });
    setStrings({
      ko: {
        title: config.strings.ko.rescueTitle,
        subtitle: config.strings.ko.rescueSubtitle,
        objective: config.strings.ko.rescueObjective,
        operationName: config.strings.ko.rescueOperationName,
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: config.strings.ko.rescueThreatValue,
        briefProtectedValue: config.strings.ko.rescueProtectedValue,
        fleetTitle: config.strings.ko.rescueFleetTitle,
        contactCountdown: config.strings.ko.rescueContactCountdown,
        contactCountdownNow: config.strings.ko.rescueContactNow,
        enemyGroupCallsign: config.strings.ko.rescueEnemyGroupCallsign,
        rescueFastBoatCallsign: config.strings.ko.rescueFastBoatCallsign,
        rescueEnemyUsvCallsign: config.strings.ko.rescueEnemyUsvCallsign,
        convoyGroupCallsign: config.strings.ko.rescueConvoyGroupCallsign,
        enemyProgress: config.strings.ko.rescueEnemyProgress,
        civilian: config.strings.ko.rescueCivilian,
        radarConvoy: config.strings.ko.rescueRadarConvoy,
        resultEnemyLabel: config.strings.ko.rescueResultEnemyLabel,
        resultCivilianLabel: config.strings.ko.rescueResultCivilianLabel,
        victoryTitle: config.strings.ko.rescueVictoryTitle,
        victoryText: config.strings.ko.rescueVictoryText,
        defeatTitle: config.strings.ko.rescueDefeatTitle,
        defeatText: config.strings.ko.rescueDefeatText
      },
      en: {
        title: config.strings.en.rescueTitle,
        subtitle: config.strings.en.rescueSubtitle,
        objective: config.strings.en.rescueObjective,
        operationName: config.strings.en.rescueOperationName,
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: config.strings.en.rescueThreatValue,
        briefProtectedValue: config.strings.en.rescueProtectedValue,
        fleetTitle: config.strings.en.rescueFleetTitle,
        contactCountdown: config.strings.en.rescueContactCountdown,
        contactCountdownNow: config.strings.en.rescueContactNow,
        enemyGroupCallsign: config.strings.en.rescueEnemyGroupCallsign,
        rescueFastBoatCallsign: config.strings.en.rescueFastBoatCallsign,
        rescueEnemyUsvCallsign: config.strings.en.rescueEnemyUsvCallsign,
        convoyGroupCallsign: config.strings.en.rescueConvoyGroupCallsign,
        enemyProgress: config.strings.en.rescueEnemyProgress,
        civilian: config.strings.en.rescueCivilian,
        radarConvoy: config.strings.en.rescueRadarConvoy,
        resultEnemyLabel: config.strings.en.rescueResultEnemyLabel,
        resultCivilianLabel: config.strings.en.rescueResultCivilianLabel,
        victoryTitle: config.strings.en.rescueVictoryTitle,
        victoryText: config.strings.en.rescueVictoryText,
        defeatTitle: config.strings.en.rescueDefeatTitle,
        defeatText: config.strings.en.rescueDefeatText
      }
    });
    return;
  }

  if (scenarioId === "pickaxe_mountain") {
    config.fleetSelection.budget = 960;
    config.fleetSelection.supplementalAmount = 320;
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 2,
      default: 1,
      cost: 320
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 0,
      default: 0
    });
    config.unitTypes.bomber = {
      ...config.unitTypes.bomber,
      name: "B-2A 스피릿 스텔스 폭격기",
      nameEn: "B-2A Spirit stealth bomber",
      shortName: "B-2",
      weapon: "bunkerBomb",
      weaponProfile: {
        system: "GBU-57 Massive Ordnance Penetrator",
        role: "hard-and-deeply-buried-target",
        gamePowerIndex: 260,
        basisKo: "미 공군·미 국방부 공개자료의 30,000파운드급 지하시설 관통탄과 B-2 전용 투발 기록 기준"
      },
      maxShots: 2,
      damage: 260,
      cooldown: 5.8,
      projectileSpeed: 30,
      range: 18,
      sockets: {
        muzzle: [0, -0.2, 0.08],
        missile: [0, -0.2, 0.08]
      }
    };
    config.unitTypes.tel = {
      ...createTelDefinition(),
      name: "이란 방공 미사일 발사 차량",
      nameEn: "Iranian air-defense missile launcher",
      shortName: "방공 TEL",
      heroModel: true,
      range: 17,
      damage: 28,
      cooldown: 6.4
    };
    config.unitTypes.bunkerEntrance = createBunkerEntranceDefinition();
    allySpawns = repositionSpawns(baseAllies, [
      [51.54, 33.58],
      [51.56, 33.60],
      [51.58, 33.62],
      [51.54, 33.60],
      [51.55, 33.61],
      [51.625, 33.655]
    ]).map((spawn) => (
      spawn.type === "bomber"
        ? { ...spawn, callsign: "B-2 스피릿", hero: true }
        : spawn
    ));
    const bunkerSpawns = [
      [51.700, 33.706, "지하 진입부 A"],
      [51.712, 33.714, "지하 진입부 B"]
    ].map(([lon, lat, callsign], index) => ({
      id: `pickaxe-entrance-${index + 1}`,
      team: "enemy",
      type: "bunkerEntrance",
      callsign,
      lon,
      lat,
      forceCount: 1,
      // 실제 갱구 모델을 붙였으므로 도형이 아니라 모델로 그린다.
      hero: true,
      fixed: true,
      objectiveTarget: true
    }));
    const airDefenseSpawns = [
      [51.675, 33.688],
      [51.738, 33.695],
      [51.760, 33.680]
    ].map(([lon, lat], index) => ({
      id: `pickaxe-air-defense-${index + 1}`,
      team: "enemy",
      type: "tel",
      callsign: `방공 발사 차량 ${index + 1}`,
      lon,
      lat,
      forceCount: 1,
      hero: true,
      fixed: true,
      objectiveTarget: false,
      aiIndex: index,
      fireStagger: index * 0.22
    }));
    config.spawns = [
      ...allySpawns,
      ...bunkerSpawns,
      ...airDefenseSpawns
    ];
    Object.assign(config.battle, {
      id: "pickaxe_mountain_b2_strike_v1",
      briefingImage: "assets/images/briefings/pickaxe-mountain-b2-briefing-v1.webp",
      successImage: "assets/images/briefings/pickaxe-mountain-access-sealed-v1.webp",
      durationSeconds: 260,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 2,
      objectiveTargetType: "bunkerEntrance",
      minimumTankersToSave: 0,
      requiredFleetType: "bomber",
      requiredFleetMessageKey: "bunkerBomberRequired"
    });
    setStrings({
      ko: {
        pageTitle: "HORMUZ · 곡괭이산 제한 타격",
        title: "곡괭이산 지하시설 제한 타격",
        subtitle: "B-2 스텔스 전략폭격기를 지휘해 GBU-57을 투하하고 확인된 지하 진입부만 봉쇄하십시오.",
        objective: "B-2로 GBU-57 2발 투하 · 지하 진입부 2곳 봉쇄",
        operationName: "곡괭이산 진입부 봉쇄 작전",
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: "지하 진입부 2곳 · 주변 방공 발사 차량 3기",
        briefProtectedValue: "B-2 스텔스 전략폭격기 · 주변 비전투 구역",
        fleetTitle: "B-2 스텔스 폭격기 출격 편성",
        fleetSummaryBomber: "B-2 스텔스 폭격기",
        bunkerBomberRequired: "GBU-57은 B-2만 운반할 수 있습니다. B-2를 최소 1대 편성하십시오.",
        bunkerAmmoEmpty: "이 B-2의 GBU-57 2발을 모두 사용했습니다.",
        bunkerAmmoStatus: "GBU-57 {remaining}/{total}발",
        bunkerNextTarget: "GBU-57 1발 남음 · 다음 지하 진입부를 선택하고 우클릭하십시오.",
        contactCountdown: "방공망 반응 전 진입 경로를 정하고 지하 진입부를 직접 지정하십시오.",
        contactCountdownNow: "방공망이 이미 반응하고 있습니다. 진입 경로를 정하고 지하 진입부를 직접 지정하십시오.",
        enemyGroupCallsign: "곡괭이산 방공망",
        enemyProgress: "곳 봉쇄",
        civilian: "비전투원",
        radarConvoy: "비전투 구역",
        resultEnemyLabel: "봉쇄한 지하 진입부",
        resultCivilianLabel: "확인된 민간 피해",
        victoryTitle: "지하 진입부 봉쇄 완료",
        victoryText: "확인된 진입부 2곳을 봉쇄했습니다. 시설 내부의 실제 피해와 용도는 확인되지 않았습니다.",
        defeatTitle: "제한 타격 목표 미달",
        defeatText: "관통탄이 소진됐거나 스텔스 폭격기가 이탈했습니다. 내부 피해평가는 확정할 수 없습니다.",
        factNotice: "사실 경계: 곡괭이산은 나탄즈 남쪽의 별도 지하시설입니다. IAEA가 용도·내부 배치를 확인하지 못했으며, 이 임무는 공개자료 기반 가상 시뮬레이션입니다."
      },
      en: {
        pageTitle: "HORMUZ · Pickaxe Mountain Limited Strike",
        title: "Pickaxe Mountain limited underground strike",
        subtitle: "Command B-2 stealth strategic bombers, release GBU-57s, and seal only the confirmed underground access points.",
        objective: "Release 2 GBU-57s from B-2s and seal 2 underground access points",
        operationName: "Pickaxe Access Denial",
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: "2 underground access points · 3 air-defense launch vehicles",
        briefProtectedValue: "B-2 stealth strategic bombers · surrounding noncombat area",
        fleetTitle: "B-2 strategic bomber package",
        fleetSummaryBomber: "B-2 stealth bomber",
        bunkerBomberRequired: "Only the B-2 can carry the GBU-57. Assign at least one B-2.",
        bunkerAmmoEmpty: "This B-2 has released both of its GBU-57 weapons.",
        bunkerAmmoStatus: "GBU-57 {remaining}/{total}",
        bunkerNextTarget: "1 GBU-57 remains · select and right-click the next underground entrance.",
        contactCountdown: "Set the ingress route and designate the underground access points before the air defenses react.",
        contactCountdownNow: "The air defenses are already reacting · Set the ingress route and designate the underground access points.",
        enemyGroupCallsign: "Pickaxe air-defense network",
        enemyProgress: " access points sealed",
        civilian: "NONCOMBAT",
        radarConvoy: "NONCOMBAT AREA",
        resultEnemyLabel: "Access points sealed",
        resultCivilianLabel: "Confirmed civilian harm",
        victoryTitle: "Underground access points sealed",
        victoryText: "Both confirmed access points were sealed. The site's purpose and internal damage remain unverified.",
        defeatTitle: "Limited strike incomplete",
        defeatText: "The penetrators were expended or the bomber package withdrew. Internal damage cannot be confirmed.",
        factNotice: "Fact boundary: Pickaxe Mountain is a separate site south of Natanz. The IAEA has not verified its purpose or internal layout. This mission is a fictional simulation based on public reporting."
      }
    });
    return;
  }

  if (scenarioId === "coastal_battery") {
    config.fleetSelection.budget = 1000;
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 4,
      default: 2
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 1,
      default: 0
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 2,
      default: 1
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 4,
      default: 2
    });
    allySpawns = repositionSpawns(baseAllies, [
      [50.55, 28.50],
      [50.35, 28.40],
      [50.60, 28.45]
    ]);
    allySpawns.push({
      id: "usmc-coastal",
      team: "ally",
      type: "marine",
      callsign: "지상병력",
      lon: 50.56,
      lat: 28.93,
      hero: false
    });
    config.unitTypes.tel = createTelDefinition();
    config.unitTypes.enemyMarine = createEnemyMarineDefinition(
      config.unitTypes.marine,
      {
        name: "이란 혁명수비대 포대 경비 분대",
      nameEn: "IRGC battery guard squad",
        maxHp: 105,
        damage: 8.5,
        cooldown: 0.52
      }
    );
    const coastalTelPositions = [
      [50.85, 28.98], [51.05, 29.08], [51.15, 29.18], [51.35, 29.05]
    ];
    const coastalGuardPositions = [
      [50.89, 29.06], [51.01, 29.13], [51.20, 29.16], [51.32, 29.10]
    ];
    config.spawns = [
      ...allySpawns,
      ...coastalTelPositions.map(([lon, lat], index) => ({
        id: `tel-${index + 1}`,
        team: "enemy",
        type: "tel",
        callsign: `이동식 발사 차량 ${index + 1}`,
        callsignKey: "coastalTelCallsign",
        callsignIndex: index + 1,
        lon,
        lat,
        forceCount: 1,
        hero: true,
        fixed: true
      })),
      ...coastalGuardPositions.map(([lon, lat], index) => ({
        id: `coastal-guard-${index + 1}`,
        team: "enemy",
        type: "enemyMarine",
        callsign: `포대 경비 분대 ${index + 1}`,
        callsignKey: "coastalGuardCallsign",
        callsignIndex: index + 1,
        lon,
        lat,
        forceCount: 1,
        hero: true,
        aiIndex: index,
        fireStagger: index * 0.11
      }))
    ];
    Object.assign(config.battle, {
      id: "coastal_battery_rts_v1",
      /* 적 화력을 3배로 올려도 155초에 이겼다(제한 260초). 이 전장에서 듣는
       * 압박은 화력이 아니라 시간이다. */
      durationSeconds: 120,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 4,
      objectiveTargetType: "tel",
      minimumTankersToSave: 0
    });
    setStrings({
      ko: {
        title: "연안 미사일 발사대 제압",
        subtitle: "포대 경비 분대의 방어를 돌파하고 육지의 이동식 발사 차량 4기를 무력화하십시오. 해병만 투입하면 매우 불리합니다.",
        objective: "지상 경비 분대 방어 돌파 · 이동식 미사일 발사 차량 4기 파괴",
        operationName: "연안 포대 제압 작전",
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: "이동식 발사 차량 4기 · 포대 경비 분대 4개",
        briefProtectedValue: "아군 타격 편대",
        contactCountdown: "포대 경비 분대가 {delay} 뒤 교전합니다. 공중·해상 지원과 지상군을 함께 운용하십시오.",
        contactCountdownNow: "포대 경비 분대가 이미 교전 중입니다. 공중·해상 지원과 지상군을 함께 운용하십시오.",
        enemyGroupCallsign: "이란 연안 포대",
        coastalTelCallsign: "이동식 발사 차량",
        coastalGuardCallsign: "포대 경비 분대",
        enemyProgress: "기 파괴",
        resultEnemyLabel: "파괴한 발사 차량",
        resultCivilianLabel: "민간 피해",
        victoryTitle: "연안 미사일 포대 제압",
        victoryText: "포대 경비 분대의 방어를 돌파하고 이동식 발사 차량 4기를 무력화했습니다.",
        defeatTitle: "연안 포대 제압 실패",
        defeatText: "지상 경비 분대가 타격 편대를 저지했습니다. 공중·해상 지원을 포함해 전력을 다시 편성하십시오."
      },
      en: {
        title: "Coastal missile battery strike",
        subtitle: "Break through four battery guard squads and neutralize four mobile launch vehicles. A marine-only assault is severely disadvantaged.",
        objective: "Break the ground defense and destroy four mobile missile launch vehicles",
        operationName: "Coastal Battery Suppression",
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: "4 mobile launch vehicles · 4 battery guard squads",
        briefProtectedValue: "Strike package",
        contactCountdown: "Battery guards engage in {delay}. Combine air, naval, and ground support.",
        contactCountdownNow: "The battery guards are already engaging · Combine air, naval, and ground support.",
        enemyGroupCallsign: "Iranian coastal battery",
        coastalTelCallsign: "Mobile launcher",
        coastalGuardCallsign: "Battery guard squad",
        enemyProgress: " launchers destroyed",
        resultEnemyLabel: "Launch vehicles destroyed",
        resultCivilianLabel: "Civilian losses",
        victoryTitle: "Coastal battery suppressed",
        victoryText: "The battery defense was breached and all four launch vehicles were neutralized.",
        defeatTitle: "Coastal strike failed",
        defeatText: "The battery guards stopped the strike package. Rebuild the force with air and naval support."
      }
    });
    return;
  }

  if (scenarioId === "missile_screen") {
    config.fleetSelection.budget = 1600;
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 3,
      default: 1
    });
    /* 이 전투는 적 항공위협이 아군을 거의 때리지 못해, 증원을 두 배로 늘려도
     * 아군 무손실 100% 승리였다. 숫자 대신 추천 편성을 줄여 여유를 없앤다. */
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 4,
      default: 1
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 1,
      default: 0
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 1,
      default: 0
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 0,
      default: 0
    });
    allySpawns = repositionSpawns(baseAllies, [
      [50.60, 25.90],
      [50.40, 25.78],
      [50.70, 25.75]
    ]);
    tankerSpawns = repositionSpawns(tankerSpawns, [
      [50.20, 25.80],
      [50.45, 25.84]
    ]);
    config.unitTypes.airThreat = createAirThreatDefinition(config.unitTypes.fighter);
    config.spawns = [
      ...allySpawns,
      ...tankerSpawns,
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `air-threat-${index + 1}`,
        team: "enemy",
        type: "airThreat",
        callsign: `공중 위협 ${index + 1}`,
        lon: 52.10 + (index % 4) * 0.18,
        lat: 26.55 - Math.floor(index / 4) * 0.22,
        forceCount: 1,
        hero: true,
        aiIndex: index
      }))
    ];
    Object.assign(config.battle, {
      id: "missile_screen_rts_v1",
      /* 적 항공위협을 18기까지 늘려도 아군은 한 대도 안 잃고 이겼다. 이 전장에서
       * 듣는 압박은 적 수가 아니라 요격 창이다. 격추에 걸리는 시간을 승패에
       * 걸리게 만든다. */
      durationSeconds: 160,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 8,
      minimumTankersToSave: 2
    });
    setStrings({
      ko: {
        title: "페르시아만 서부 호송선단 공중 방어",
        subtitle: "바레인-카타르 해역의 넓은 상공 RTS 전장에서 전투기·구축함을 배치하십시오.",
        objective: "공중 위협 8기 제거 · 유조선 2척 이상 지키기",
        operationName: "미사일 방어막 작전",
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: "이란 공중 위협 8기",
        enemyGroupCallsign: "이란 공중 위협",
        enemyProgress: "기 격파",
        resultEnemyLabel: "제거한 공중 위협"
      },
      en: {
        title: "Western Gulf convoy air defense",
        subtitle: "Deploy fighters and destroyers from the overhead RTS view.",
        objective: "Remove 8 air threats and save at least 2 tankers",
        operationName: "Missile Screen",
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: "8 Iranian air threats",
        enemyGroupCallsign: "Iranian air threat",
        enemyProgress: " air threats destroyed",
        resultEnemyLabel: "Air threats removed"
      }
    });
    return;
  }

  if (scenarioId === "mine_corridor") {
    config.fleetSelection.budget = 700;
    Object.assign(config.fleetSelection.options.destroyer, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.fighter, {
      maximum: 2,
      default: 0
    });
    Object.assign(config.fleetSelection.options.helicopter, {
      maximum: 3,
      default: 1
    });
    Object.assign(config.fleetSelection.options.carrier, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.usv, {
      maximum: 4,
      default: 2
    });
    Object.assign(config.fleetSelection.options.bomber, {
      maximum: 0,
      default: 0
    });
    Object.assign(config.fleetSelection.options.marine, {
      maximum: 0,
      default: 0
    });
    allySpawns = repositionSpawns(baseAllies, [
      [56.55, 25.10],
      [56.45, 24.95],
      [56.65, 25.05]
    ]);
    tankerSpawns = repositionSpawns(tankerSpawns, [
      [56.45, 25.00],
      [56.65, 25.06]
    ]);
    config.unitTypes.mine = {
      name: "계류식 해상 기뢰",
      nameEn: "Moored naval mine",
      shortName: "MINE",
      /* 예전에는 모델이 없어 절차형 도형으로 그려졌고, 화면에서는 빨간 표식처럼
       * 보였다. Meshy 로 만든 실제 기뢰를 붙인다(1,229 삼각형). */
      model: "assets/models/objectives-v1/naval-mine-meshy-web-v1.glb",
      heroModel: true,
      desiredSize: 0.9,
      domain: "sea",
      modelYaw: 0,
      fallbackYaw: 0,
      acceleration: 0,
      deceleration: 8,
      turnRate: 0,
      slowRadius: 1,
      collisionRadius: 0.75,
      weapon: "none",
      altitude: 0.05,
      maxHp: 52,
      speed: 0,
      range: 0,
      vision: 0,
      damage: 0,
      cooldown: 99,
      projectileSpeed: 0,
      cost: 0
    };
    config.spawns = [
      ...allySpawns,
      ...tankerSpawns,
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `mine-${index + 1}`,
        team: "enemy",
        type: "mine",
        callsign: `기뢰 ${index + 1}`,
        lon: 57.05 + (index % 4) * 0.17,
        lat: 25.25 + Math.floor(index / 4) * 0.18,
        forceCount: 1,
        // 실제 기뢰 모델을 붙였으므로 도형이 아니라 모델로 그린다.
        hero: true,
        fixed: true
      }))
    ];
    Object.assign(config.battle, {
      id: "mine_corridor_rts_v1",
      durationSeconds: 240,
      enemyEngageDelaySeconds: 0,
      objectiveEnemyCount: 7,
      minimumTankersToSave: 2
    });
    setStrings({
      ko: {
        title: "오만만 안전 회랑 기뢰 제거",
        subtitle: "푸자이라 동쪽 오만만 전장에서 아군을 선택하고 기뢰 7발을 순서대로 제거하십시오.",
        objective: "기뢰 7발 제거 · 유조선 2척 이상 지키기",
        operationName: "안전 회랑 작전",
        briefLocation: config.scenarioMap.nameKo,
        briefThreatValue: "계류식 해상 기뢰 7발",
        enemyGroupCallsign: "해상 기뢰",
        enemyProgress: "발 제거",
        resultEnemyLabel: "제거한 기뢰",
        /* 기뢰는 계류식이라 다가오지 않는다. 기본 문구("적이 곧 접근합니다")를
         * 그대로 쓰면 오지도 않을 적을 기다리게 만든다. */
        contactCountdownNow: "기뢰는 이미 항로에 부설돼 있습니다. 소해 전력을 배치하십시오."
      },
      en: {
        title: "Gulf of Oman mine clearance",
        subtitle: "Select units from the overhead RTS view and clear seven naval mines.",
        objective: "Clear 7 mines and save at least 2 tankers",
        operationName: "Safe Corridor",
        briefLocation: config.scenarioMap.nameEn,
        briefThreatValue: "7 moored naval mines",
        enemyGroupCallsign: "Naval mine",
        enemyProgress: " mines cleared",
        resultEnemyLabel: "Mines cleared",
        contactCountdownNow: "The mines are already laid across the lane · Deploy your countermeasure force."
      }
    });
  }
}

/* 난이도별 적 강도.
 *
 * 예전 값으로는 추천 편성에 손도 안 대고 자동전투만 켜도 21판 중 21판을 이겼다.
 * 난이도 1·3·5 가 전부 100% 였고 곡괭이산은 세 난이도가 모두 13초에 끝나 사실상
 * 차이가 없었다. 편성 화면이 의미가 없어진다.
 *
 * 목표는 "추천 편성 그대로 두면 아슬아슬하게 갈리고, 전력을 조금 더 넣으면
 * 확실히 이긴다" 는 지점이다. 증원 수를 늘리는 쪽으로 올린다 — 체력·화력만
 * 부풀리면 같은 적이 단단해질 뿐 전장이 달라지지 않는다.
 */
const DIFFICULTY_PROFILES = Object.freeze([
  { hp: 1.05, damage: 1.25, delay: 0, reinforcements: 3 },
  { hp: 1.2, damage: 1.55, delay: 3, reinforcements: 5 },
  { hp: 1.36, damage: 1.85, delay: 6, reinforcements: 7 },
  { hp: 1.5, damage: 2.05, delay: 9, reinforcements: 10 },
  { hp: 1.62, damage: 2.25, delay: 12, reinforcements: 13 }
]);

/* 시나리오마다 늘릴 수 있는 적의 상한.
 *
 * 좁은 전장에 무한정 밀어 넣으면 전투가 아니라 밀어내기가 된다. 그리고 적이
 * 많을수록 화면에 그릴 것도 늘어난다 — 난이도 5 개전 직후가 삼각형이 가장
 * 많은 순간이고, 여기서 예산 120,000 을 넘기면 프레임이 떨어진다. */
const REINFORCEMENT_CAPS = Object.freeze({
  /* 한 번 재본 뒤 조합별로 맞춘 값이다.
   * 해협 방패는 6 으로 두니 난이도 3·5 가 0% 가 됐다 — 좁은 해협이라 증원이
   * 그대로 전선에 붙는다. 미사일 차단막·해안 포대는 반대로 상한을 다 써도
   * 100% 라 더 열었다. */
  /* 이 둘은 아군 추천 편성을 예산에 맞춰 올린 전장이다. 아군은 고해상도 모델이라
   * 무겁고, 여기에 증원까지 얹으니 삼각형 예산 120,000 을 넘겼다(해협 151,585 ·
   * 라락 140,552). 아군을 줄이면 승률이 되돌아가므로 증원 쪽을 줄인다. */
  /* 삼각형 예산에 맞추느라 아군을 4대로 줄인 전장이다. 증원 2척이면
   * 난이도 3 이 0% 가 됐다. */
  convoy_shield: 1,
  /* 구조 헬기 2대(19,072)만으로도 무거운 전장이다. 증원을 1척만 더 붙여도
   * 삼각형 예산 120,000 을 넘겼다(122,410). */
  tanker_rescue: 1,
  missile_screen: 7,
  mine_corridor: 5,
  coastal_battery: 1,
  pickaxe_mountain: 2,
  /* 고속정이 15척까지 늘자 전장이 붐벼 전투기가 진입만 하고 투하를 못 했다.
   * 넓은 전장이라 수는 많아도 되지만, 붐비면 기동이 성립하지 않는다. */
  large_fleet_battle: 6
});

function readBattleContext(params) {
  const stance = params.get("stance");
  const counter = params.get("counter") || "";
  return {
    day: clamp(Math.round(Number(params.get("day")) || 1), 1, 54),
    difficulty: clamp(Math.round(Number(params.get("difficulty")) || 1), 1, 5),
    variant: clamp(Math.round(Number(params.get("variant")) || 0), 0, 2),
    repeatCount: clamp(Math.round(Number(params.get("repeat")) || 0), 0, 60),
    wins: clamp(Math.round(Number(params.get("wins")) || 0), 0, 60),
    losses: clamp(Math.round(Number(params.get("losses")) || 0), 0, 60),
    winStreak: clamp(Math.round(Number(params.get("streak")) || 0), 0, 60),
    escalation: clamp(Math.round(Number(params.get("esc")) || 3), 1, 5),
    stance: ["PRAGMATIC", "HARDLINE", "DESPERATE"].includes(stance) ? stance : "HARDLINE",
    counterType: [
      "destroyer", "fighter", "helicopter", "carrier", "usv", "bomber", "marine"
    ].includes(counter) ? counter : "",
    seed: Math.round(Number(params.get("seed")) || 0)
  };
}

function shiftedCoordinate(spawn, scenarioMap, variant, index = 0) {
  const bounds = scenarioMap.bounds;
  const spanLon = bounds.east - bounds.west;
  const spanLat = bounds.north - bounds.south;
  const direction = variant === 1 ? 1 : variant === 2 ? -1 : 0;
  const wave = (index % 2 ? -1 : 1) * (1 + Math.floor(index / 2));
  // 해안선이 복잡한 전장에서는 큰 위·경도 이동이 바다 유닛을 육지 깊숙이
  // 밀어 넣는다. 기존 배치 주변에서만 진입 방향을 바꿔 수역/육지 보정을 보장한다.
  const lon = Number(spawn.lon) + direction * spanLon * 0.018 + wave * spanLon * 0.0035;
  const lat = Number(spawn.lat) - direction * spanLat * 0.015 + wave * spanLat * 0.0028;
  return [
    clamp(lon, bounds.west + spanLon * 0.04, bounds.east - spanLon * 0.04),
    clamp(lat, bounds.south + spanLat * 0.04, bounds.north - spanLat * 0.04)
  ];
}

function reinforcementPriority(counterType) {
  if (counterType === "fighter" || counterType === "bomber") {
    return ["tel", "airThreat", "enemyMarine", "enemyUsv", "fastBoat"];
  }
  if (counterType === "destroyer" || counterType === "carrier") {
    return ["fastBoat", "enemyUsv", "airThreat", "tel", "enemyMarine"];
  }
  if (counterType === "marine") return ["enemyMarine", "tel", "fastBoat", "airThreat"];
  return ["fastBoat", "enemyUsv", "airThreat", "enemyMarine", "tel", "mine"];
}

function applyAdaptiveDifficulty(config, scenarioId, context) {
  const tier = context.difficulty;
  const profile = DIFFICULTY_PROFILES[tier - 1];
  const scenarioMap = config.scenarioMap;
  const cap = REINFORCEMENT_CAPS[scenarioId] || 2;
  const desiredReinforcements = Math.min(
    cap,
    profile.reinforcements + (context.repeatCount >= 2 ? 1 : 0)
  );
  let reinforcementCount = 0;

  if (scenarioId === "mine_corridor") {
    config.battle.objectiveTargetType = "mine";
  }

  if (tier >= 3 && scenarioId === "convoy_shield" && config.unitTypes.usv) {
    config.unitTypes.enemyUsv = createEnemyUsvDefinition(config.unitTypes.usv);
    config.spawns.push({
      id: `adaptive-convoy-usv-${context.variant + 1}`,
      team: "enemy",
      type: "enemyUsv",
      callsign: "무인수상정 증원",
      lon: 56.18,
      lat: 26.56,
      forceCount: 1,
      hero: false,
      strategicLod: true,
      instancedLod: true,
      aiIndex: 90,
      fireStagger: 0.21
    });
    reinforcementCount++;
  }

  if (tier >= 4 && scenarioId === "missile_screen" && config.unitTypes.fastBoat) {
    config.spawns.push({
      id: `adaptive-screen-fastboat-${context.variant + 1}`,
      team: "enemy",
      type: "fastBoat",
      callsign: "해상 침투조",
      lon: 52.25,
      lat: 25.72,
      forceCount: 1,
      hero: false,
      strategicLod: true,
      instancedLod: true,
      aiIndex: 91,
      fireStagger: 0.18
    });
    reinforcementCount++;
  }

  /* 기뢰 회랑의 위협은 기뢰가 아니라 엄호정이다.
   *
   * 기뢰는 반격하지 않으므로 증원으로 기뢰를 늘리면 치울 것만 늘고 판이
   * 어려워지지는 않는다. 실제로 난이도 1·3 이 100% 였다. 난이도에 따라
   * 엄호정을 늘려야 소해 전력이 위협받는다. */
  if (tier >= 2 && scenarioId === "mine_corridor" && config.unitTypes.fastBoat) {
    const escorts = Math.max(1, tier - 1);
    for (let index = 0; index < escorts; index++) {
      config.spawns.push({
        id: `adaptive-mine-fastboat-${context.variant + 1}-${index + 1}`,
        team: "enemy",
        type: "fastBoat",
        callsign: `기뢰부설 엄호정 ${index + 1}`,
        lon: 58.05 - index * 0.34,
        lat: 25.68 + (index % 2) * 0.16,
        forceCount: 1,
        hero: false,
        strategicLod: true,
        instancedLod: true,
        objectiveTarget: false,
        aiIndex: 92 + index,
        fireStagger: 0.24 + index * 0.09
      });
      reinforcementCount++;
    }
  }

  const objectiveType = config.battle.objectiveTargetType;
  const priorities = reinforcementPriority(context.counterType);
  const candidates = config.spawns
    .filter((spawn) => (
      spawn.team === "enemy"
      && !spawn.objectiveTarget
      && (!objectiveType || spawn.type !== objectiveType)
      && spawn.type !== "mine"
    ))
    .sort((a, b) => {
      const aPriority = priorities.indexOf(a.type);
      const bPriority = priorities.indexOf(b.type);
      return (aPriority < 0 ? 99 : aPriority) - (bPriority < 0 ? 99 : bPriority);
    });
  const fallbackCandidates = config.spawns.filter((spawn) => (
    spawn.team === "enemy" && !spawn.objectiveTarget
  ));
  const sources = candidates.length ? candidates : fallbackCandidates;

  while (reinforcementCount < desiredReinforcements && sources.length) {
    const source = sources[reinforcementCount % sources.length];
    const definition = config.unitTypes[source.type];
    config.spawns.push({
      ...source,
      id: `adaptive-${scenarioId}-${source.type}-${reinforcementCount + 1}`,
      callsign: `${source.callsign || source.type} 증원 ${reinforcementCount + 1}`,
      callsignIndex: 80 + reinforcementCount,
      lon: source.lon,
      lat: source.lat,
      forceCount: 1,
      /* ★ strategicLod 는 "저해상도 모델"이 아니라 "모델 대신 임시 도형"이다.
       *
       *   const useHero = spawn.hero && selectedModelSource && !spawn.strategicLod;
       *   const model = useHero ? <실제 GLB> : this.createFallbackModel(...)
       *
       * 삼각형 예산을 맞추려고 증원을 전부 hero:false + strategicLod:true 로
       * 바꾼 적이 있는데, 그러자 Meshy 로 만든 실제 모델이 있는 유닛까지
       * 네모난 임시 도형으로 나왔다(포대 경비 분대). 삼각형은 증원 수로 줄인다. */
      hero: definition?.domain === "land",
      strategicLod: definition?.domain !== "land",
      instancedLod: definition?.domain !== "land",
      objectiveTarget: false,
      aiIndex: 80 + reinforcementCount,
      fireStagger: (reinforcementCount % 4) * 0.12
    });
    reinforcementCount++;
  }

  /* 탄약이 정해진 임무에서는 목표의 체력을 난이도로 올리지 않는다.
   *
   * 곡괭이산은 B-2 의 GBU-57 2발로 지하 진입부 2곳을 뚫는 임무다. 한 곳에 한 발이
   * 정확히 배정돼 있다. 그런데 난이도가 오르면 진입부 체력이 1.16~1.34배가 되어
   * 한 발로 안 부서졌고, 남은 탄이 남은 목표보다 적어지는 순간 승리 불가 판정이
   * 걸려 **전투 시작 4초 만에 패배 화면**이 떴다. 산술적으로 이길 수 없는 판이
   * 난이도 3 이상에서 계속 나가고 있었다.
   * 난이도는 호위 전력과 방공으로 올린다. 목표를 못 부수게 만드는 것이 아니라. */
  /* 밸런스를 재기 위한 손잡이.
   *
   * 자동전투 승률을 목표치에 맞추려면 적 강도를 바꿔가며 여러 번 재야 하는데,
   * 값을 하나 바꿀 때마다 번들을 다시 만들면 한 번 재는 데만 한 시간이 든다.
   * 그래서 주소에 붙여 바로 바꿀 수 있게 한다. 기본값 1 이면 아무 영향이 없다.
   *   ?enemyHp=1.6&enemyDamage=1.4&enemyExtra=2
   */
  const qa = new URLSearchParams(location.search);
  const qaNumber = (key, fallback, min, max) => {
    const raw = Number(qa.get(key));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : fallback;
  };
  const hpScale = qaNumber("enemyHp", 1, 0.2, 6);
  const damageScale = qaNumber("enemyDamage", 1, 0.2, 6);

  const ammoLimited = Boolean(
    config.battle.requiredFleetType
    && config.battle.objectiveTargetType
    && Number.isFinite(config.unitTypes[config.battle.requiredFleetType]?.maxShots)
  );
  config.spawns = config.spawns.map((spawn, index) => {
    if (spawn.team !== "enemy") return spawn;
    const [lon, lat] = shiftedCoordinate(spawn, scenarioMap, context.variant, index);
    const forceCount = spawn.forceCount || 1;
    const baseStrength = spawn.strengthScale ?? (0.65 + forceCount * 0.35);
    const baseDamage = spawn.damageMultiplier ?? (0.72 + forceCount * 0.28);
    const isFixedTarget = ammoLimited && spawn.type === config.battle.objectiveTargetType;
    return {
      ...spawn,
      lon,
      lat,
      strengthScale: Number(
        (baseStrength * (isFixedTarget ? 1 : profile.hp) * (isFixedTarget ? 1 : hpScale))
          .toFixed(3)
      ),
      damageMultiplier: Number((baseDamage * profile.damage * damageScale).toFixed(3)),
      fireStagger: (spawn.fireStagger || 0) * Math.max(0.62, 1 - (tier - 1) * 0.09)
    };
  });

  /* 적은 전투가 시작되는 순간부터 움직인다.
   *
   * 예전에는 시나리오마다 18~45초를 기다렸다가 교전을 시작했다. 편성을 짜고
   * 들어온 플레이어에게는 그 시간이 그냥 빈 화면이었다. 하한 8초도 같은 이유로
   * 없앤다. 남겨두면 지연을 0으로 내려도 난이도 계산에서 8초가 되살아난다.
   */
  config.battle.enemyEngageDelaySeconds = Math.max(
    0,
    (config.battle.enemyEngageDelaySeconds || 0) - profile.delay
  );
  if (!config.battle.objectiveTargetType) {
    config.battle.objectiveEnemyCount = config.spawns
      .filter((spawn) => spawn.team === "enemy")
      .reduce((sum, spawn) => sum + (spawn.forceCount || 1), 0);
  }
  config.battle.adaptiveProfile = {
    ...context,
    hpPercent: Math.round(profile.hp * 100),
    damagePercent: Math.round(profile.damage * 100),
    reinforcements: reinforcementCount
  };
}

class RtsCombat {
  constructor(config, coastline, geo, audioConfig) {
    this.config = config;
    this.coastline = coastline;
    this.audioConfig = audioConfig;
    this.params = new URLSearchParams(location.search);
    this.lang = this.params.get("lang") === "en" ? "en" : "ko";
    this.embedded = this.params.get("embedded") === "1";
    this.campaignMode = this.params.get("campaign") || "standalone";
    this.scenarioId = this.params.get("scenario") || "convoy_shield";
    this.battleContext = readBattleContext(this.params);
    this.googleBattleRequested = this.params.get("google") !== "0";
    applyScenarioProfile(config, this.scenarioId);
    applyAdaptiveDifficulty(config, this.scenarioId, this.battleContext);
    this.scenarioMap = config.scenarioMap;
    this.geo = {
      ...geo,
      bounds: { ...this.scenarioMap.bounds },
      projection: { ...this.scenarioMap.projection }
    };
    this.activeCoastPolygons = this.coastline.polygons
      .filter((polygon) => polygonIntersectsBounds(polygon, this.geo.bounds))
      .map((polygon) => {
        const bounds = polygon.outer.reduce((result, point) => ({
          west: Math.min(result.west, point[0]),
          east: Math.max(result.east, point[0]),
          south: Math.min(result.south, point[1]),
          north: Math.max(result.north, point[1])
        }), {
          west: Infinity,
          east: -Infinity,
          south: Infinity,
          north: -Infinity
        });
        return { polygon, bounds };
      });
    this.strings = config.strings[this.lang];
    this.returnPath = this.params.get("return") || "index.html?autostart=1&prologue=complete";
    if (this.params.has("budget")) {
      config.fleetSelection.budget = clamp(
        Math.round(Number(this.params.get("budget")) || 0),
        0,
        7500
      );
    }
    this.initialMissionBudget = config.fleetSelection.budget;
    this.supplementalBudget = 0;
    this.budgetResolved = false;
    this.congressActionsUsed = new Set();
    this.politics = {
      congressSupport: clamp(Number(this.params.get("congress")) || 39, 0, 100),
      partySupport: clamp(Number(this.params.get("party")) || 58, 0, 100),
      approval: clamp(Number(this.params.get("approval")) || 44, 0, 100),
      approvalDelta: 0,
      intlDelta: 0,
      forcedAppropriation: false
    };
    this.congressBaseline = {
      congressSupport: this.politics.congressSupport,
      partySupport: this.politics.partySupport,
      approvalDelta: this.politics.approvalDelta,
      intlDelta: this.politics.intlDelta
    };
    this.canvas = document.getElementById("rts-canvas");
    this.groundShadowsRoot = document.getElementById("ground-shadows");
    this.labelsRoot = document.getElementById("world-labels");
    this.selectionBox = document.getElementById("selection-box");
    this.radar = document.getElementById("radar-canvas");
    this.radarContext = this.radar.getContext("2d");
    this.models = {};
    this.formationModels = {};
    this.strategicModels = {};
    this.strategicDetailModels = {};
    this.strategicDetailTextures = {};
    this.animationClips = {};
    this.referenceAnimations = {};
    this.weaponModels = {};
    this.environmentTextures = {};
    this.units = [];
    this.instancedLodBatches = [];
    this.marineLodBatches = [];
    this.marineWeaponBatches = [];
    this.projectiles = [];
    this.orderMarkers = [];
    this.selected = new Set();
    this.inspectedEnemies = new Set();
    this.fighterShooters = new Set();
    this.missileLaunchDots = [];
    this.missileTargetLaunchDots = [];
    this.guidanceTurnSamples = [];
    this.guidedLaunches = 0;
    this.guidedHits = 0;
    this.guidedMisses = 0;
    this.guidedAborts = 0;
    this.guidedEvades = 0;
    this.lastMissileWarningAt = -Infinity;
    this.rescueStage = this.scenarioId === "tanker_rescue" ? "intercept" : "inactive";
    this.rescueProgress = 0;
    this.rescueTarget = null;
    this.rescueMarker = null;
    this.rescueStageNotices = new Set();
    this.navigationStats = {
      correctedSeaSpawns: 0,
      adjustedSeaCommands: 0,
      coastContacts: 0,
      avoidanceTurns: 0,
      blockedMoves: 0,
      unitCollisionBlocks: 0,
      unitCollisionResolutions: 0
    };
    this.projectileAxisMinimumDot = 1;
    this.straightFlightMinimumDot = 1;
    this.projectileVisualForward = new THREE.Vector3();
    this.projectileDisplacement = new THREE.Vector3();
    this.projectileNextPosition = new THREE.Vector3();
    this.forceListSignature = "";
    this.commandGroups = new Map();
    this.commandMode = null;
    this.autoBattleEnabled = false;
    this.autoBattleDecisionCount = 0;
    this.autoBattleTargetAssignments = 0;
    this.autoBattleEvades = 0;
    this.autoAirAttackRuns = {
      started: 0,
      ingressLegs: 0,
      releases: 0,
      egressLegs: 0,
      reentries: 0,
      abortedPasses: 0,
      stalledRecoveries: 0,
      helicopterStandoffActions: 0
    };
    this.pointerDown = null;
    this.draggingSelection = false;
    this.cameraDrag = null;
    this.cameraPanStats = {
      count: 0,
      distance: 0,
      input: "none"
    };
    this.keys = new Set();
    this.started = false;
    this.paused = false;
    this.ended = false;
    this.battleSuccess = null;
    this.resultPending = false;
    this.resultRevealTimer = null;
    this.postBattleElapsed = 0;
    this.resultRevealReady = false;
    this.elapsed = 0;
    this.remaining = config.battle.durationSeconds;
    this.timeScale = clamp(Number(this.params.get("speed")) || 1, 0.25, 8);
    this.lastFrame = performance.now();
    this.frameRateSamples = [];
    this.lastHudAt = 0;
    this.lastRadarAt = 0;
    this.lastLabelsAt = 0;
    this.lastMovementAudioAt = 0;
    this.shownMissionCues = new Set();
    this.missionCueTimer = null;
    this.lastCommand = "ready";
    this.shots = { ally: 0, enemy: 0 };
    this.hits = { ally: 0, enemy: 0 };
    this.weaponShots = {};
    this.weaponHits = {};
    this.destroyedEnemies = 0;
    this.initialized = false;
    this.audioContext = null;
    this.cameraFocus = new THREE.Vector3();
    this.cameraFrameScale = 1;
    this.cameraTilt = 1;
    this.cameraHeight = config.battle.camera.height;
    this.cameraDistance = config.battle.camera.distance;
    this.cameraWheelZoomInLimit = 0.5;
    this.cameraShake = 0;
    this.cameraShakePhase = 0;
    this.fleetSelection = Object.fromEntries(
      Object.entries(config.fleetSelection.options).map(([type, option]) => [type, option.default])
    );
    this.fitFleetSelectionToBudget();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2();
    this.dom = this.collectDom();
    this.googleBattleMapActive = false;
    this.localEnvironmentAdded = false;
    this.googleBattleMap = new RtsGoogleBattleMap({
      shell: this.dom.shell,
      host: document.getElementById("rts-google-map-host"),
      badge: document.getElementById("terrain-provider"),
      scenario: this.scenarioMap,
      unproject: (position) => this.unproject(position),
      enabled: this.googleBattleRequested,
      language: this.lang,
      onFallback: () => this.enableLocalTerrainFallback()
    });
  }

  collectDom() {
    return {
      shell: document.getElementById("rts-game"),
      header: document.querySelector(".battle-header"),
      terrainBadge: document.getElementById("terrain-provider"),
      forcePanel: document.querySelector(".force-panel"),
      intelPanel: document.querySelector(".intel-panel"),
      selectionPanel: document.querySelector(".selection-panel"),
      commandBar: document.querySelector(".command-bar"),
      loading: document.getElementById("loading-layer"),
      briefing: document.getElementById("briefing-layer"),
      result: document.getElementById("result-layer"),
      resultCard: document.querySelector(".result-card"),
      resultImage: document.getElementById("result-image"),
      missionCue: document.getElementById("mission-cue"),
      missionCueImage: document.getElementById("mission-cue-image"),
      missionCueKicker: document.getElementById("mission-cue-kicker"),
      missionCueTitle: document.getElementById("mission-cue-title"),
      fatal: document.getElementById("fatal-error"),
      battleTitle: document.getElementById("battle-title"),
      objective: document.getElementById("objective-text"),
      objectiveFill: document.getElementById("objective-fill"),
      status: document.getElementById("battle-status"),
      time: document.getElementById("battle-time"),
      allyLabel: document.getElementById("ally-label"),
      enemyLabel: document.getElementById("enemy-label"),
      civilianLabel: document.getElementById("civilian-label"),
      allyCount: document.getElementById("ally-count"),
      enemyCount: document.getElementById("enemy-count"),
      civilianCount: document.getElementById("civilian-count"),
      allyList: document.getElementById("ally-list"),
      enemySummary: document.getElementById("enemy-summary"),
      selectionLabel: document.getElementById("selected-label"),
      selectionSummary: document.getElementById("selection-summary"),
      log: document.getElementById("battle-log"),
      hint: document.getElementById("command-hint"),
      autoBattle: document.querySelector("[data-command='autoBattle']"),
      fleetBuilder: document.querySelector(".fleet-builder"),
      fleetBudgetUsed: document.getElementById("fleet-budget-used"),
      fleetBudgetCap: document.getElementById("fleet-budget-cap"),
      fleetMessage: document.getElementById("fleet-message"),
      budgetPoliticsStatus: document.getElementById("budget-politics-status"),
      requestCongressBudget: document.getElementById("request-congress-budget"),
      congressLayer: document.getElementById("congress-layer"),
      congressCard: document.getElementById("congress-card"),
      briefFriendlyForce: document.getElementById("brief-friendly-force"),
      start: document.getElementById("start-battle"),
      retry: document.getElementById("retry-battle"),
      resultContinue: document.getElementById("result-continue"),
      battleScaleSwitch: document.getElementById("battle-scale-switch"),
      battleScaleBadge: document.getElementById("battle-scale-badge"),
      standardBattleLink: document.getElementById("standard-battle-link"),
      largeBattleLink: document.getElementById("large-battle-link"),
      resultStatus: document.getElementById("result-status"),
      resultTitle: document.getElementById("result-title"),
      resultText: document.getElementById("result-text"),
      resultEnemy: document.getElementById("result-enemy"),
      resultCivilian: document.getElementById("result-civilian"),
      resultAlly: document.getElementById("result-ally")
    };
  }

  text(key) {
    return this.strings[key] ?? key;
  }

  /** 유닛 정의 이름을 현재 언어로. 영어일 때 nameEn 이 있으면 그것을 쓴다. */
  unitDisplayName(definition) {
    return (this.lang === "en" && definition.nameEn) || definition.name;
  }

  formatBudget(value) {
    return `$${Math.max(0, Math.round(Number(value) || 0))}M`;
  }

  /**
   * 교전 시작 안내 한 줄.
   *
   * 예전에는 문구에 초가 박혀 있었다("적이 45초 뒤 접근합니다"). 그런데
   * applyAdaptiveDifficulty() 가 난이도에 따라 그 시간을 최대 12초 줄이고,
   * 기뢰 회랑은 아예 0으로 만든다. 결과적으로 화면이 말하는 초와 실제로
   * 적이 오는 초가 달랐다. 특히 기뢰 회랑은 오지도 않을 적을 45초 기다리라고
   * 안내했다. 그래서 이제 실제 값을 그 자리에 넣고, 0이면 다른 문장을 쓴다.
   */
  contactCountdownLine() {
    const seconds = Math.max(0, Math.round(this.config.battle.enemyEngageDelaySeconds || 0));
    if (seconds <= 0) return this.text("contactCountdownNow");
    const label = this.lang === "en" ? `${seconds} seconds` : `${seconds}초`;
    return this.text("contactCountdown").replace("{delay}", label);
  }

  getFleetTextKeys(type) {
    return {
      destroyer: {
        name: "fleetDestroyer", summary: "fleetSummaryDestroyer",
        callsign: "destroyerCallsign", unit: "shipUnit"
      },
      fighter: {
        name: "fleetFighter", summary: "fleetSummaryFighter",
        callsign: "fighterCallsign", unit: "aircraftUnit"
      },
      helicopter: {
        name: "fleetHelicopter", summary: "fleetSummaryHelicopter",
        callsign: "helicopterCallsign", unit: "aircraftUnit"
      },
      carrier: {
        name: "fleetCarrier", summary: "fleetSummaryCarrier",
        callsign: "carrierCallsign", unit: "shipUnit"
      },
      usv: {
        name: "fleetUsv", summary: "fleetSummaryUsv",
        callsign: "usvCallsign", unit: "shipUnit"
      },
      bomber: {
        name: "fleetBomber", summary: "fleetSummaryBomber",
        callsign: "bomberCallsign", unit: "aircraftUnit"
      },
      marine: {
        name: "fleetMarine", summary: "fleetSummaryMarine",
        callsign: "marineCallsign", unit: "personUnit"
      }
    }[type] || {
      name: `fleet${type[0].toUpperCase()}${type.slice(1)}`,
      summary: `fleetSummary${type[0].toUpperCase()}${type.slice(1)}`,
      callsign: `${type}Callsign`,
      unit: ""
    };
  }

  fitFleetSelectionToBudget() {
    const priority = [
      "marine", "usv", "helicopter", "fighter",
      "bomber", "destroyer", "carrier"
    ];
    let guard = 120;
    while (this.getFleetBudgetUsed() > this.config.fleetSelection.budget && guard-- > 0) {
      const type = priority.find((candidate) => (
        this.fleetSelection[candidate] > this.config.fleetSelection.options[candidate].minimum
      ));
      if (!type) break;
      this.fleetSelection[type] -= 1;
    }
  }

  project(lon, lat, y = 0) {
    const { bounds, projection } = this.geo;
    return new THREE.Vector3(
      ((lon - projection.centerLon) / (bounds.east - bounds.west)) * projection.worldWidth,
      y,
      -((lat - projection.centerLat) / (bounds.north - bounds.south)) * projection.worldDepth
    );
  }

  unproject(position) {
    const { bounds, projection } = this.geo;
    return [
      projection.centerLon + (position.x / projection.worldWidth) * (bounds.east - bounds.west),
      projection.centerLat - (position.z / projection.worldDepth) * (bounds.north - bounds.south)
    ];
  }

  routePoint(coords, t) {
    const normalized = clamp(t, 0, 1);
    const scaled = normalized * (coords.length - 1);
    const index = Math.floor(scaled);
    const nextIndex = Math.min(coords.length - 1, index + 1);
    const alpha = scaled - index;
    const a = this.project(...coords[index]);
    const b = this.project(...coords[nextIndex]);
    return a.lerp(b, alpha);
  }

  isLandCoordinate(lon, lat) {
    if (this.scenarioMap.surface === "land") {
      return lon >= this.geo.bounds.west
        && lon <= this.geo.bounds.east
        && lat >= this.geo.bounds.south
        && lat <= this.geo.bounds.north;
    }
    return this.activeCoastPolygons.some(({ polygon, bounds }) => (
      lon >= bounds.west
      && lon <= bounds.east
      && lat >= bounds.south
      && lat <= bounds.north
      && pointInCoastPolygon([lon, lat], polygon)
    ));
  }

  isWorldLand(position, clearance = 0) {
    const [lon, lat] = this.unproject(position);
    if (this.isLandCoordinate(lon, lat)) return true;
    if (clearance <= 0) return false;
    for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * Math.PI * 2;
      const sample = new THREE.Vector3(
        position.x + Math.cos(angle) * clearance,
        0,
        position.z + Math.sin(angle) * clearance
      );
      const [sampleLon, sampleLat] = this.unproject(sample);
      if (this.isLandCoordinate(sampleLon, sampleLat)) return true;
    }
    return false;
  }

  isWorldLandInterior(position, clearance = 0) {
    if (!this.isWorldLand(position, 0)) return false;
    if (clearance <= 0) return true;
    for (let index = 0; index < 16; index += 1) {
      const angle = index / 16 * Math.PI * 2;
      const sample = new THREE.Vector3(
        position.x + Math.cos(angle) * clearance,
        0,
        position.z + Math.sin(angle) * clearance
      );
      if (!this.isWorldLand(sample, 0)) return false;
    }
    return true;
  }

  resolveLandCoordinate(lon, lat, clearance = 0) {
    const isInterior = (candidate) => (
      this.isLandCoordinate(candidate[0], candidate[1])
      && (
        clearance <= 0
        || this.isWorldLandInterior(this.project(candidate[0], candidate[1]), clearance)
      )
    );
    if (isInterior([lon, lat])) return [lon, lat];
    for (let radius = 0.02; radius <= 0.6; radius += 0.02) {
      for (let step = 0; step < 24; step++) {
        const angle = (step / 24) * Math.PI * 2;
        const candidate = [
          lon + Math.cos(angle) * radius,
          lat + Math.sin(angle) * radius
        ];
        if (
          candidate[0] < this.geo.bounds.west
          || candidate[0] > this.geo.bounds.east
          || candidate[1] < this.geo.bounds.south
          || candidate[1] > this.geo.bounds.north
        ) continue;
        if (isInterior(candidate)) return candidate;
      }
    }
    throw new Error(`육상 유닛 배치 좌표를 찾을 수 없습니다: ${lon}, ${lat}`);
  }

  resolveWaterCoordinate(lon, lat, clearance = 0) {
    const origin = this.project(lon, lat);
    if (!this.isWorldLand(origin, clearance)) return [lon, lat];
    for (let radius = 0.25; radius <= 12; radius += 0.25) {
      for (let step = 0; step < 32; step += 1) {
        const angle = step / 32 * Math.PI * 2;
        const candidate = origin.clone().add(new THREE.Vector3(
          Math.cos(angle) * radius,
          0,
          Math.sin(angle) * radius
        ));
        const coordinate = this.unproject(candidate);
        if (
          coordinate[0] < this.geo.bounds.west
          || coordinate[0] > this.geo.bounds.east
          || coordinate[1] < this.geo.bounds.south
          || coordinate[1] > this.geo.bounds.north
        ) continue;
        if (!this.isWorldLand(candidate, clearance)) return coordinate;
      }
    }
    throw new Error(`해상 유닛 배치 좌표를 찾을 수 없습니다: ${lon}, ${lat}`);
  }

  getSeaClearance(unit) {
    const definition = unit.definition || unit;
    const navigationBeam = definition.beam || definition.desiredSize * 0.18;
    return clamp(
      navigationBeam * 0.58,
      0.22,
      1.45
    );
  }

  segmentTouchesLand(start, end, clearance = 0) {
    const distance = planarDistance(start, end);
    const samples = clamp(Math.ceil(distance / 0.18), 1, 96);
    for (let index = 1; index <= samples; index += 1) {
      const sample = start.clone().lerp(end, index / samples);
      if (this.isWorldLand(sample, clearance)) return true;
    }
    return false;
  }

  resolveSeaCommandTarget(unit, target) {
    const clearance = this.getSeaClearance(unit);
    if (!this.isWorldLand(target, clearance)) return target.clone();
    const start = unit.position.clone().setY(0);
    let lastWater = start.clone();
    let firstLand = target.clone().setY(0);
    const distance = planarDistance(start, firstLand);
    const samples = clamp(Math.ceil(distance / 0.35), 12, 160);
    for (let index = 1; index <= samples; index += 1) {
      const sample = start.clone().lerp(firstLand, index / samples);
      if (this.isWorldLand(sample, clearance)) {
        firstLand.copy(sample);
        break;
      }
      lastWater.copy(sample);
    }
    for (let index = 0; index < 14; index += 1) {
      const middle = lastWater.clone().lerp(firstLand, 0.5);
      if (this.isWorldLand(middle, clearance)) firstLand.copy(middle);
      else lastWater.copy(middle);
    }
    const retreat = start.clone().sub(lastWater).setY(0);
    if (retreat.lengthSq() > 0.0001) {
      lastWater.addScaledVector(retreat.normalize(), Math.min(0.45, distance * 0.08));
    }
    lastWater.y = unit.definition.altitude;
    this.navigationStats.adjustedSeaCommands += 1;
    return lastWater;
  }

  resolveLandCommandTarget(unit, target) {
    const [lon, lat] = this.unproject(target);
    try {
      const [resolvedLon, resolvedLat] = this.resolveLandCoordinate(
        lon,
        lat,
        unit.groundClearance || 0
      );
      return this.project(resolvedLon, resolvedLat, unit.placementAltitude);
    } catch {
      return unit.position.clone();
    }
  }

  getSeaSteeringDirection(unit, desiredDirection, target, delta) {
    const strategicFastBoat = (
      this.config.battle.scale === "large"
      && unit.type === "fastBoat"
    );
    if (
      strategicFastBoat
      && unit.cachedSeaSteering
      && this.elapsed < (unit.nextSeaSteerAt || 0)
    ) {
      return unit.cachedSeaSteering;
    }
    const remember = (direction) => {
      if (strategicFastBoat) {
        if (!unit.cachedSeaSteering) unit.cachedSeaSteering = new THREE.Vector3();
        unit.cachedSeaSteering.copy(direction);
        unit.nextSeaSteerAt = this.elapsed + 0.16 + (unit.aiIndex % 5) * 0.018;
        return unit.cachedSeaSteering;
      }
      return direction;
    };
    const clearance = this.getSeaClearance(unit);
    const probeDistance = Math.max(
      clearance * 2.6,
      unit.definition.desiredSize * 0.28,
      unit.currentSpeed * Math.max(delta, 0.05) * 3,
      1.15
    );
    const directEnd = unit.position.clone().addScaledVector(desiredDirection, probeDistance);
    if (!this.segmentTouchesLand(unit.position, directEnd, clearance)) {
      unit.coastClearFrames = (unit.coastClearFrames || 0) + 1;
      if (unit.coastClearFrames >= 10) unit.coastAvoidanceSide = 0;
      unit.coastContactActive = false;
      return remember(desiredDirection);
    }

    unit.coastClearFrames = 0;
    if (!unit.coastContactActive) {
      unit.coastContactActive = true;
      this.navigationStats.coastContacts += 1;
    }
    const preferredSide = unit.coastAvoidanceSide || (unit.aiIndex % 2 === 0 ? 1 : -1);
    const sides = unit.coastAvoidanceSide
      ? [unit.coastAvoidanceSide, -unit.coastAvoidanceSide]
      : [preferredSide, -preferredSide];
    const angles = [32, 48, 66, 84, 104, 126, 150, 176];
    let best = null;
    for (const side of sides) {
      for (const angleDegrees of angles) {
        const direction = desiredDirection.clone()
          .applyAxisAngle(WORLD_UP, side * angleDegrees * Math.PI / 180)
          .normalize();
        const end = unit.position.clone().addScaledVector(direction, probeDistance);
        if (this.segmentTouchesLand(unit.position, end, clearance)) continue;
        const remaining = planarDistance(end, target);
        const score = remaining + angleDegrees * 0.012 + (side === preferredSide ? 0 : 0.35);
        if (!best || score < best.score) best = { direction, side, score };
      }
    }
    if (!best) {
      const away = unit.lastWaterPosition
        ? unit.lastWaterPosition.clone().sub(unit.position).setY(0)
        : desiredDirection.clone().multiplyScalar(-1);
      if (away.lengthSq() > 0.0001) away.normalize();
      else away.copy(desiredDirection).multiplyScalar(-1);
      return remember(away);
    }
    unit.coastAvoidanceSide = best.side;
    this.navigationStats.avoidanceTurns += 1;
    return remember(best.direction);
  }

  moveUnitSafely(unit, distance) {
    if (distance <= 0) return true;
    const next = unit.position.clone().addScaledVector(unit.forward, distance);
    next.x = clamp(next.x, this.config.battle.bounds.minX, this.config.battle.bounds.maxX);
    next.z = clamp(next.z, this.config.battle.bounds.minZ, this.config.battle.bounds.maxZ);
    const blockingUnit = this.findUnitMovementBlocker(unit, next);
    if (blockingUnit) {
      this.navigationStats.unitCollisionBlocks += 1;
      unit.currentSpeed = moveToward(
        unit.currentSpeed,
        0,
        unit.definition.deceleration * 0.5
      );
      unit.velocity.set(0, 0, 0);
      return false;
    }
    if (
      unit.definition.domain === "sea"
      && this.segmentTouchesLand(unit.position, next, this.getSeaClearance(unit))
    ) {
      this.navigationStats.blockedMoves += 1;
      unit.currentSpeed = moveToward(
        unit.currentSpeed,
        0,
        unit.definition.deceleration * 0.35
      );
      unit.velocity.set(0, 0, 0);
      if (unit.lastWaterPosition && this.isWorldLand(unit.position, 0)) {
        unit.position.copy(unit.lastWaterPosition);
      }
      return false;
    }
    if (
      unit.definition.domain === "land"
      && !this.isWorldLandInterior(next, unit.groundClearance || 0)
    ) {
      unit.currentSpeed = moveToward(
        unit.currentSpeed,
        0,
        unit.definition.deceleration * 0.55
      );
      unit.velocity.set(0, 0, 0);
      if (unit.lastLandPosition) unit.position.copy(unit.lastLandPosition);
      return false;
    }
    unit.position.x = next.x;
    unit.position.z = next.z;
    if (unit.definition.domain === "sea") {
      unit.lastWaterPosition.copy(unit.position).setY(unit.definition.altitude);
    } else if (unit.definition.domain === "land") {
      unit.lastLandPosition.copy(unit.position).setY(unit.placementAltitude);
    }
    return true;
  }

  getUnitCollisionRadius(unit) {
    const definition = unit.definition || unit;
    const strategicScale = unit.instancedLod
      ? definition.strategicDisplayScale || 1
      : 1;
    return Math.max(
      0.22,
      (definition.collisionRadius || definition.desiredSize * 0.5) * strategicScale
    );
  }

  getUnitMinimumSeparation(unit, nearby) {
    if (
      !unit?.alive
      || !nearby?.alive
      || unit === nearby
      || unit.escaped
      || nearby.escaped
      || unit.type === "mine"
      || nearby.type === "mine"
      || unit.definition.domain !== nearby.definition.domain
    ) return 0;
    const combinedRadius = (
      this.getUnitCollisionRadius(unit)
      + this.getUnitCollisionRadius(nearby)
    );
    if (unit.definition.domain === "air") {
      const verticalGap = Math.abs(unit.position.y - nearby.position.y);
      if (verticalGap > Math.max(0.8, combinedRadius * 0.45)) return 0;
      return combinedRadius * 0.72;
    }
    return combinedRadius * (
      unit.definition.domain === "sea" ? 0.94 : 0.84
    );
  }

  findUnitMovementBlocker(unit, next) {
    for (const nearby of this.units) {
      const minimum = this.getUnitMinimumSeparation(unit, nearby);
      if (!minimum) continue;
      const currentDistance = planarDistance(unit.position, nearby.position);
      const nextDistance = planarDistance(next, nearby.position);
      if (
        nextDistance < minimum * 0.98
        && nextDistance + 0.002 < currentDistance
      ) {
        return nearby;
      }
    }
    return null;
  }

  canOccupyCollisionPosition(unit, position) {
    if (
      position.x < this.config.battle.bounds.minX
      || position.x > this.config.battle.bounds.maxX
      || position.z < this.config.battle.bounds.minZ
      || position.z > this.config.battle.bounds.maxZ
    ) return false;
    if (unit.definition.domain === "sea") {
      return !this.isWorldLand(position, this.getSeaClearance(unit));
    }
    if (unit.definition.domain === "land") {
      return this.isWorldLandInterior(position, unit.groundClearance || 0);
    }
    return true;
  }

  nudgeUnitForCollision(unit, direction, distance) {
    if (distance <= 0) return false;
    const next = unit.position.clone().addScaledVector(direction, distance);
    next.y = unit.position.y;
    if (!this.canOccupyCollisionPosition(unit, next)) return false;
    unit.position.x = next.x;
    unit.position.z = next.z;
    if (unit.definition.domain === "sea" && unit.lastWaterPosition) {
      unit.lastWaterPosition.copy(unit.position).setY(unit.definition.altitude);
    } else if (unit.definition.domain === "land" && unit.lastLandPosition) {
      unit.lastLandPosition.copy(unit.position).setY(unit.placementAltitude);
    }
    return true;
  }

  unitCanYieldCollision(unit) {
    return (
      !unit.fixed
      && !unit.escaped
      && !(unit.rescueTarget && !unit.rescued)
    );
  }

  resolveUnitCollisions() {
    const active = this.units.filter((unit) => (
      unit.alive
      && !unit.escaped
      && unit.type !== "mine"
    ));
    for (let firstIndex = 0; firstIndex < active.length; firstIndex += 1) {
      const first = active[firstIndex];
      for (let secondIndex = firstIndex + 1; secondIndex < active.length; secondIndex += 1) {
        const second = active[secondIndex];
        const minimum = this.getUnitMinimumSeparation(first, second);
        if (!minimum) continue;
        const offset = first.position.clone().sub(second.position).setY(0);
        let distance = offset.length();
        const threshold = minimum * 0.98;
        if (distance >= threshold) continue;
        if (distance < 0.001) {
          const side = String(first.id).localeCompare(String(second.id)) <= 0 ? 1 : -1;
          offset.set(side, 0, side * 0.37).normalize();
          distance = 0;
        } else {
          offset.multiplyScalar(1 / distance);
        }
        const penetration = threshold - distance + 0.015;
        const firstCanYield = this.unitCanYieldCollision(first);
        const secondCanYield = this.unitCanYieldCollision(second);
        let resolved = false;
        if (firstCanYield && secondCanYield) {
          const firstMoved = this.nudgeUnitForCollision(first, offset, penetration * 0.5);
          const secondMoved = this.nudgeUnitForCollision(
            second,
            offset.clone().multiplyScalar(-1),
            penetration * 0.5
          );
          resolved = firstMoved || secondMoved;
          if (firstMoved && !secondMoved) {
            this.nudgeUnitForCollision(first, offset, penetration * 0.5);
          } else if (!firstMoved && secondMoved) {
            this.nudgeUnitForCollision(
              second,
              offset.clone().multiplyScalar(-1),
              penetration * 0.5
            );
          }
        } else if (firstCanYield) {
          resolved = this.nudgeUnitForCollision(first, offset, penetration);
        } else if (secondCanYield) {
          resolved = this.nudgeUnitForCollision(
            second,
            offset.clone().multiplyScalar(-1),
            penetration
          );
        }
        if (resolved) this.navigationStats.unitCollisionResolutions += 1;
      }
    }
  }

  getUnitCollisionSnapshot() {
    let activeOverlaps = 0;
    let minimumClearanceRatio = Infinity;
    const overlappingPairs = [];
    for (let firstIndex = 0; firstIndex < this.units.length; firstIndex += 1) {
      const first = this.units[firstIndex];
      for (let secondIndex = firstIndex + 1; secondIndex < this.units.length; secondIndex += 1) {
        const second = this.units[secondIndex];
        const minimum = this.getUnitMinimumSeparation(first, second);
        if (!minimum) continue;
        const distance = planarDistance(first.position, second.position);
        const ratio = distance / minimum;
        minimumClearanceRatio = Math.min(minimumClearanceRatio, ratio);
        if (ratio < 0.92) {
          activeOverlaps += 1;
          if (overlappingPairs.length < 8) {
            overlappingPairs.push(`${first.id}:${second.id}:${ratio.toFixed(2)}`);
          }
        }
      }
    }
    return {
      activeOverlaps,
      minimumClearanceRatio: Number((
        Number.isFinite(minimumClearanceRatio) ? minimumClearanceRatio : 1
      ).toFixed(3)),
      overlappingPairs
    };
  }

  async init() {
    this.setupLocalization();
    this.setupScene();
    const [googleBattleMapActive] = await Promise.all([
      this.googleBattleMap.init(
        this.cameraFocus,
        this.cameraHeight,
        this.cameraDistance,
        this.camera.fov
      ),
      this.loadEnvironmentTextures(),
      this.audioManager.preload()
    ]);
    this.googleBattleMapActive = googleBattleMapActive;
    this.configureTerrainLighting();
    this.addEnvironment();
    await this.loadHeroModels();
    this.bindInput();
    this.updateFleetBuilder();
    this.resize();
    this.updateHud(true);
    this.initialized = true;
    /* 작전 상황 그림을 미리 받아 둔다.
     *
     * 이 그림들은 교전·사격·명중 같은 순간에 처음 불러온다. 한 장이 150~270KB 라
     * 하필 가장 극적인 순간에 화면이 한 번 멈춘다. 편성 화면에 머무는 동안은
     * 어차피 노는 시간이라, 그때 조용히 받아 두면 전투 중에는 이미 손에 있다.
     * 실패해도 무시한다 — 못 받으면 예전처럼 그때 불러올 뿐이다. */
    this.warmMissionCueImages();
    this.dom.shell.dataset.runtimeVersion = RTS_RUNTIME_VERSION;
    this.dom.shell.dataset.mapId = this.scenarioMap.id;
    this.dom.shell.dataset.mapName = this.lang === "en"
      ? this.scenarioMap.nameEn
      : this.scenarioMap.nameKo;
    this.dom.shell.dataset.mapBounds = [
      this.geo.bounds.west,
      this.geo.bounds.south,
      this.geo.bounds.east,
      this.geo.bounds.north
    ].join(",");
    this.dom.loading.classList.add("hidden");
    this.updateCameraPosition(true);
    this.animate();
  }

  /**
   * data-i18n / data-i18n-attr 가 붙은 정적 마크업을 현재 언어로 채운다.
   * 전투 화면은 언어를 중간에 바꾸지 않으므로 초기화 때 한 번만 돈다.
   */
  applyStaticStrings() {
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = this.text(node.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((node) => {
      node.dataset.i18nAttr.split(",").forEach((pair) => {
        const [attribute, key] = pair.split(":").map((part) => part.trim());
        if (attribute && key) node.setAttribute(attribute, this.text(key));
      });
    });
  }

  /**
   * HUD 표시 수준을 정한다. 영상 촬영과 스크린샷을 위한 것이다.
   *
   *   hud=1(기본)  전부 표시
   *   hud=0        계기·패널·명령바를 숨기고 전장과 유닛 이름표만 남긴다
   *   hud=none     이름표까지 지운 완전히 깨끗한 전장
   *
   * 촬영 스크립트는 `window.__HORMUZ_RTS__.setHud(...)` 로 중간에 바꿀 수 있다.
   */
  setHud(mode) {
    const level = mode === "none" ? "none" : (mode === "0" || mode === false ? "off" : "on");
    this.hudMode = level;
    this.dom.shell.dataset.hud = level;
    return level;
  }

  setupLocalization() {
    document.documentElement.lang = this.lang;
    this.setHud(this.params.get("hud"));
    this.applyStaticStrings();
    this.dom.shell.dataset.battleScale = this.config.battle.scale || "standard";
    const adaptive = this.config.battle.adaptiveProfile || {
      difficulty: 1,
      variant: 0,
      reinforcements: 0,
      hpPercent: 100,
      damagePercent: 100,
      counterType: ""
    };
    const tierName = this.text(`difficultyTier${adaptive.difficulty}`);
    const reinforcementText = this.text("reinforcementBrief")
      .replace("{count}", adaptive.reinforcements)
      .replace("{hp}", adaptive.hpPercent)
      .replace("{damage}", adaptive.damagePercent);
    this.dom.shell.dataset.difficultyTier = String(adaptive.difficulty);
    this.dom.shell.dataset.battleVariant = String(adaptive.variant);
    this.dom.shell.dataset.enemyReinforcements = String(adaptive.reinforcements);
    this.dom.shell.dataset.adaptiveCounter = adaptive.counterType || "none";
    document.title = this.text("pageTitle");
    this.dom.battleTitle.textContent = this.text("title");
    document.getElementById("battle-region").textContent = this.text("briefLocation");
    this.dom.objective.textContent = this.text("objective");
    this.dom.allyLabel.textContent = this.text("ally");
    this.dom.enemyLabel.textContent = this.text("enemy");
    this.dom.civilianLabel.textContent = this.text("civilian");
    this.dom.selectionLabel.textContent = this.text("selected");
    document.getElementById("brief-title").textContent = this.text("title");
    document.getElementById("brief-subtitle").textContent = this.text("subtitle");
    document.getElementById("operation-name").textContent = this.text("operationName");
    document.getElementById("brief-location").textContent = this.text("briefLocation");
    document.getElementById("brief-objective-label").textContent = this.text("briefObjectiveLabel");
    document.getElementById("brief-friendly-label").textContent = this.text("briefFriendlyLabel");
    document.getElementById("brief-threat-label").textContent = this.text("briefThreatLabel");
    document.getElementById("brief-protected-label").textContent = this.text("briefProtectedLabel");
    document.getElementById("brief-threat-value").textContent = [
      this.text("briefThreatValue"),
      reinforcementText,
      adaptive.counterType ? this.text("adaptiveBrief") : ""
    ].filter(Boolean).join(" · ");
    document.getElementById("brief-protected-value").textContent = this.text("briefProtectedValue");
    document.getElementById("brief-objective").textContent = this.text("objective");
    document.getElementById("brief-controls").textContent = this.text("briefControls");
    document.getElementById("brief-mobile-controls").textContent = this.text("mobileControls");
    document.getElementById("fact-notice").textContent = this.text("factNotice");
    const briefImage = document.getElementById("brief-image");
    briefImage.src = this.config.battle.briefingImage || MISSION_CUE_IMAGES.briefing;
    document.getElementById("fleet-title").textContent = this.text("fleetTitle");
    document.getElementById("fleet-budget-label").textContent = this.text("fleetBudget");
    document.getElementById("fleet-budget-unit").textContent = this.text("fleetBudgetUnit");
    document.getElementById("fleet-destroyer-name").textContent = this.text("fleetDestroyer");
    document.getElementById("fleet-fighter-name").textContent = this.text("fleetFighter");
    document.getElementById("fleet-helicopter-name").textContent = this.text("fleetHelicopter");
    for (const type of Object.keys(this.config.fleetSelection.options)) {
      const option = this.config.fleetSelection.options[type];
      const keys = this.getFleetTextKeys(type);
      document.querySelector(`[data-fleet-type="${type}"]`).hidden = false;
      document.getElementById(`fleet-${type}-name`).textContent = this.text(keys.name);
      document.getElementById(`fleet-${type}-cost`).textContent = this.formatBudget(option.cost);
      document.querySelector(`[data-fleet-type="${type}"] [data-fleet-step="-1"]`)
        ?.setAttribute("aria-label", `${this.text("fleetDecrease")} · ${this.text(keys.name)}`);
      document.querySelector(`[data-fleet-type="${type}"] [data-fleet-step="1"]`)
        ?.setAttribute("aria-label", `${this.text("fleetIncrease")} · ${this.text(keys.name)}`);
    }
    document.getElementById("loading-text").textContent = this.text("loading");
    document.getElementById("control-title").textContent = this.text("controlTitle");
    document.getElementById("radar-ally-label").textContent = this.text("radarAlly");
    document.getElementById("radar-enemy-label").textContent = this.text("radarEnemy");
    document.getElementById("radar-convoy-label").textContent = this.text("radarConvoy");
    document.getElementById("result-enemy-label").textContent = this.text("resultEnemyLabel");
    document.getElementById("result-civilian-label").textContent = this.text("resultCivilianLabel");
    document.getElementById("result-ally-label").textContent = this.text("resultAllyLabel");
    this.dom.missionCueKicker.textContent = this.text("missionCueKicker");
    briefImage.alt = this.text("cueBriefing");
    this.dom.start.textContent = this.text("start");
    this.dom.retry.textContent = this.text("retryBattle");
    this.dom.standardBattleLink.textContent = this.text("standardBattleMode");
    this.dom.largeBattleLink.textContent = this.text("largeBattleMode");
    const standardUrl = new URL(location.href);
    standardUrl.searchParams.set("scenario", "convoy_shield");
    standardUrl.searchParams.delete("qa");
    standardUrl.searchParams.delete("replay");
    const largeUrl = new URL(location.href);
    largeUrl.searchParams.set("scenario", "large_fleet_battle");
    largeUrl.searchParams.delete("qa");
    largeUrl.searchParams.delete("replay");
    this.dom.standardBattleLink.href = standardUrl.href;
    this.dom.largeBattleLink.href = largeUrl.href;
    this.dom.standardBattleLink.setAttribute(
      "aria-current",
      this.scenarioId === "large_fleet_battle" ? "false" : "page"
    );
    this.dom.largeBattleLink.setAttribute(
      "aria-current",
      this.scenarioId === "large_fleet_battle" ? "page" : "false"
    );
    this.dom.battleScaleSwitch.hidden = this.embedded;
    this.dom.battleScaleBadge.hidden = false;
    this.dom.battleScaleBadge.textContent = [
      this.scenarioId === "large_fleet_battle" ? this.text("largeBattleBadge") : "",
      `${this.text("difficultyLabel")} ${adaptive.difficulty}/5 · ${tierName}`
    ].filter(Boolean).join(" · ");
    this.dom.requestCongressBudget.textContent = this.text("congressBudgetButton");
    document.getElementById("cmd-select-all").textContent = this.text("selectAll");
    document.getElementById("cmd-attack-move").textContent = this.text("attackMove");
    document.getElementById("cmd-hold").textContent = this.text("hold");
    document.getElementById("cmd-stop").textContent = this.text("stop");
    document.getElementById("cmd-retreat").textContent = this.text("retreat");
    document.getElementById("cmd-pause").textContent = this.text("pause");
    document.getElementById("cmd-auto-battle").textContent = this.text("autoBattle");
    this.updateAutoBattleButton();
    this.dom.status.textContent = this.text("statusReady");
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = null;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.2, 500);
    this.cameraFocus.copy(this.project(
      this.config.battle.camera.centerLon,
      this.config.battle.camera.centerLat,
      0
    ));
    this.updateCameraPosition();
    this.audioManager = new RtsAudioManager(this.camera, this.scene, this.audioConfig);
    this.audioContext = this.audioManager.context;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.shadowMap.enabled = false;

    this.hemisphereLight = new THREE.HemisphereLight(0x83cbd7, 0x120b08, 1.4);
    this.scene.add(this.hemisphereLight);
    this.keyLight = new THREE.DirectionalLight(0xffd0a5, 2.1);
    this.keyLight.position.set(-34, 58, 22);
    this.scene.add(this.keyLight);
    this.rimLight = new THREE.DirectionalLight(0x49dbea, 1.6);
    this.rimLight.position.set(45, 26, -35);
    this.scene.add(this.rimLight);
  }

  configureTerrainLighting() {
    if (!this.googleBattleMapActive) return;
    // Google 위성 지형은 한낮의 중성광으로 촬영되어 있다. 기존 황혼용
    // 청록/주황 조명을 그대로 겹치면 Meshy 회색 선체가 형광색처럼 변한다.
    this.renderer.toneMappingExposure = 0.92;
    this.hemisphereLight.color.setHex(0xdce8ee);
    this.hemisphereLight.groundColor.setHex(0x57534d);
    this.hemisphereLight.intensity = 1.05;
    this.keyLight.color.setHex(0xfff2dd);
    this.keyLight.intensity = 1.28;
    this.keyLight.position.set(-22, 72, 30);
    this.rimLight.color.setHex(0xb8d7e4);
    this.rimLight.intensity = 0.3;
  }

  async loadEnvironmentTextures() {
    const loader = new THREE.TextureLoader();
    await Promise.all(Object.entries(ENVIRONMENT_TEXTURE_URLS).map(async ([key, url]) => {
      const texture = await loader.loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.repeat.set(key === "ocean" ? 5.5 : 3.2, key === "ocean" ? 5.5 : 3.2);
      this.environmentTextures[key] = texture;
    }));
  }

  addEnvironment() {
    if (!this.googleBattleMapActive) this.addLocalTerrainVisuals();
    else if (this.scenarioMap.surface === "land") this.addLand();
    this.addTss();
    this.unitRoot = new THREE.Group();
    this.effectRoot = new THREE.Group();
    this.scene.add(this.unitRoot, this.effectRoot);
    this.fx = new CombatFx(this.effectRoot);
  }

  addLocalTerrainVisuals() {
    if (this.localEnvironmentAdded) return;
    this.localEnvironmentAdded = true;
    const landMission = this.scenarioMap.surface === "land";
    this.scene.background = new THREE.Color(landMission ? 0x9ab0b8 : 0x020910);
    this.scene.fog = new THREE.FogExp2(landMission ? 0xb7a481 : 0x06141b, landMission ? 0.0038 : 0.007);
    if (landMission) {
      this.renderer.toneMappingExposure = 1.08;
      this.hemisphereLight.color.setHex(0xd8e7ea);
      this.hemisphereLight.groundColor.setHex(0x6d563b);
      this.hemisphereLight.intensity = 1.7;
      this.keyLight.color.setHex(0xffe2b3);
      this.keyLight.intensity = 2.35;
      this.rimLight.color.setHex(0xbde9f0);
      this.rimLight.intensity = 0.65;
    }
    this.addSky();
    if (this.scenarioMap.surface !== "land") this.addOcean();
    this.addLand();
    this.addStrategicGrid();
    this.addCityLights();
  }

  enableLocalTerrainFallback() {
    this.googleBattleMapActive = false;
    if (
      this.scene
      && this.environmentTextures.ocean
      && !this.localEnvironmentAdded
    ) {
      this.addLocalTerrainVisuals();
    }
  }

  addSky() {
    const landMission = this.scenarioMap.surface === "land";
    const geometry = new THREE.SphereGeometry(220, 24, 12);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(landMission ? 0x4f7f9a : 0x01070d) },
        midColor: { value: new THREE.Color(landMission ? 0xaac2c8 : 0x09212c) },
        horizonColor: { value: new THREE.Color(landMission ? 0xe6b77d : 0x8c4c29) }
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
        void main() {
          float h = clamp(vWorld.y * .5 + .5, 0.0, 1.0);
          vec3 color = mix(horizonColor, midColor, smoothstep(.44, .58, h));
          color = mix(color, topColor, smoothstep(.58, .96, h));
          float band = exp(-pow((h - .49) * 19.0, 2.0)) * .24;
          gl_FragColor = vec4(color + horizonColor * band, 1.0);
        }
      `
    });
    this.scene.add(new THREE.Mesh(geometry, material));
  }

  addOcean() {
    const geometry = new THREE.PlaneGeometry(220, 210, 48, 48);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        surfaceMap: { value: this.environmentTextures.ocean },
        deepColor: { value: new THREE.Color(0x010b12) },
        midColor: { value: new THREE.Color(0x023349) },
        crestColor: { value: new THREE.Color(0x1683a0) },
        gridColor: { value: new THREE.Color(0x35cfdd) },
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
          vec3 color = mix(deepColor, midColor, .22 + fresnel * .68);
          color = mix(color, surface * vec3(.54, .72, .82), .34 + fresnel * .12);
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
    this.ocean = new THREE.Mesh(geometry, material);
    this.ocean.rotation.x = -Math.PI / 2;
    this.ocean.position.y = -0.12;
    this.scene.add(this.ocean);
  }

  addLand() {
    this.landGroup = new THREE.Group();
    if (this.scenarioMap.surface === "land") {
      const geometry = new THREE.PlaneGeometry(
        this.geo.projection.worldWidth * 1.12,
        this.geo.projection.worldDepth * 1.12,
        64,
        64
      );
      const positions = geometry.getAttribute("position");
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        const baseRelief = (
          Math.sin(x * 0.18) * 0.18
          + Math.cos(y * 0.14) * 0.14
          + Math.sin((x + y) * 0.08) * 0.22
        );
        const northRidge = Math.exp(-((y - 13) ** 2) / 58) * (
          4.2
          + Math.sin(x * 0.16) * 1.15
          + Math.sin(x * 0.37 + 0.8) * 0.72
        );
        const westPeak = Math.exp(
          -(((x + 20) ** 2) / 120 + ((y - 7) ** 2) / 96)
        ) * 3.8;
        const eastPeak = Math.exp(
          -(((x - 22) ** 2) / 145 + ((y - 8) ** 2) / 110)
        ) * 3.25;
        const targetValley = Math.exp(
          -(((x - 1.5) ** 2) / 65 + ((y - 2.8) ** 2) / 42)
        ) * 2.2;
        positions.setZ(
          index,
          Math.max(-0.08, baseRelief + northRidge + westPeak + eastPeak - targetValley)
        );
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color: this.googleBattleMapActive ? 0xf2d8ad : 0xd2b88d,
        map: this.environmentTextures.northLand,
        roughness: 0.9,
        metalness: 0.02,
        emissive: 0x3b2a16,
        emissiveIntensity: 0.12,
        transparent: this.googleBattleMapActive,
        opacity: this.googleBattleMapActive ? 0.58 : 1
      });
      const terrain = new THREE.Mesh(geometry, material);
      terrain.rotation.x = -Math.PI / 2;
      terrain.position.y = -0.08;
      this.landGroup.add(terrain);
      this.scene.add(this.landGroup);
      return;
    }
    const polygons = this.coastline.polygons.filter((polygon) => (
      polygonArea(polygon.outer) > 0.000006
      && polygonIntersectsBounds(polygon, this.geo.bounds)
    ));
    const geometries = { north: [], south: [] };
    const coastPoints = { north: [], south: [] };
    const landMaterials = {
      north: new THREE.MeshStandardMaterial({
        color: 0xa3b6ad,
        map: this.environmentTextures.northLand,
        roughness: 0.83,
        metalness: 0.08,
        emissive: 0x0b4038,
        emissiveIntensity: 0.34
      }),
      south: new THREE.MeshStandardMaterial({
        color: 0xc0aa88,
        map: this.environmentTextures.southLand,
        roughness: 0.83,
        metalness: 0.08,
        emissive: 0x513515,
        emissiveIntensity: 0.34
      })
    };
    for (const polygon of polygons) {
      if (!polygon.outer || polygon.outer.length < 3) continue;
      const clippedOuter = clipRingToBounds(polygon.outer, this.geo.bounds);
      if (clippedOuter.length < 3 || polygonArea(clippedOuter) < 0.000002) continue;
      const shape = new THREE.Shape();
      clippedOuter.forEach(([lon, lat], index) => {
        const point = this.project(lon, lat);
        if (index === 0) shape.moveTo(point.x, -point.z);
        else shape.lineTo(point.x, -point.z);
      });
      for (const ring of polygon.holes || []) {
        const clippedHole = clipRingToBounds(ring, this.geo.bounds);
        if (clippedHole.length < 3 || polygonArea(clippedHole) < 0.000002) continue;
        const hole = new THREE.Path();
        clippedHole.forEach(([lon, lat], index) => {
          const point = this.project(lon, lat);
          if (index === 0) hole.moveTo(point.x, -point.z);
          else hole.lineTo(point.x, -point.z);
        });
        shape.holes.push(hole);
      }
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.9,
        bevelEnabled: true,
        bevelThickness: 0.12,
        bevelSize: 0.1,
        bevelSegments: 1
      });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0.22, 0);
      const averageLat = clippedOuter.reduce((sum, point) => sum + point[1], 0) / clippedOuter.length;
      const north = averageLat > 26.55;
      const region = north ? "north" : "south";
      geometries[region].push(geometry);

      if (clippedOuter.length >= 7 && polygonArea(clippedOuter) > 0.0002) {
        const linePoints = clippedOuter.map(([lon, lat]) => this.project(lon, lat, 1.2));
        for (let index = 0; index < linePoints.length; index++) {
          coastPoints[region].push(linePoints[index], linePoints[(index + 1) % linePoints.length]);
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
            opacity: region === "north" ? 0.42 : 0.35
          })
        ));
      }
    }
    this.scene.add(this.landGroup);
    this.addTerrainRelief(polygons);
  }

  addTerrainRelief(polygons) {
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    const materials = {
      north: new THREE.MeshStandardMaterial({
        color: 0x8ea59a,
        map: this.environmentTextures.northLand,
        roughness: 0.96,
        metalness: 0.02,
        emissive: 0x0a2924,
        emissiveIntensity: 0.32,
        flatShading: true
      }),
      south: new THREE.MeshStandardMaterial({
        color: 0xb69a74,
        map: this.environmentTextures.southLand,
        roughness: 0.96,
        metalness: 0.02,
        emissive: 0x39220f,
        emissiveIntensity: 0.3,
        flatShading: true
      })
    };
    const transforms = { north: [], south: [] };
    const largest = [...polygons]
      .map((polygon) => ({ polygon, area: polygonArea(polygon.outer) }))
      .filter((entry) => entry.area > 0.00004)
      .sort((a, b) => b.area - a.area)
      .slice(0, 18);
    let total = 0;
    for (let polygonIndex = 0; polygonIndex < largest.length && total < 72; polygonIndex++) {
      const { polygon, area } = largest[polygonIndex];
      const lons = polygon.outer.map((point) => point[0]);
      const lats = polygon.outer.map((point) => point[1]);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const desired = clamp(Math.round(area * 1200), 2, 12);
      let placed = 0;
      for (let attempt = 0; attempt < desired * 16 && placed < desired && total < 72; attempt++) {
        const lon = minLon + (maxLon - minLon) * hashNoise(polygonIndex, attempt, 1);
        const lat = minLat + (maxLat - minLat) * hashNoise(polygonIndex, attempt, 2);
        if (
          lon < this.geo.bounds.west
          || lon > this.geo.bounds.east
          || lat < this.geo.bounds.south
          || lat > this.geo.bounds.north
        ) continue;
        if (!pointInCoastPolygon([lon, lat], polygon)) continue;
        const broadness = 0.62 + hashNoise(lon, lat, 4) * 1.18;
        const height = 0.18 + hashNoise(lon, lat, 5) * (lat > 26.5 ? 0.62 : 0.42);
        const point = this.project(lon, lat, 1.02 + height * 0.52);
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          (hashNoise(lon, lat, 7) - 0.5) * 0.18,
          hashNoise(lon, lat, 3) * Math.PI,
          (hashNoise(lon, lat, 8) - 0.5) * 0.16
        ));
        const scale = new THREE.Vector3(
          broadness,
          height,
          broadness * (0.58 + hashNoise(lon, lat, 6) * 0.62)
        );
        matrix.compose(point, quaternion, scale);
        transforms[lat > 26.55 ? "north" : "south"].push(matrix);
        placed++;
        total++;
      }
    }
    this.reliefMeshes = [];
    for (const region of ["north", "south"]) {
      const matrices = transforms[region];
      if (!matrices.length) continue;
      const mesh = new THREE.InstancedMesh(geometry, materials[region], matrices.length);
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      this.reliefMeshes.push(mesh);
      this.scene.add(mesh);
    }
  }

  addTss() {
    this.tssGroup = new THREE.Group();
    const route = this.scenarioMap.route.map((point) => [...point]);
    const offsets = [0, 0.03, -0.03];
    offsets.forEach((offset, index) => {
      const points = route.map(([lon, lat]) => this.project(lon, lat + offset, 0.2));
      const curve = new THREE.CatmullRomCurve3(points);
      const sampled = curve.getPoints(100);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(sampled),
        new THREE.LineDashedMaterial({
          color: index === 0 ? 0x63e6ef : 0x318b96,
          dashSize: index === 0 ? 1.4 : 0.75,
          gapSize: index === 0 ? 0.8 : 0.65,
          transparent: true,
          opacity: index === 0 ? 0.7 : 0.42
        })
      );
      line.computeLineDistances();
      this.tssGroup.add(line);
    });
    this.scene.add(this.tssGroup);
    this.convoyRoute = route;
  }

  addStrategicGrid() {
    const grid = new THREE.GridHelper(170, 34, 0x155766, 0x12313c);
    grid.position.y = 0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    this.scene.add(grid);

    const points = [];
    for (let index = 0; index < 220; index++) {
      points.push((Math.random() - 0.5) * 180, 18 + Math.random() * 90, (Math.random() - 0.5) * 160);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    this.scene.add(new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xa2dce4,
        size: 0.2,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    ));
  }

  addCityLights() {
    const positions = [];
    const colors = [];
    const warm = new THREE.Color(0xffb461);
    const cool = new THREE.Color(0x71dbe4);
    const clusters = this.geo.places.filter((place) => (
      (place.kind === "port" || place.kind === "capital")
      && place.lon >= this.geo.bounds.west
      && place.lon <= this.geo.bounds.east
      && place.lat >= this.geo.bounds.south
      && place.lat <= this.geo.bounds.north
    ));
    for (const place of clusters) {
      const center = this.project(place.lon, place.lat, 1.22);
      const tint = place.country === "IRAN" ? warm : cool;
      for (let index = 0; index < (place.id === "bandar_abbas" ? 42 : 22); index++) {
        const angle = index * 2.399963 + place.lon;
        const radius = 0.18 + Math.sqrt(index) * 0.16;
        positions.push(
          center.x + Math.cos(angle) * radius,
          center.y + 0.03 + (index % 3) * 0.02,
          center.z + Math.sin(angle) * radius * 0.58
        );
        colors.push(tint.r, tint.g, tint.b);
      }
    }
    for (const polygon of this.coastline.polygons) {
      if (!polygonIntersectsBounds(polygon, this.geo.bounds)) continue;
      if (polygonArea(polygon.outer) < 0.00008) continue;
      const stride = Math.max(3, Math.floor(polygon.outer.length / 28));
      for (let index = 0; index < polygon.outer.length; index += stride) {
        const [lon, lat] = polygon.outer[index];
        if (
          lon < this.geo.bounds.west
          || lon > this.geo.bounds.east
          || lat < this.geo.bounds.south
          || lat > this.geo.bounds.north
        ) continue;
        if (hashNoise(lon, lat, index) < 0.48) continue;
        const point = this.project(lon, lat, 1.28);
        const tint = lat > 26.55 ? warm : cool;
        positions.push(
          point.x + (hashNoise(lon, lat, 11) - 0.5) * 0.32,
          point.y,
          point.z + (hashNoise(lon, lat, 12) - 0.5) * 0.32
        );
        colors.push(tint.r, tint.g, tint.b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.28,
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });
    this.cityLights = new THREE.Points(geometry, material);
    this.cityLights.renderOrder = 5;
    this.scene.add(this.cityLights);
  }

  async loadHeroModels() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const heroTypes = Object.entries(this.config.unitTypes)
      .filter(([, definition]) => definition.heroModel && definition.model)
      .map(([type]) => type);
    await Promise.all(heroTypes.map(async (type) => {
      const definition = this.config.unitTypes[type];
      try {
        const gltf = await loader.loadAsync(definition.model);
        this.models[type] = this.normalizeModel(gltf.scene, definition);
        const embeddedClip = gltf.animations?.[0];
        const embeddedKeyframes = embeddedClip
          ? Math.max(0, ...embeddedClip.tracks.map((track) => track.times.length))
          : 0;
        if ((embeddedClip?.duration || 0) > 0.05 && embeddedKeyframes > 1) {
          this.animationClips[type] = {
            ...(this.animationClips[type] || {}),
            idle: embeddedClip
          };
        }
      } catch (error) {
        console.warn(`RTS model fallback: ${type}`, error);
      }
    }));
    if (this.config.battle.scale === "large") {
      const strategicTypes = Object.entries(this.config.unitTypes)
        .filter(([, definition]) => definition.strategicModel)
        .map(([type]) => type);
      await Promise.all(strategicTypes.map(async (type) => {
        const definition = this.config.unitTypes[type];
        try {
          const gltf = await loader.loadAsync(definition.strategicModel);
          this.strategicModels[type] = this.normalizeModel(gltf.scene, definition);
        } catch (error) {
          console.warn(`RTS Meshy strategic model fallback: ${type}`, error);
        }
      }));
      const strategicDetailTypes = Object.entries(this.config.unitTypes)
        .filter(([, definition]) => definition.strategicDetailModel)
        .map(([type]) => type);
      await Promise.all(strategicDetailTypes.map(async (type) => {
        const definition = this.config.unitTypes[type];
        try {
          const gltf = await loader.loadAsync(definition.strategicDetailModel);
          this.strategicDetailModels[type] = this.normalizeModel(
            gltf.scene,
            definition
          );
        } catch (error) {
          console.warn(`RTS textured strategic detail fallback: ${type}`, error);
        }
      }));
    }
    await Promise.all(heroTypes.map(async (type) => {
      const definition = this.config.unitTypes[type];
      if (!definition.formationModel) return;
      try {
        const gltf = await loader.loadAsync(definition.formationModel);
        this.formationModels[type] = this.normalizeModel(gltf.scene, definition);
      } catch (error) {
        console.warn(`RTS formation model fallback: ${type}`, error);
      }
    }));
    await Promise.all(heroTypes.map(async (type) => {
      const definition = this.config.unitTypes[type];
      const animationSources = [
        ["walk", definition.walkAnimation],
        ["combat", definition.combatAnimation]
      ].filter(([, url]) => Boolean(url));
      if (!animationSources.length) return;
      this.animationClips[type] = this.animationClips[type] || {};
      await Promise.all(animationSources.map(async ([name, url]) => {
        try {
          const gltf = await loader.loadAsync(url);
          const clip = gltf.animations?.[0];
          if (clip) this.animationClips[type][name] = clip;
        } catch (error) {
          console.warn(`RTS animation fallback: ${type}:${name}`, error);
        }
      }));
    }));
    await Promise.all(heroTypes.map(async (type) => {
      const definition = this.config.unitTypes[type];
      if (!definition.combatReferenceAnimation) return;
      try {
        const gltf = await loader.loadAsync(definition.combatReferenceAnimation);
        const clipName = definition.combatReferenceClip || "";
        const clip = gltf.animations?.find((item) => item.name === clipName)
          || gltf.animations?.[0];
        if (!clip) return;
        this.referenceAnimations[type] = {
          scene: gltf.scene,
          clip,
          source: definition.combatReferenceSource || "external"
        };
      } catch (error) {
        console.warn(`RTS reference animation fallback: ${type}`, error);
      }
    }));
    await Promise.all(heroTypes.map(async (type) => {
      const definition = this.config.unitTypes[type];
      if (!definition.weaponModel || this.weaponModels[type]) return;
      try {
        const gltf = await loader.loadAsync(definition.weaponModel);
        this.weaponModels[type] = this.normalizeWeaponModel(
          gltf.scene,
          definition.weaponDesiredSize || 0.86
        );
      } catch (error) {
        console.warn(`RTS weapon model fallback: ${type}`, error);
      }
    }));
  }

  createCarrierDeckCorrection(anchor, definition) {
    if (definition.shortName !== "CVN") return;
    anchor.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(anchor);
    const size = box.getSize(new THREE.Vector3());
    const inverseAnchor = new THREE.Matrix4().copy(anchor.matrixWorld).invert();
    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const edgeA = new THREE.Vector3();
    const edgeB = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    const candidates = [];
    const areaByHeight = new Map();
    const heightStep = Math.max(0.035, size.y * 0.012);
    const minDeckSearchY = box.min.y + size.y * 0.14;
    const maxDeckSearchY = box.min.y + size.y * 0.66;

    anchor.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
      const position = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.index;
      const triangleIndexCount = index?.count || position.count;
      const localMatrix = new THREE.Matrix4()
        .multiplyMatrices(inverseAnchor, mesh.matrixWorld);
      for (let offset = 0; offset + 2 < triangleIndexCount; offset += 3) {
        const a = index ? index.getX(offset) : offset;
        const b = index ? index.getX(offset + 1) : offset + 1;
        const c = index ? index.getX(offset + 2) : offset + 2;
        vertexA.fromBufferAttribute(position, a).applyMatrix4(localMatrix);
        vertexB.fromBufferAttribute(position, b).applyMatrix4(localMatrix);
        vertexC.fromBufferAttribute(position, c).applyMatrix4(localMatrix);
        edgeA.subVectors(vertexB, vertexA);
        edgeB.subVectors(vertexC, vertexA);
        faceNormal.crossVectors(edgeA, edgeB);
        const doubledArea = faceNormal.length();
        if (doubledArea < 0.00001) continue;
        faceNormal.multiplyScalar(1 / doubledArea);
        if (faceNormal.y < 0.72) continue;
        const centerY = (vertexA.y + vertexB.y + vertexC.y) / 3;
        if (centerY < minDeckSearchY || centerY > maxDeckSearchY) continue;
        const heightBin = Math.round(centerY / heightStep);
        const area = doubledArea * 0.5;
        areaByHeight.set(heightBin, (areaByHeight.get(heightBin) || 0) + area);
        candidates.push({
          a: vertexA.clone(),
          b: vertexB.clone(),
          c: vertexC.clone(),
          centerY,
          heightBin
        });
      }
    });

    const deckHeightBin = [...areaByHeight.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    if (!Number.isFinite(deckHeightBin)) return;
    const deckY = deckHeightBin * heightStep;
    const deckPositions = [];
    const deckTolerance = heightStep * 1.75;
    candidates.forEach((triangle) => {
      if (Math.abs(triangle.centerY - deckY) > deckTolerance) return;
      for (const vertex of [triangle.a, triangle.b, triangle.c]) {
        deckPositions.push(vertex.x, vertex.y + 0.018, vertex.z);
      }
    });
    if (deckPositions.length < 9) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(deckPositions, 3)
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const deckBox = geometry.boundingBox;
    const deckSize = deckBox.getSize(new THREE.Vector3());
    const longAxisX = deckSize.x >= deckSize.z;
    const positionAttribute = geometry.getAttribute("position");
    const deckUv = new Float32Array(positionAttribute.count * 2);
    for (let index = 0; index < positionAttribute.count; index += 1) {
      const x = positionAttribute.getX(index);
      const z = positionAttribute.getZ(index);
      deckUv[index * 2] = longAxisX
        ? (x - deckBox.min.x) / Math.max(deckSize.x, 0.001)
        : (z - deckBox.min.z) / Math.max(deckSize.z, 0.001);
      deckUv[index * 2 + 1] = longAxisX
        ? (z - deckBox.min.z) / Math.max(deckSize.z, 0.001)
        : (x - deckBox.min.x) / Math.max(deckSize.x, 0.001);
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(deckUv, 2));

    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    context.fillStyle = "#343b3e";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "rgba(220, 226, 224, 0.16)";
    context.lineWidth = 1;
    for (let x = 48; x < canvas.width; x += 64) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvas.height);
      context.stroke();
    }
    context.strokeStyle = "#e8ece9";
    context.lineCap = "round";
    context.lineWidth = 4;
    context.setLineDash([30, 24]);
    context.beginPath();
    context.moveTo(72, 160);
    context.lineTo(950, 160);
    context.stroke();
    context.setLineDash([]);
    context.lineWidth = 3;
    for (const y of [82, 108, 212, 238]) {
      context.beginPath();
      context.moveTo(610, y);
      context.lineTo(940, y);
      context.stroke();
    }
    context.strokeStyle = "#d0ae43";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(110, 230);
    context.lineTo(540, 190);
    context.stroke();
    context.beginPath();
    context.moveTo(110, 247);
    context.lineTo(540, 207);
    context.stroke();
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const material = new THREE.MeshStandardMaterial({
      map,
      color: 0xffffff,
      metalness: 0.28,
      roughness: 0.78,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    const deck = new THREE.Mesh(geometry, material);
    deck.name = "carrier-flight-deck-surface-correction";
    deck.receiveShadow = true;
    deck.renderOrder = 10;
    anchor.add(deck);
  }

  normalizeModel(source, definition) {
    const object = source;
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const scale = definition.desiredSize / Math.max(size.x, size.y, size.z, 0.001);
    object.scale.setScalar(scale);
    const scaled = new THREE.Box3().setFromObject(object);
    const center = scaled.getCenter(new THREE.Vector3());
    object.position.sub(center);
    object.position.y -= scaled.min.y;
    object.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      if (!child.geometry.getAttribute("normal")) child.geometry.computeVertexNormals();
      child.material = child.material.clone();
      child.material.vertexColors = Boolean(child.geometry.getAttribute("color"));
      child.material.metalness = Math.min(0.56, child.material.metalness ?? 0.2);
      child.material.roughness = Math.max(0.3, child.material.roughness ?? 0.46);
      if (child.material.emissive) {
        child.material.emissiveIntensity = Math.max(0.08, child.material.emissiveIntensity ?? 0);
      }
    });
    const anchor = new THREE.Group();
    anchor.name = `${definition.shortName || "unit"}-ground-anchor`;
    anchor.add(object);
    this.createCarrierDeckCorrection(anchor, definition);
    return anchor;
  }

  normalizeWeaponModel(source, desiredSize) {
    const object = source;
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const scale = desiredSize / Math.max(size.x, size.y, size.z, 0.001);
    object.scale.setScalar(scale);
    object.updateMatrixWorld(true);
    const scaled = new THREE.Box3().setFromObject(object);
    const center = scaled.getCenter(new THREE.Vector3());
    object.position.sub(center);
    object.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      if (!child.geometry.getAttribute("normal")) child.geometry.computeVertexNormals();
      child.material = child.material.clone();
      child.material.metalness = Math.min(0.62, child.material.metalness ?? 0.36);
      child.material.roughness = Math.max(0.34, child.material.roughness ?? 0.42);
    });
    const anchor = new THREE.Group();
    anchor.name = "meshy-rifle-anchor";
    anchor.add(object);
    return anchor;
  }

  getGroundShadowTexture() {
    if (this.groundShadowTexture) return this.groundShadowTexture;
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(88, 86, 5, 96, 96, 92);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.92)");
    gradient.addColorStop(0.34, "rgba(0, 0, 0, 0.68)");
    gradient.addColorStop(0.72, "rgba(0, 0, 0, 0.24)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.groundShadowTexture = texture;
    return texture;
  }

  createGroundContactShadow(definition, placementAltitude = definition.altitude) {
    const options = definition.contactShadow || {};
    const width = options.width || definition.desiredSize * 1.28;
    const depth = options.depth || definition.desiredSize * 0.66;
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({
        map: this.getGroundShadowTexture(),
        color: 0x050707,
        transparent: true,
        opacity: options.opacity ?? 0.64,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      })
    );
    shadow.name = "ground-contact-shadow";
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(width * 0.5, depth * 0.5, 1);
    shadow.position.set(
      options.offsetX || 0,
      -placementAltitude + 0.055,
      options.offsetZ || 0
    );
    shadow.renderOrder = 3;
    shadow.userData.isGroundContactShadow = true;
    return shadow;
  }

  getAirFormationOffsets(count, size) {
    const spacing = size * 1.82;
    if (count === 2) {
      return [
        new THREE.Vector3(spacing * 0.38, 0.04, 0),
        new THREE.Vector3(-spacing * 0.38, -0.03, 0)
      ];
    }
    return Array.from({ length: count }, (_, index) => {
      if (index === 0) return new THREE.Vector3(0, 0.05, -spacing * 0.5);
      const wing = Math.ceil(index / 2);
      const side = index % 2 === 1 ? -1 : 1;
      return new THREE.Vector3(
        side * wing * spacing,
        (index % 3 - 1) * 0.04,
        wing * spacing * 0.58
      );
    });
  }

  getSurfaceFormationOffsets(count, size) {
    const spacing = size * 0.92;
    if (count === 2) {
      return [
        new THREE.Vector3(spacing * 0.5, 0, spacing * 0.2),
        new THREE.Vector3(-spacing * 0.5, 0, -spacing * 0.2)
      ];
    }
    return Array.from({ length: count }, (_, index) => {
      if (index === 0) return new THREE.Vector3(0, 0, 0);
      const row = Math.ceil(index / 2);
      const side = index % 2 === 1 ? -1 : 1;
      return new THREE.Vector3(
        side * row * spacing,
        0,
        row * spacing * 0.42
      );
    });
  }

  getGroundFormationOffsets(count, size) {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const spacing = Math.max(2.2, size * 1.8);
    return Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      return new THREE.Vector3(
        (column - (columns - 1) * 0.5) * spacing,
        0,
        (row - (rows - 1) * 0.5) * spacing
      );
    });
  }

  createHelicopterRotor(definition) {
    const rotor = new THREE.Group();
    rotor.name = "animated-main-rotor";
    const radius = definition.desiredSize * 0.58;
    const geometries = [];
    const addColoredGeometry = (geometry, color) => {
      const value = new THREE.Color(color);
      const colors = new Float32Array(
        geometry.getAttribute("position").count * 3
      );
      for (let index = 0; index < colors.length; index += 3) {
        colors[index] = value.r;
        colors[index + 1] = value.g;
        colors[index + 2] = value.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometries.push(geometry);
    };
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2;
      const bladeGeometry = new THREE.BoxGeometry(radius * 0.84, 0.016, 0.052);
      bladeGeometry.translate(radius * 0.52, 0, 0);
      bladeGeometry.rotateY(angle);
      addColoredGeometry(bladeGeometry, 0xb9f7f8);
      const tipGeometry = new THREE.BoxGeometry(radius * 0.16, 0.024, 0.074);
      tipGeometry.translate(radius * 0.92, 0, 0);
      tipGeometry.rotateY(angle);
      addColoredGeometry(tipGeometry, index === 0 ? 0xff725f : 0xf3ffff);
    }
    addColoredGeometry(
      new THREE.CylinderGeometry(radius * 0.075, radius * 0.075, 0.055, 12),
      0x81999e
    );
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    rotor.add(new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.84,
        metalness: 0.35,
        roughness: 0.4,
        depthWrite: false
      })
    ));
    rotor.position.y = definition.desiredSize * 0.41;
    return rotor;
  }

  getFleetBudgetUsed(selection = this.fleetSelection) {
    return Object.entries(this.config.fleetSelection.options).reduce(
      (sum, [type, option]) => sum + selection[type] * option.cost,
      0
    );
  }

  getActiveSpawns() {
    let enemyIndex = 0;
    let convoyIndex = 0;
    const fixedSpawns = this.config.spawns
      .filter((spawn) => spawn.team !== "ally")
      .map((spawn) => {
        if (spawn.team === "enemy") {
          enemyIndex += 1;
          const callsign = spawn.callsignKey
            ? `${this.text(spawn.callsignKey)} ${spawn.callsignIndex || enemyIndex}`
            : `${this.text("enemyGroupCallsign")} ${enemyIndex}`;
          return { ...spawn, callsign };
        }
        convoyIndex += 1;
        return { ...spawn, callsign: `${this.text("convoyGroupCallsign")} ${convoyIndex}` };
      });
    const allyTemplates = Object.fromEntries(
      this.config.spawns
        .filter((spawn) => spawn.team === "ally")
        .map((spawn) => [spawn.type, spawn])
    );
    const allySpawns = [];
    for (const [type, count] of Object.entries(this.fleetSelection)) {
      const template = allyTemplates[type];
      if (!template || count <= 0) continue;
      const definition = this.config.unitTypes[type];
      const textKeys = this.getFleetTextKeys(type);
      if (definition.domain === "air") {
        const offsets = this.getAirFormationOffsets(
          count,
          definition.desiredSize
        );
        for (let index = 0; index < count; index += 1) {
          const fighter = type === "fighter";
          allySpawns.push({
            ...template,
            id: `${template.id}-${index + 1}`,
            callsign: `${this.text(textKeys.callsign)} ${index + 1}`,
            forceCount: 1,
            hero: true,
            modelVariant: index > 0 ? "formation" : "hero",
            strategicLod: (
              this.config.battle.scale === "large"
              && type !== "helicopter"
            ),
            instancedLod: (
              this.config.battle.scale === "large"
              && (type === "fighter" || type === "bomber")
            ),
            positionOffset: offsets[index]?.toArray() || [0, 0, 0],
            aiIndex: index,
            fireStagger: index * (fighter ? 0.18 : 0.24),
            ...(fighter ? {
              strengthScale: 0.67,
              damageMultiplier: 0.64
            } : {})
          });
        }
        continue;
      }
      const offsets = definition.domain === "land"
        ? this.getGroundFormationOffsets(count, definition.desiredSize)
        : this.getSurfaceFormationOffsets(
        count,
        definition.desiredSize
      );
      for (let index = 0; index < count; index += 1) {
        allySpawns.push({
          ...template,
          id: `${template.id}-${index + 1}`,
          callsign: `${this.text(textKeys.callsign)} ${index + 1}`,
          forceCount: 1,
          hero: true,
          strategicLod: this.config.battle.scale === "large"
            && definition.domain === "sea",
          instancedLod: this.config.battle.scale === "large"
            && definition.domain === "sea",
          positionOffset: offsets[index]?.toArray() || [0, 0, 0],
          aiIndex: index,
          fireStagger: index * 0.28
        });
      }
    }
    return [...allySpawns, ...fixedSpawns];
  }

  spawnUnits() {
    for (const spawn of this.getActiveSpawns()) this.createUnit(spawn);
    this.createInstancedLodBatches();
    this.createMeshyMarineLodBatch("enemyMarine");
    this.createMarineWeaponBatches();
    this.units.filter((unit) => unit.team === "enemy").forEach((unit, index) => {
      unit.aiIndex = index;
      unit.order = {
        type: unit.definition.domain === "land" || unit.type === "mine" ? "hold" : "hunt"
      };
    });
    this.renderForceList();
  }

  startCombatAudioLoops() {
    this.audioManager.startLoop("openSeaAmbience", this.camera, "ambient:ocean");
    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (unit.type === "helicopter") {
        this.audioManager.startLoop("helicopterRotor", unit.group, `rotor:${unit.id}`);
      } else if (unit.type === "fighter" || unit.type === "bomber") {
        this.audioManager.startLoop("fighterEngine", unit.group, `engine:${unit.id}`);
      } else if (unit.type === "destroyer" || unit.type === "carrier") {
        this.audioManager.startLoop("destroyerEngine", unit.group, `engine:${unit.id}`);
      } else if (unit.type === "fastBoat" || unit.type === "usv") {
        this.audioManager.startLoop("fastBoatEngine", unit.group, `engine:${unit.id}`);
      } else if (unit.type === "tanker") {
        if (!unit.captured) {
          this.audioManager.startLoop("tankerEngine", unit.group, `engine:${unit.id}`);
        }
      }
    }
  }

  stopUnitAudioLoops(unit) {
    this.audioManager.stopLoop(`rotor:${unit.id}`);
    this.audioManager.stopLoop(`engine:${unit.id}`);
  }

  updateMovementAudio() {
    if (this.elapsed - this.lastMovementAudioAt < 0.25) return;
    this.lastMovementAudioAt = this.elapsed;
    for (const unit of this.units) {
      if (!unit.alive || unit.type !== "fighter" || unit.escaped) continue;
      const dx = unit.position.x - this.camera.position.x;
      const dz = unit.position.z - this.camera.position.z;
      const cameraPlanarDistance = Math.hypot(dx, dz);
      if (
        unit.currentSpeed >= unit.definition.speed * 0.68
        && cameraPlanarDistance <= 38
        && this.elapsed - unit.lastFlybyAt >= 14
      ) {
        if (this.audioManager.play("fighterFlyby", unit.group)) {
          unit.lastFlybyAt = this.elapsed;
        }
      }
    }
  }

  updateFleetSelection(type, delta) {
    if (this.started) return;
    const option = this.config.fleetSelection.options[type];
    if (!option) return;
    const next = clamp(this.fleetSelection[type] + delta, option.minimum, option.maximum);
    if (next === this.fleetSelection[type]) return;
    const proposal = { ...this.fleetSelection, [type]: next };
    if (this.getFleetBudgetUsed(proposal) > this.config.fleetSelection.budget) {
      this.dom.fleetBuilder.classList.add("over-budget");
      this.dom.fleetMessage.classList.add("error");
      this.dom.fleetMessage.textContent = this.text("fleetBudgetExceeded");
      setTimeout(() => this.dom.fleetBuilder.classList.remove("over-budget"), 420);
      return;
    }
    this.fleetSelection = proposal;
    this.updateFleetBuilder();
    this.playTone("command");
  }

  updateFleetBuilder() {
    const budget = this.config.fleetSelection.budget;
    const used = this.getFleetBudgetUsed();
    const totalUnits = Object.values(this.fleetSelection).reduce((sum, count) => sum + count, 0);
    const requiredFleetType = this.config.battle.requiredFleetType || null;
    const requiredFleetMissing = Boolean(
      requiredFleetType && this.fleetSelection[requiredFleetType] <= 0
    );
    const availableTypes = Object.entries(this.config.fleetSelection.options)
      .filter(([, option]) => option.maximum > 0)
      .map(([type]) => type);
    this.dom.shell.dataset.fleetOptionCount = String(availableTypes.length);
    this.dom.shell.dataset.fleetTypes = availableTypes.join("|");
    this.dom.shell.dataset.budget = String(budget);
    this.dom.shell.dataset.budgetUsed = String(used);
    this.dom.shell.dataset.fleetUnitCount = String(totalUnits);
    this.dom.fleetBudgetUsed.textContent = this.formatBudget(used);
    this.dom.fleetBudgetCap.textContent = this.formatBudget(budget);
    for (const [type, option] of Object.entries(this.config.fleetSelection.options)) {
      const count = this.fleetSelection[type];
      document.getElementById(`fleet-${type}-count`).textContent = count;
      const article = document.querySelector(`[data-fleet-type="${type}"]`);
      if (!article) continue;
      article.hidden = false;
      article.classList.toggle("included", count > 0);
      article.classList.toggle("not-selected", count === 0 && option.maximum > 0);
      article.classList.toggle("unavailable", option.maximum <= 0);
      article.setAttribute("aria-disabled", String(option.maximum <= 0));
      let status = article.querySelector(".fleet-status");
      if (!status) {
        status = document.createElement("em");
        status.className = "fleet-status";
        article.firstElementChild?.append(status);
      }
      status.textContent = option.maximum <= 0
        ? this.text("fleetUnavailable")
        : count > 0
          ? this.text("fleetIncluded")
          : this.text("fleetNotSelected");
      const cost = document.getElementById(`fleet-${type}-cost`);
      if (cost) cost.hidden = option.maximum <= 0;
      article.querySelector('[data-fleet-step="-1"]').disabled = option.maximum <= 0
        || count <= option.minimum;
      article.querySelector('[data-fleet-step="1"]').disabled = option.maximum <= 0
        || count >= option.maximum
        || used + option.cost > budget;
    }
    this.dom.fleetMessage.classList.remove("error");
    this.dom.start.disabled = totalUnits === 0 || requiredFleetMissing;
    this.dom.start.setAttribute(
      "aria-disabled",
      String(totalUnits === 0 || requiredFleetMissing)
    );
    if (requiredFleetMissing) {
      this.dom.fleetMessage.classList.add("error");
      this.dom.fleetMessage.textContent = this.text(
        this.config.battle.requiredFleetMessageKey || "rescueHelicopterRequired"
      );
    } else if (totalUnits === 0) {
      this.dom.fleetMessage.classList.add("error");
      const leastExpensive = Math.min(
        ...Object.values(this.config.fleetSelection.options)
          .filter((option) => option.maximum > 0)
          .map((option) => option.cost)
      );
      this.dom.fleetMessage.textContent = budget < leastExpensive
        ? this.text("fleetNoBudget")
        : this.text("fleetNeedOne");
    } else {
      this.dom.fleetMessage.textContent = `${this.text("fleetDefaultRule")} ${this.text("fleetBudgetRemaining")} ${this.formatBudget(budget - used)}`;
    }
    this.dom.budgetPoliticsStatus.textContent = [
      `${this.text("congressStatus")} ${Math.round(this.politics.congressSupport)}%`,
      `${this.text("partyStatus")} ${Math.round(this.politics.partySupport)}%`
    ].join(" · ");
    this.dom.requestCongressBudget.disabled = this.started || this.budgetResolved;
    this.dom.requestCongressBudget.title = this.budgetResolved
      ? this.text("congressBudgetUsed")
      : this.text("congressBudgetButton");
    this.dom.briefFriendlyForce.textContent = Object.entries(
      this.config.fleetSelection.options
    )
      .filter(([type, option]) => option.maximum > 0 && this.fleetSelection[type] > 0)
      .map(([type]) => {
        const keys = this.getFleetTextKeys(type);
        return `${this.text(keys.summary)} ${this.fleetSelection[type]}${keys.unit ? this.text(keys.unit) : ""}`;
      })
      .join(" · ");
  }

  openCongressBudget() {
    if (this.started || this.budgetResolved) return;
    this.congressMessage = this.text("congressLead");
    this.dom.congressLayer.hidden = false;
    this.renderCongressBudget();
  }

  renderCongressBudget() {
    const actions = this.lang === "en"
      ? [
          {
            id: "briefing",
            name: "Classified threat briefing",
            desc: "Share verified threat intelligence with key committees.",
            congress: 8,
            party: 1,
            approval: 0,
            intl: 0
          },
          {
            id: "shipyards",
            name: "Regional shipyard jobs",
            desc: "Attach fleet maintenance work to swing districts.",
            congress: 7,
            party: 3,
            approval: 1,
            intl: 0
          },
          {
            id: "allies",
            name: "Allied cost sharing",
            desc: "Add allied funding to reduce the domestic burden.",
            congress: 6,
            party: -1,
            approval: 0,
            intl: 3
          }
        ]
      : [
          {
            id: "briefing",
            name: "기밀 위협 브리핑",
            desc: "핵심 위원회에 검증된 위협 정보를 공개합니다.",
            congress: 8,
            party: 1,
            approval: 0,
            intl: 0
          },
          {
            id: "shipyards",
            name: "지역 조선소 일자리",
            desc: "함대 정비 계약을 경합 지역구와 연계합니다.",
            congress: 7,
            party: 3,
            approval: 1,
            intl: 0
          },
          {
            id: "allies",
            name: "동맹 비용 분담",
            desc: "동맹국 분담안을 붙여 국내 재정 부담을 낮춥니다.",
            congress: 6,
            party: -1,
            approval: 0,
            intl: 3
          }
        ];
    const support = Math.round(this.politics.congressSupport);
    const supportDelta = support - Math.round(this.congressBaseline.congressSupport);
    const party = Math.round(this.politics.partySupport);
    const partyDelta = party - Math.round(this.congressBaseline.partySupport);
    this.dom.congressCard.innerHTML = `
      <span class="brief-kicker">${this.text("congressKicker")}</span>
      <figure class="congress-visual">
        <img src="assets/images/politics/congress-emergency-session-v1.webp" alt="${this.lang === "en" ? "Emergency supplemental budget hearing in Congress" : "긴급 추가예산안 심의가 진행되는 의회 회의장"}" decoding="async">
        <figcaption>${this.lang === "en" ? "Emergency appropriation · Congressional vote" : "긴급 추가예산안 · 의회 표결"}</figcaption>
      </figure>
      <h2>${this.text("congressTitle")}</h2>
      <p>${this.text("congressLead")}</p>
      <div class="congress-score">
        <div><span>${this.text("congressStatus")}</span><strong>${support}%</strong></div>
        <i><b style="width:${support}%"></b></i>
        <div><span>${this.text("partyStatus")}</span><strong>${party}%</strong></div>
      </div>
      <div class="congress-live-change">
        <span class="${supportDelta >= 0 ? "good" : "bad"}">${this.text("congressStatus")} ${supportDelta >= 0 ? "+" : ""}${supportDelta} · ${support}%</span>
        <span class="${partyDelta >= 0 ? "good" : "bad"}">${this.text("partyStatus")} ${partyDelta >= 0 ? "+" : ""}${partyDelta} · ${party}%</span>
        <span class="${this.politics.approvalDelta >= 0 ? "good" : "bad"}">${this.lang === "en" ? "Public" : "국민"} ${this.politics.approvalDelta >= 0 ? "+" : ""}${this.politics.approvalDelta}</span>
        <span class="${this.politics.intlDelta >= 0 ? "good" : "bad"}">${this.lang === "en" ? "Allies" : "국제"} ${this.politics.intlDelta >= 0 ? "+" : ""}${this.politics.intlDelta}</span>
      </div>
      <div class="congress-choice-grid">${actions.map((action) => `
        <button type="button" data-congress-action="${action.id}" ${this.congressActionsUsed.has(action.id) ? "disabled" : ""}>
          <strong>${action.name}</strong>
          <span>${action.desc}</span>
          <small><b class="change-chip good">${this.text("congressStatus")} +${action.congress}</b><b class="change-chip ${action.party >= 0 ? "good" : "bad"}">${this.text("partyStatus")} ${action.party >= 0 ? "+" : ""}${action.party}</b></small>
        </button>`).join("")}
      </div>
      <p class="congress-feedback">${this.congressMessage}</p>
      <div class="congress-buttons">
        <button type="button" class="ghost-budget-button" id="close-congress">${this.text("congressClose")}</button>
        <button type="button" class="force-budget-button" id="force-congress">${this.text("congressOverride")}</button>
        <button type="button" class="vote-budget-button" id="vote-congress">${this.text("congressVote")}</button>
      </div>`;
    this.dom.congressCard.querySelectorAll("[data-congress-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = actions.find((item) => item.id === button.dataset.congressAction);
        if (!action || this.congressActionsUsed.has(action.id)) return;
        this.congressActionsUsed.add(action.id);
        this.politics.congressSupport = clamp(
          this.politics.congressSupport + action.congress,
          0,
          100
        );
        this.politics.partySupport = clamp(
          this.politics.partySupport + action.party,
          0,
          100
        );
        this.politics.approvalDelta += action.approval;
        this.politics.intlDelta += action.intl;
        this.congressMessage = `${action.name} · ${this.text("congressStatus")} ${Math.round(this.politics.congressSupport)}%`;
        this.renderCongressBudget();
      });
    });
    this.dom.congressCard.querySelector("#close-congress").addEventListener("click", () => {
      this.dom.congressLayer.hidden = true;
      this.updateFleetBuilder();
    });
    this.dom.congressCard.querySelector("#vote-congress").addEventListener("click", () => {
      if (this.politics.congressSupport < 51) {
        this.politics.congressSupport = clamp(this.politics.congressSupport - 3, 0, 100);
        this.politics.approvalDelta -= 2;
        this.congressMessage = this.text("congressFailed");
        this.renderCongressBudget();
        return;
      }
      const supplemental = this.config.fleetSelection.supplementalAmount || 240;
      this.config.fleetSelection.budget += supplemental;
      this.supplementalBudget += supplemental;
      this.politics.approvalDelta += 1;
      this.politics.partySupport = clamp(this.politics.partySupport + 2, 0, 100);
      this.budgetResolved = true;
      this.congressMessage = `${this.formatBudget(supplemental)} · ${this.text("congressPassed")}`;
      this.dom.congressLayer.hidden = true;
      this.updateFleetBuilder();
      this.showHint(this.congressMessage);
    });
    this.dom.congressCard.querySelector("#force-congress").addEventListener("click", () => {
      const supplemental = this.config.fleetSelection.supplementalAmount || 240;
      this.config.fleetSelection.budget += supplemental;
      this.supplementalBudget += supplemental;
      this.politics.approvalDelta -= 7;
      this.politics.partySupport = clamp(this.politics.partySupport - 10, 0, 100);
      this.politics.congressSupport = clamp(this.politics.congressSupport - 12, 0, 100);
      this.politics.forcedAppropriation = true;
      this.budgetResolved = true;
      this.congressMessage = `${this.formatBudget(supplemental)} · ${this.text("congressForced")}`;
      this.dom.congressLayer.hidden = true;
      this.updateFleetBuilder();
      this.showHint(this.congressMessage);
    });
  }

  createUnit(spawn) {
    const definition = this.config.unitTypes[spawn.type];
    const requestedCoordinate = [spawn.lon, spawn.lat];
    const groundClearance = definition.domain === "land"
      ? Math.max(1.2, definition.desiredSize * 0.75)
      : 0;
    const resolvedCoordinate = definition.domain === "land"
      ? this.resolveLandCoordinate(spawn.lon, spawn.lat, groundClearance)
      : definition.domain === "sea"
        ? this.resolveWaterCoordinate(
          spawn.lon,
          spawn.lat,
          this.getSeaClearance(definition)
        )
        : requestedCoordinate;
    if (
      definition.domain === "sea"
      && (
        Math.abs(resolvedCoordinate[0] - requestedCoordinate[0]) > 0.000001
        || Math.abs(resolvedCoordinate[1] - requestedCoordinate[1]) > 0.000001
      )
    ) {
      this.navigationStats.correctedSeaSpawns += 1;
    }
    const forceCount = spawn.forceCount || 1;
    const strengthScale = spawn.strengthScale ?? (0.65 + forceCount * 0.35);
    const unit = {
      id: spawn.id,
      team: spawn.team,
      type: spawn.type,
      callsign: spawn.callsign,
      definition,
      forceCount,
      hp: Math.round(definition.maxHp * strengthScale),
      maxHp: Math.round(definition.maxHp * strengthScale),
      damageMultiplier: spawn.damageMultiplier ?? (0.72 + forceCount * 0.28),
      alive: true,
      selected: false,
      order: {
        type: spawn.team === "civilian"
          ? "convoy"
          : spawn.team === "ally"
            ? "standby"
            : "hold"
      },
      lastShotAt: -999,
      lastHitAt: -999,
      nextShotAt: null,
      shotsFired: 0,
      fireStagger: spawn.fireStagger || 0,
      aiIndex: spawn.aiIndex || 0,
      routeT: 0.13 + (spawn.routeOffset || 0),
      escaped: false,
      currentSpeed: 0,
      lastTurnRate: 0,
      forward: new THREE.Vector3(0, 0, 1),
      velocity: new THREE.Vector3(),
      loiterPhase: Math.random() * Math.PI * 2,
      loiterAnchor: null,
      lastFlybyAt: -999,
      lastWaterPosition: null,
      coastAvoidanceSide: 0,
      coastClearFrames: 0,
      coastContactActive: false,
      fixed: Boolean(spawn.fixed),
      instancedLod: Boolean(spawn.instancedLod),
      rescueTarget: Boolean(spawn.rescueTarget),
      objectiveTarget: Boolean(spawn.objectiveTarget),
      captured: Boolean(spawn.captured),
      rescued: false,
      groundClearance,
      geographic: {
        requested: requestedCoordinate,
        resolved: resolvedCoordinate,
        onLand: this.isLandCoordinate(resolvedCoordinate[0], resolvedCoordinate[1])
      }
    };

    const group = new THREE.Group();
    const placementAltitude = definition.domain === "land" && this.googleBattleMapActive
      ? 0.08
      : definition.altitude;
    const selectedModelSource = spawn.modelVariant === "formation"
      ? this.formationModels[spawn.type] || this.models[spawn.type]
      : this.models[spawn.type];
    const marineUnit = spawn.type === "marine" || spawn.type === "enemyMarine";
    const useHero = spawn.hero && selectedModelSource && !spawn.strategicLod;
    const model = useHero
      ? (marineUnit
        ? cloneSkeleton(selectedModelSource)
        : selectedModelSource.clone(true))
      : this.normalizeModel(this.createFallbackModel(spawn.type, spawn.team), definition);
    const visualRoot = new THREE.Group();
    visualRoot.rotation.y = useHero
      ? definition.modelYaw || 0
      : definition.fallbackYaw || 0;
    const modelInstances = [model];
    visualRoot.add(...modelInstances);
    unit.rotors = [];
    if (spawn.type === "helicopter" && useHero) {
      const rotor = this.createHelicopterRotor(definition);
      visualRoot.add(rotor);
      unit.rotors.push({ object: rotor, speed: 10.8 });
    } else if (spawn.type === "helicopter") {
      const rotor = model.getObjectByName("animated-main-rotor");
      if (rotor) unit.rotors.push({ object: rotor, speed: 10.8 });
    }
    group.add(visualRoot);
    if (definition.domain === "land") {
      unit.contactShadow = this.createGroundContactShadow(definition, placementAltitude);
      if (this.config.battle.scale === "large") {
        unit.contactShadow.visible = false;
      }
      group.add(unit.contactShadow);
      unit.groundShadowElement = document.createElement("div");
      unit.groundShadowElement.className = "ground-unit-shadow";
      unit.groundShadowElement.dataset.unitId = unit.id;
      this.groundShadowsRoot.appendChild(unit.groundShadowElement);
    }
    unit.model = model;
    unit.meshyModel = Boolean(useHero);
    unit.modelInstances = modelInstances;
    unit.visualRoot = visualRoot;
    this.initializeMarineRig(unit);

    const ringSize = definition.desiredSize * (
      definition.domain === "air" ? 0.82 : 0.58
    );
    const selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(ringSize * 0.76, ringSize, 64),
      new THREE.MeshBasicMaterial({
        color: TEAM_COLORS[spawn.team],
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide
      })
    );
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.position.y = definition.domain === "air"
      ? -definition.desiredSize * 0.2
      : 0.08;
    selectionRing.renderOrder = 18;
    selectionRing.visible = false;
    group.add(selectionRing);
    unit.selectionRing = selectionRing;

    const rangeRing = new THREE.Mesh(
      new THREE.RingGeometry(definition.range - 0.07, definition.range, 80),
      new THREE.MeshBasicMaterial({
        color: TEAM_COLORS[spawn.team],
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    rangeRing.rotation.x = -Math.PI / 2;
    rangeRing.position.y = spawn.type === "fighter" ? -definition.altitude + 0.04 : 0.04;
    rangeRing.visible = false;
    group.add(rangeRing);
    unit.rangeRing = rangeRing;

    group.position.copy(this.project(
      resolvedCoordinate[0],
      resolvedCoordinate[1],
      placementAltitude
    ));
    if (spawn.positionOffset) {
      group.position.add(new THREE.Vector3(
        spawn.positionOffset[0] || 0,
        spawn.positionOffset[1] || 0,
        spawn.positionOffset[2] || 0
      ));
    }
    if (
      definition.domain === "land"
      && !this.isWorldLandInterior(group.position, groundClearance)
    ) {
      const [offsetLon, offsetLat] = this.unproject(group.position);
      const [landLon, landLat] = this.resolveLandCoordinate(
        offsetLon,
        offsetLat,
        groundClearance
      );
      group.position.copy(this.project(landLon, landLat, placementAltitude));
      unit.geographic.resolved = [landLon, landLat];
      unit.geographic.onLand = true;
    }
    group.rotation.y = spawn.team === "enemy" ? -2.3 : 0.8;
    unit.forward.set(Math.sin(group.rotation.y), 0, Math.cos(group.rotation.y));
    group.userData.unit = unit;
    group.traverse((child) => { child.userData.unit = unit; });
    unit.group = group;
    unit.position = group.position;
    unit.placementAltitude = placementAltitude;
    if (definition.domain === "sea") {
      unit.lastWaterPosition = group.position.clone();
    } else if (definition.domain === "land") {
      unit.lastLandPosition = group.position.clone();
    }
    this.unitRoot.add(group);
    if (definition.domain === "sea" && spawn.wake !== false) {
      unit.wake = this.fx.createWake(
        spawn.team === "enemy" ? 0xffa066 : spawn.team === "civilian" ? 0xd7eeee : 0x68e4ed
      );
    }
    this.units.push(unit);

    const label = document.createElement("div");
    label.className = `unit-label ${spawn.team}`;
    label.innerHTML = `<span>${spawn.callsign}</span><i></i>`;
    this.labelsRoot.appendChild(label);
    unit.label = label;
    return unit;
  }

  getStrategicDetailTexture(type) {
    if (this.strategicDetailTextures[type]) {
      return this.strategicDetailTextures[type];
    }
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = "#eeeeec";
    context.fillRect(0, 0, 256, 256);

    for (let y = 0; y < 256; y += 8) {
      for (let x = 0; x < 256; x += 8) {
        const noise = hashNoise(x, y, type.length);
        const shade = Math.round(226 + noise * 24);
        context.fillStyle = `rgb(${shade},${shade},${Math.max(0, shade - 2)})`;
        context.fillRect(x, y, 8, 8);
      }
    }

    context.strokeStyle = "rgba(36, 45, 48, 0.28)";
    context.lineWidth = 1;
    for (let x = 16; x < 256; x += 32) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, 256);
      context.stroke();
    }
    for (let y = 16; y < 256; y += 48) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(256, y);
      context.stroke();
    }

    if (type === "carrier") {
      context.fillStyle = "rgba(36, 43, 45, 0.56)";
      context.fillRect(22, 112, 212, 22);
      context.strokeStyle = "rgba(250, 245, 220, 0.9)";
      context.lineWidth = 4;
      context.setLineDash([14, 10]);
      context.beginPath();
      context.moveTo(28, 123);
      context.lineTo(228, 123);
      context.stroke();
      context.setLineDash([]);
    } else if (type === "tanker") {
      context.strokeStyle = "rgba(115, 55, 38, 0.7)";
      context.lineWidth = 7;
      for (const y of [76, 128, 180]) {
        context.beginPath();
        context.moveTo(14, y);
        context.lineTo(242, y);
        context.stroke();
      }
    } else if (type === "destroyer" || type === "usv") {
      context.strokeStyle = "rgba(244, 239, 216, 0.78)";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(22, 128);
      context.lineTo(234, 128);
      context.stroke();
    } else if (type === "fighter" || type === "bomber") {
      context.strokeStyle = "rgba(50, 55, 57, 0.48)";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(128, 16);
      context.lineTo(128, 240);
      context.moveTo(28, 128);
      context.lineTo(228, 128);
      context.stroke();
    } else if (type === "tel") {
      context.fillStyle = "rgba(79, 62, 38, 0.24)";
      for (let y = 20; y < 256; y += 36) {
        context.fillRect(0, y, 256, 12);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(
      8,
      this.renderer.capabilities.getMaxAnisotropy()
    );
    this.strategicDetailTextures[type] = texture;
    return texture;
  }

  addStrategicPlanarUv(geometry) {
    if (geometry.getAttribute("uv")) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const size = box.getSize(new THREE.Vector3());
    const horizontalAxes = [
      { axis: "x", size: size.x, offset: box.min.x },
      { axis: "z", size: size.z, offset: box.min.z }
    ].sort((left, right) => right.size - left.size);
    const longAxis = horizontalAxes[0];
    const wideAxis = horizontalAxes[1];
    const uv = new Float32Array(position.count * 2);
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = position.getZ(index);
      const values = { x, z };
      uv[index * 2] = (
        values[longAxis.axis] - longAxis.offset
      ) / Math.max(0.0001, longAxis.size);
      uv[index * 2 + 1] = (
        values[wideAxis.axis] - wideAxis.offset
      ) / Math.max(0.0001, wideAxis.size);
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }

  createInstancedLodBatches() {
    const groups = new Map();
    for (const unit of this.units) {
      if (!unit.instancedLod || !unit.alive) continue;
      const key = `${unit.team}:${unit.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(unit);
    }
    for (const units of groups.values()) {
      if (!units.length) continue;
      const definition = units[0].definition;
      const meshySource = (
        this.strategicModels[units[0].type]
        || this.models[units[0].type]
        || null
      );
      const useMeshySource = Boolean(meshySource);
      const source = useMeshySource
        ? meshySource
        : this.createFallbackModel(units[0].type, units[0].team);
      source.updateMatrixWorld(true);
      const sourceMesh = source.getObjectByProperty("isMesh", true);
      if (!sourceMesh) continue;
      const geometry = sourceMesh.geometry.clone();
      const displayScale = Math.max(1, definition.strategicDisplayScale || 1);
      let sourceMatrix = null;
      let scale = displayScale;
      if (useMeshySource) {
        // gltfpack LOD의 POSITION/NORMAL은 normalized 정수 속성이다.
        // geometry.applyMatrix4()로 직접 수정하면 정수 양자화 범위를 넘겨
        // 선체가 0.0001배 수준으로 축소된다. 압축 geometry는 그대로 두고
        // 정규화된 부모 행렬을 인스턴스 행렬에 결합한다.
        sourceMatrix = sourceMesh.matrixWorld.clone();
      } else {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        geometry.translate(-center.x, -box.min.y, -center.z);
        scale = (
          definition.desiredSize
          / Math.max(size.x, size.y, size.z, 0.001)
          * displayScale
        );
      }
      const material = sourceMesh.material.clone();
      if (useMeshySource) {
        // 팀 구분은 라벨·선택 링·항적으로 처리한다. 모델 본체에 팀 색을
        // 발광시키면 Google 주간 지도에서 원본 Meshy 텍스처가 단색으로
        // 날아가므로 PBR 기본색과 베이스컬러 맵을 그대로 보존한다.
        if (material.color) material.color.setHex(0xffffff);
        if (material.map) {
          material.map.colorSpace = THREE.SRGBColorSpace;
          material.map.anisotropy = Math.min(
            8,
            this.renderer.capabilities.getMaxAnisotropy()
          );
        } else {
          this.addStrategicPlanarUv(geometry);
          material.map = this.getStrategicDetailTexture(units[0].type);
        }
        material.vertexColors = Boolean(geometry.getAttribute("color"));
        const visibilityLift = this.googleBattleMapActive ? 0 : 0.12;
        if (material.emissive) {
          material.emissive.setHex(visibilityLift > 0 ? 0xffffff : 0x000000);
          material.emissiveIntensity = visibilityLift;
        }
        material.needsUpdate = true;
        definition.strategicEmissive = visibilityLift;
      }
      const mesh = new THREE.InstancedMesh(geometry, material, units.length);
      mesh.name = `strategic-instance-${units[0].type}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      this.unitRoot.add(mesh);
      const batch = {
        mesh,
        units,
        scale,
        displayScale,
        sourceMatrix,
        emissiveStrength: definition.strategicEmissive ?? 0,
        fallbackYaw: useMeshySource
          ? definition.modelYaw || 0
          : definition.fallbackYaw || 0,
        meshySource: useMeshySource,
        matrix: new THREE.Matrix4(),
        quaternion: new THREE.Quaternion(),
        euler: new THREE.Euler(),
        scaleVector: new THREE.Vector3()
      };
      const strategicDetailSource = this.strategicDetailModels[units[0].type];
      if (strategicDetailSource) {
        const detailRoot = new THREE.Group();
        const detailOrientation = new THREE.Group();
        const detailModel = strategicDetailSource.clone(true);
        detailOrientation.rotation.y = definition.modelYaw || 0;
        detailOrientation.add(detailModel);
        detailRoot.add(detailOrientation);
        detailRoot.scale.setScalar(displayScale);
        detailRoot.visible = false;
        detailRoot.name = `strategic-textured-detail-${units[0].type}`;
        detailRoot.traverse((child) => {
          if (!child.isMesh || !child.material) return;
          if (child.material.map) {
            child.material.map.colorSpace = THREE.SRGBColorSpace;
            child.material.map.anisotropy = Math.min(
              8,
              this.renderer.capabilities.getMaxAnisotropy()
            );
          }
          if (child.material.emissive) {
            child.material.emissive.setHex(0x000000);
            child.material.emissiveIntensity = 0;
          }
        });
        this.unitRoot.add(detailRoot);
        batch.detailRoot = detailRoot;
        batch.detailModel = detailModel;
      }
      this.instancedLodBatches.push(batch);
      units.forEach((unit, index) => {
        unit.instancedBatch = batch;
        unit.instancedIndex = index;
        unit.visualRoot.visible = false;
        unit.visualRoot.traverse((child) => {
          if (!child.isMesh) return;
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) {
            child.material.forEach((item) => item.dispose?.());
          } else {
            child.material?.dispose?.();
          }
        });
        unit.visualRoot.clear();
      });
      if (!useMeshySource) {
        source.traverse((child) => {
          if (!child.isMesh) return;
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) {
            child.material.forEach((item) => item.dispose?.());
          } else {
            child.material?.dispose?.();
          }
        });
      }
    }
    this.updateInstancedLodBatches();
  }

  updateInstancedLodBatches() {
    for (const batch of this.instancedLodBatches) {
      const detailUnit = batch.detailRoot
        ? (
          batch.units.find((unit) => unit.alive && this.selected.has(unit))
          || batch.units.find((unit) => unit.alive)
          || null
        )
        : null;
      batch.units.forEach((unit, index) => {
        const visibleScale = unit.alive && unit !== detailUnit
          ? batch.scale
          : 0.00001;
        batch.euler.set(
          unit.visualRoot?.rotation.x || 0,
          unit.group.rotation.y + batch.fallbackYaw,
          unit.visualRoot?.rotation.z || 0,
          "YXZ"
        );
        batch.quaternion.setFromEuler(batch.euler);
        batch.scaleVector.setScalar(visibleScale);
        batch.matrix.compose(unit.position, batch.quaternion, batch.scaleVector);
        if (batch.sourceMatrix) batch.matrix.multiply(batch.sourceMatrix);
        batch.mesh.setMatrixAt(index, batch.matrix);
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.detailRoot) {
        batch.detailRoot.visible = Boolean(detailUnit);
        batch.detailUnit = detailUnit;
        if (detailUnit) {
          batch.detailRoot.position.copy(detailUnit.position);
          batch.detailRoot.rotation.set(
            detailUnit.visualRoot?.rotation.x || 0,
            detailUnit.group.rotation.y,
            detailUnit.visualRoot?.rotation.z || 0,
            "YXZ"
          );
        }
      }
    }
  }

  createMeshyMarineLodBatch(type) {
    const useStrategicInfantryLod = this.config.battle.scale === "large";
    if (!useStrategicInfantryLod) return;
    const units = this.units.filter((unit) => (
      unit.alive
      && unit.type === type
      && unit.meshyModel
      && unit.marineRig?.meshy
    ));
    const sourceModel = this.models[type];
    if (units.length < 2 || !sourceModel) return;

    const source = cloneSkeleton(sourceModel);
    const poseVisualRoot = new THREE.Group();
    poseVisualRoot.name = `${type}-strategic-aim-bake-root`;
    poseVisualRoot.add(source);
    const strategicAimParentYaw = (
      units[0].definition.modelYaw || 0
    ) + (
      units[0].definition.weaponAimYawCorrection || 0
    );
    // Strategic infantry keeps a single baked firing pose. Reproduce the
    // live visual-root yaw while solving the weapon in world space so the
    // rifle anchor stores the inverse correction locally. Without this the
    // AK inherited the -41.5 degree character correction a second time and
    // appeared to fire across the soldier's body.
    poseVisualRoot.rotation.y = strategicAimParentYaw;
    const poseUnit = {
      id: `${type}-strategic-aim-bake`,
      type,
      model: source,
      visualRoot: poseVisualRoot,
      meshyModel: true,
      definition: units[0].definition,
      forward: new THREE.Vector3(0, 0, 1),
      aiIndex: 0
    };
    this.initializeMarineRig(poseUnit);
    const poseRig = poseUnit.marineRig;
    if (!poseRig?.meshy || !poseRig?.rightHand || !poseRig?.leftHand) return;

    // The former strategic bake sampled the Iranian combat clip at 40%,
    // where both arms are above the head. Start from the neutral walk frame,
    // then reuse the same shoulder/trigger/support-hand IK as the hero marine.
    for (const action of [
      poseRig.idleAction,
      poseRig.walkAction,
      poseRig.combatAction
    ]) {
      action?.stop();
    }
    const baseAction = poseRig.walkAction || poseRig.idleAction;
    if (baseAction) {
      baseAction.reset().play();
      baseAction.paused = true;
      baseAction.time = baseAction.getClip().duration
        * (
          poseUnit.definition.strategicCombatBasePoseFraction
          ?? poseUnit.definition.combatBasePoseFraction
          ?? 0.18
        );
      poseRig.mixer.update(0);
    }
    this.applyMarineShoulderAim(poseUnit, poseRig);
    poseVisualRoot.updateMatrixWorld(true);
    const inversePoseVisualRoot = new THREE.Matrix4()
      .copy(poseVisualRoot.matrixWorld)
      .invert();
    const skinned = source.getObjectByProperty("isSkinnedMesh", true);
    if (!skinned) return;
    skinned.skeleton?.update?.();

    const geometry = skinned.geometry.clone();
    const sourcePosition = skinned.geometry.getAttribute("position");
    const bakedPosition = geometry.getAttribute("position");
    const vertex = new THREE.Vector3();
    const applyBoneTransform = skinned.applyBoneTransform
      ? (index, target) => skinned.applyBoneTransform(index, target)
      : skinned.boneTransform
        ? (index, target) => skinned.boneTransform(index, target)
        : null;
    if (!applyBoneTransform) return;
    for (let index = 0; index < sourcePosition.count; index += 1) {
      vertex.fromBufferAttribute(sourcePosition, index);
      applyBoneTransform(index, vertex);
      vertex.applyMatrix4(skinned.matrixWorld);
      vertex.applyMatrix4(inversePoseVisualRoot);
      bakedPosition.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
    bakedPosition.needsUpdate = true;
    geometry.deleteAttribute("skinIndex");
    geometry.deleteAttribute("skinWeight");
    geometry.deleteAttribute("normal");
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = Array.isArray(skinned.material)
      ? skinned.material.map((item) => item.clone())
      : skinned.material.clone();

    const rightHand = poseRig.rightHand;
    const leftHand = poseRig.leftHand;
    const posedWeaponPosition = poseRig.weaponAnchor.position.clone();
    const posedWeaponQuaternion = poseRig.weaponAnchor.quaternion.clone();
    const poseRight = rightHand.getWorldPosition(new THREE.Vector3());
    const poseLeft = leftHand.getWorldPosition(new THREE.Vector3());
    const poseGrip = poseRig.gripAnchor.getWorldPosition(new THREE.Vector3());
    const poseSupport = poseRig.weaponAnchor.localToWorld(
      new THREE.Vector3().fromArray(
        poseUnit.definition.weaponSupportPoint || [0.04, -0.02, 0]
      )
    );
    const poseStock = poseRig.weaponAnchor.localToWorld(
      new THREE.Vector3().fromArray(
        poseUnit.definition.weaponStockPoint || [-0.5, 0.02, 0]
      )
    );
    const poseShoulder = poseRig.rightShoulder.getWorldPosition(
      new THREE.Vector3()
    );
    const bakedPoseMetrics = {
      gripError: Number(poseGrip.distanceTo(poseRight).toFixed(3)),
      supportHandError: Number(poseSupport.distanceTo(poseLeft).toFixed(3)),
      stockShoulderError: Number(poseStock.distanceTo(poseShoulder).toFixed(3)),
      strategicAimParentYaw: Number(strategicAimParentYaw.toFixed(4)),
      referenceSource: poseRig.referenceSource || null,
      referenceClip: poseRig.referenceClipName || null
    };

    units.forEach((unit) => {
      unit.model.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) child.visible = false;
      });
      unit.marineRig.mixer?.stopAllAction?.();
      const weaponAnchor = new THREE.Object3D();
      weaponAnchor.name = `${unit.id}-meshy-lod-rifle-anchor`;
      weaponAnchor.position.copy(posedWeaponPosition);
      weaponAnchor.quaternion.copy(posedWeaponQuaternion);
      const muzzleAnchor = new THREE.Object3D();
      muzzleAnchor.name = `${unit.id}-meshy-lod-muzzle-anchor`;
      muzzleAnchor.position.fromArray(
        unit.definition.weaponMuzzleOffset || [0.49, 0, 0]
      );
      const gripAnchor = new THREE.Object3D();
      gripAnchor.name = `${unit.id}-meshy-lod-grip-anchor`;
      gripAnchor.position.fromArray(
        unit.definition.weaponGripPoint || [-0.18, -0.04, 0]
      );
      weaponAnchor.add(muzzleAnchor, gripAnchor);
      unit.visualRoot.add(weaponAnchor);
      unit.marineRig = {
        meshy: true,
        strategic: true,
        weaponAnchor,
        muzzleAnchor,
        gripAnchor,
        rightHand,
        leftHand,
        bakedPoseMetrics,
        state: "ready"
      };
    });
    poseRig.mixer?.stopAllAction?.();
    poseRig.referenceMixer?.stopAllAction?.();

    const sortedUnits = [...units].sort((left, right) => (
      left.position.z - right.position.z
      || left.position.x - right.position.x
    ));
    const batchSize = 3;
    for (let start = 0; start < sortedUnits.length; start += batchSize) {
      const batchUnits = sortedUnits.slice(start, start + batchSize);
      const mesh = new THREE.InstancedMesh(geometry, material, batchUnits.length);
      mesh.name = `meshy-marine-lod-${type}-${start / batchSize + 1}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = true;
      mesh.renderOrder = 11;
      this.unitRoot.add(mesh);
      this.marineLodBatches.push({
        type,
        units: batchUnits,
        mesh,
        modelYaw: batchUnits[0].definition.modelYaw || 0,
        matrix: new THREE.Matrix4(),
        quaternion: new THREE.Quaternion(),
        euler: new THREE.Euler(),
        scale: new THREE.Vector3(1, 1, 1)
      });
    }
    this.updateMeshyMarineLodBatches();
  }

  updateMeshyMarineLodBatches() {
    for (const batch of this.marineLodBatches) {
      batch.units.forEach((unit, index) => {
        const visibleScale = unit.alive ? 1 : 0.00001;
        batch.euler.set(
          0,
          unit.group.rotation.y + (
            unit.visualRoot?.rotation.y
            ?? batch.modelYaw
          ),
          0,
          "YXZ"
        );
        batch.quaternion.setFromEuler(batch.euler);
        batch.scale.setScalar(visibleScale);
        batch.matrix.compose(unit.position, batch.quaternion, batch.scale);
        batch.mesh.setMatrixAt(index, batch.matrix);
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }

  createMarineWeaponBatches() {
    const groups = new Map();
    for (const unit of this.units) {
      if (!unit.marineRig?.weaponAnchor || !this.weaponModels[unit.type]) continue;
      if (!groups.has(unit.type)) groups.set(unit.type, []);
      groups.get(unit.type).push(unit);
    }
    for (const [type, units] of groups) {
      const source = this.weaponModels[type];
      source.updateMatrixWorld(true);
      const sourceMesh = source.getObjectByProperty("isMesh", true);
      if (!sourceMesh) continue;
      const geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);
      const material = Array.isArray(sourceMesh.material)
        ? sourceMesh.material.map((item) => item.clone())
        : sourceMesh.material.clone();
      const mesh = new THREE.InstancedMesh(geometry, material, units.length);
      mesh.name = `meshy-rifle-instances-${type}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 12;
      this.unitRoot.add(mesh);

      const flashGeometry = new THREE.SphereGeometry(0.075, 7, 5);
      const flashMaterial = new THREE.MeshBasicMaterial({
        color: type === "enemyMarine" ? 0xff974f : 0xffd27a,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const flashMesh = new THREE.InstancedMesh(
        flashGeometry,
        flashMaterial,
        units.length
      );
      flashMesh.name = `marine-muzzle-flash-instances-${type}`;
      flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      flashMesh.frustumCulled = false;
      flashMesh.renderOrder = 18;
      this.unitRoot.add(flashMesh);

      this.marineWeaponBatches.push({
        type,
        units,
        mesh,
        flashMesh,
        matrix: new THREE.Matrix4(),
        inverseRoot: new THREE.Matrix4(),
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(),
        unitScale: new THREE.Vector3(1, 1, 1)
      });
    }
    this.updateMarineWeaponBatches();
  }

  updateMarineWeaponBatches() {
    if (!this.marineWeaponBatches.length) return;
    this.unitRoot.updateMatrixWorld(true);
    for (const batch of this.marineWeaponBatches) {
      batch.inverseRoot.copy(this.unitRoot.matrixWorld).invert();
      batch.units.forEach((unit, index) => {
        const alive = unit.alive && Boolean(unit.marineRig?.weaponAnchor);
        if (!alive) {
          batch.matrix.makeScale(0.00001, 0.00001, 0.00001);
          batch.mesh.setMatrixAt(index, batch.matrix);
          batch.flashMesh.setMatrixAt(index, batch.matrix);
          return;
        }
        unit.marineRig.weaponAnchor.updateWorldMatrix(true, false);
        batch.matrix
          .copy(batch.inverseRoot)
          .multiply(unit.marineRig.weaponAnchor.matrixWorld);
        batch.matrix.decompose(
          batch.position,
          batch.quaternion,
          batch.scale
        );
        batch.matrix.compose(
          batch.position,
          batch.quaternion,
          batch.unitScale
        );
        batch.mesh.setMatrixAt(index, batch.matrix);

        unit.marineRig.muzzleAnchor.updateWorldMatrix(true, false);
        batch.matrix
          .copy(batch.inverseRoot)
          .multiply(unit.marineRig.muzzleAnchor.matrixWorld);
        batch.matrix.decompose(
          batch.position,
          batch.quaternion,
          batch.scale
        );
        const flashActive = (
          this.elapsed - unit.lastShotAt >= 0
          && this.elapsed - unit.lastShotAt < 0.065
        );
        batch.unitScale.setScalar(flashActive
          ? 0.8 + Math.sin(this.elapsed * 85) * 0.2
          : 0.00001);
        batch.matrix.compose(
          batch.position,
          batch.quaternion,
          batch.unitScale
        );
        batch.flashMesh.setMatrixAt(index, batch.matrix);
        batch.unitScale.set(1, 1, 1);
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.flashMesh.instanceMatrix.needsUpdate = true;
    }
  }

  createMarineModel(team) {
    const group = new THREE.Group();
    group.name = "procedural-skinned-marine";
    const uniform = new THREE.Color(team === "enemy" ? 0x6a5741 : 0x52684f);
    const armor = new THREE.Color(team === "enemy" ? 0x3f372d : 0x263a32);
    const fabric = new THREE.Color(team === "enemy" ? 0x8a755b : 0x72866a);
    const skin = new THREE.Color(0xa77c62);
    const dark = new THREE.Color(0x151a19);
    const weapon = new THREE.Color(0x202827);
    const parts = [];
    const addPart = (geometry, boneIndex, color) => {
      geometry.deleteAttribute("uv");
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const count = geometry.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      const skinIndices = new Uint16Array(count * 4);
      const skinWeights = new Float32Array(count * 4);
      for (let index = 0; index < count; index += 1) {
        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
        skinIndices[index * 4] = boneIndex;
        skinWeights[index * 4] = 1;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
      geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
      parts.push(geometry);
    };
    const box = (width, height, depth, x, y, z, boneIndex, color) => {
      const geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
      geometry.translate(x, y, z);
      addPart(geometry, boneIndex, color);
    };

    box(0.58, 0.72, 0.32, 0, 1.12, 0, 1, uniform);
    box(0.68, 0.52, 0.42, 0, 1.15, 0.04, 1, armor);
    box(0.46, 0.38, 0.2, 0, 1.1, -0.25, 1, armor);
    const head = new THREE.SphereGeometry(0.22, 10, 7);
    head.translate(0, 1.67, 0.01);
    addPart(head, 2, skin);
    const helmet = new THREE.SphereGeometry(0.255, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62);
    helmet.scale(1.04, 0.76, 1.08);
    helmet.translate(0, 1.78, 0);
    addPart(helmet, 2, armor);
    box(0.16, 0.66, 0.17, -0.39, 1.16, 0, 3, fabric);
    box(0.16, 0.66, 0.17, 0.39, 1.16, 0, 4, fabric);
    box(0.22, 0.72, 0.24, -0.17, 0.48, 0, 5, uniform);
    box(0.22, 0.72, 0.24, 0.17, 0.48, 0, 6, uniform);
    box(0.25, 0.17, 0.4, -0.17, 0.08, 0.09, 5, dark);
    box(0.25, 0.17, 0.4, 0.17, 0.08, 0.09, 6, dark);
    box(0.11, 0.12, 0.92, 0.12, 1.07, 0.58, 7, weapon);
    box(0.23, 0.19, 0.28, 0.12, 1.08, 0.18, 7, weapon);
    box(0.06, 0.27, 0.1, 0.12, 0.94, 0.42, 7, dark);

    const geometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.08,
      emissive: TEAM_EMISSIVE[team],
      emissiveIntensity: 0.16
    });

    const root = new THREE.Bone();
    root.name = "marine-root";
    const torso = new THREE.Bone();
    torso.name = "marine-torso";
    torso.position.set(0, 1.05, 0);
    const headBone = new THREE.Bone();
    headBone.name = "marine-head";
    headBone.position.set(0, 1.56, 0);
    const leftArm = new THREE.Bone();
    leftArm.name = "marine-left-arm";
    leftArm.position.set(-0.39, 1.47, 0);
    const rightArm = new THREE.Bone();
    rightArm.name = "marine-right-arm";
    rightArm.position.set(0.39, 1.47, 0);
    const leftLeg = new THREE.Bone();
    leftLeg.name = "marine-left-leg";
    leftLeg.position.set(-0.17, 0.82, 0);
    const rightLeg = new THREE.Bone();
    rightLeg.name = "marine-right-leg";
    rightLeg.position.set(0.17, 0.82, 0);
    const weaponBone = new THREE.Bone();
    weaponBone.name = "marine-weapon";
    weaponBone.position.set(0.12, 1.07, 0.18);
    root.add(torso, headBone, leftArm, rightArm, leftLeg, rightLeg, weaponBone);

    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = "marine-skinned-mesh";
    mesh.frustumCulled = false;
    mesh.add(root);
    mesh.bind(new THREE.Skeleton([
      root, torso, headBone, leftArm, rightArm, leftLeg, rightLeg, weaponBone
    ]));
    group.add(mesh);

    const muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 7, 5),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    muzzleFlash.name = "marine-muzzle-flash";
    muzzleFlash.position.set(0, 0, 0.9);
    muzzleFlash.visible = false;
    weaponBone.add(muzzleFlash);
    return group;
  }

  initializeMarineRig(unit) {
    if (unit.type !== "marine" && unit.type !== "enemyMarine") return;
    const root = unit.model;
    if (unit.meshyModel) {
      const bones = [];
      root.traverse((child) => {
        if (child.isBone) bones.push(child);
      });
      const findBone = (...patterns) => bones.find((bone) => (
        patterns.some((pattern) => pattern.test(bone.name))
      ));
      const rightHand = findBone(
        /mixamorig.*right.*hand/i,
        /right.*hand/i,
        /hand[_ .-]*r(?:ight)?$/i,
        /^r[_ .-]*hand/i
      );
      const leftHand = findBone(
        /mixamorig.*left.*hand/i,
        /left.*hand/i,
        /hand[_ .-]*l(?:eft)?$/i,
        /^l[_ .-]*hand/i
      );
      const rightShoulder = findBone(
        /mixamorig.*right.*shoulder/i,
        /right.*shoulder/i
      );
      const leftShoulder = findBone(
        /mixamorig.*left.*shoulder/i,
        /left.*shoulder/i
      );
      const rightArm = findBone(
        /mixamorig.*right.*arm$/i,
        /^right.*arm$/i
      );
      const leftArm = findBone(
        /mixamorig.*left.*arm$/i,
        /^left.*arm$/i
      );
      const rightForeArm = findBone(
        /mixamorig.*right.*forearm/i,
        /right.*forearm/i
      );
      const leftForeArm = findBone(
        /mixamorig.*left.*forearm/i,
        /left.*forearm/i
      );
      const spine = findBone(/^spine$/i);
      const spine01 = findBone(/^spine0?1$/i);
      const spine02 = findBone(/^spine0?2$/i);
      const rightHandBindQuaternion = rightHand?.quaternion.clone() || null;
      const leftHandBindQuaternion = leftHand?.quaternion.clone() || null;
      const weaponAnchor = new THREE.Object3D();
      weaponAnchor.name = `${unit.id}-meshy-rifle-anchor`;
      const weaponOffset = unit.definition.weaponOffset || [0, 0, 0];
      const weaponRotation = unit.definition.weaponRotation || [0, -Math.PI / 2, 0];
      const weaponLocalQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler().fromArray(weaponRotation)
      );
      weaponAnchor.position.fromArray(weaponOffset);
      weaponAnchor.quaternion.copy(weaponLocalQuaternion);
      const muzzleAnchor = new THREE.Object3D();
      muzzleAnchor.name = `${unit.id}-meshy-muzzle-anchor`;
      muzzleAnchor.position.fromArray(
        unit.definition.weaponMuzzleOffset || [0.49, 0, 0]
      );
      const gripAnchor = new THREE.Object3D();
      gripAnchor.name = `${unit.id}-meshy-grip-anchor`;
      gripAnchor.position.fromArray(
        unit.definition.weaponGripPoint || [-0.18, -0.04, 0]
      );
      weaponAnchor.add(muzzleAnchor, gripAnchor);
      // Keep the rifle sockets in the unit's unscaled visual space. The skinned
      // character is normalized below this node (about 0.017 world scale); when
      // the socket was parented to RightHand every configured rifle point was
      // compressed into a few millimetres and both hands folded back into the
      // shoulder. The rifle is rendered as an instanced sibling already, so an
      // unscaled control anchor is the correct hierarchy for both visuals and IK.
      (unit.visualRoot || root).add(weaponAnchor);

      const mixer = new THREE.AnimationMixer(root);
      const clips = this.animationClips[unit.type] || {};
      const idleAction = clips.idle ? mixer.clipAction(clips.idle) : null;
      const walkAction = clips.walk ? mixer.clipAction(clips.walk) : null;
      const combatAction = clips.combat ? mixer.clipAction(clips.combat) : null;
      for (const action of [idleAction, walkAction, combatAction]) {
        if (!action) continue;
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      const readyAction = idleAction || combatAction || walkAction;
      const readyPoseFraction = readyAction === combatAction
        ? (unit.definition.readyPoseFraction ?? 0.4)
        : readyAction === walkAction
          ? 0.18
          : 0;
      if (readyAction) {
        readyAction.play();
        if (readyPoseFraction > 0) {
          mixer.setTime(readyAction.getClip().duration * readyPoseFraction);
          readyAction.paused = true;
        }
      }
      const referenceDefinition = this.referenceAnimations[unit.type] || null;
      const referenceRoot = referenceDefinition
        ? cloneSkeleton(referenceDefinition.scene)
        : null;
      let referenceMixer = null;
      let referenceAction = null;
      let referenceNodes = null;
      if (referenceRoot && referenceDefinition?.clip) {
        referenceRoot.traverse((child) => {
          if (child.isMesh || child.isSkinnedMesh) child.visible = false;
        });
        referenceMixer = new THREE.AnimationMixer(referenceRoot);
        referenceAction = referenceMixer.clipAction(referenceDefinition.clip);
        referenceAction.setLoop(THREE.LoopRepeat, Infinity);
        referenceAction.play();
        referenceMixer.setTime(
          unit.definition.combatReferenceWindow?.[0] ?? 0.28
        );
        referenceRoot.updateMatrixWorld(true);
        referenceNodes = {
          body: referenceRoot.getObjectByName("Body"),
          head: referenceRoot.getObjectByName("Head"),
          rightHand: referenceRoot.getObjectByName("handSlotRight"),
          leftHand: referenceRoot.getObjectByName("handSlotLeft")
        };
      }
      unit.marineRig = {
        meshy: true,
        bones,
        rightHand,
        leftHand,
        rightShoulder,
        leftShoulder,
        rightArm,
        leftArm,
        rightForeArm,
        leftForeArm,
        spine,
        spine01,
        spine02,
        rightHandBindQuaternion,
        leftHandBindQuaternion,
        weaponLocalQuaternion,
        weaponAnchor,
        muzzleAnchor,
        gripAnchor,
        mixer,
        idleAction,
        walkAction,
        combatAction,
        referenceRoot,
        referenceMixer,
        referenceAction,
        referenceNodes,
        referenceSource: referenceDefinition?.source || null,
        referenceClipName: referenceDefinition?.clip?.name || null,
        referencePose: null,
        activeAction: readyAction,
        readyPoseFraction,
        restPoseSource: readyAction === idleAction
          ? "idle"
          : readyAction === combatAction
            ? "combat-freeze"
            : readyAction === walkAction
              ? "walk-freeze"
              : "none",
        animationAccumulator: 0,
        lastRequestedState: "ready",
        phase: unit.aiIndex * 0.73,
        state: "ready"
      };
      unit.animationState = "ready";
      unit.animationStatesSeen = new Set(["ready"]);
      return;
    }
    unit.marineRig = {
      meshy: false,
      torso: root.getObjectByName("marine-torso"),
      head: root.getObjectByName("marine-head"),
      leftArm: root.getObjectByName("marine-left-arm"),
      rightArm: root.getObjectByName("marine-right-arm"),
      leftLeg: root.getObjectByName("marine-left-leg"),
      rightLeg: root.getObjectByName("marine-right-leg"),
      weapon: root.getObjectByName("marine-weapon"),
      muzzleFlash: root.getObjectByName("marine-muzzle-flash"),
      phase: unit.aiIndex * 0.73,
      state: "ready"
    };
  }

  solveMarineArmIk(unit, upperArm, foreArm, hand, target, poleTarget = null) {
    if (!unit?.model || !upperArm || !foreArm || !hand || !target) return;
    const joints = [foreArm, upperArm];
    const jointPosition = new THREE.Vector3();
    const effectorPosition = new THREE.Vector3();
    const toEffector = new THREE.Vector3();
    const toTarget = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const parentWorldQuaternion = new THREE.Quaternion();
    const jointWorldQuaternion = new THREE.Quaternion();
    const desiredWorldQuaternion = new THREE.Quaternion();
    const localQuaternion = new THREE.Quaternion();
    const deltaQuaternion = new THREE.Quaternion();

    const rotateJointToward = (joint, effector, destination, maxAngle = 0.48) => {
      unit.model.updateMatrixWorld(true);
      joint.getWorldPosition(jointPosition);
      effector.getWorldPosition(effectorPosition);
      toEffector.subVectors(effectorPosition, jointPosition);
      toTarget.subVectors(destination, jointPosition);
      if (toEffector.lengthSq() < 1e-8 || toTarget.lengthSq() < 1e-8) return;
      toEffector.normalize();
      toTarget.normalize();
      const angle = Math.acos(clamp(toEffector.dot(toTarget), -1, 1));
      if (angle < 0.0005) return;
      axis.crossVectors(toEffector, toTarget);
      if (axis.lengthSq() < 1e-8) return;
      axis.normalize();
      deltaQuaternion.setFromAxisAngle(axis, Math.min(angle, maxAngle));
      joint.getWorldQuaternion(jointWorldQuaternion);
      desiredWorldQuaternion
        .copy(deltaQuaternion)
        .multiply(jointWorldQuaternion);
      joint.parent.getWorldQuaternion(parentWorldQuaternion);
      localQuaternion
        .copy(parentWorldQuaternion)
        .invert()
        .multiply(desiredWorldQuaternion);
      joint.quaternion.copy(localQuaternion).normalize();
    };

    for (let iteration = 0; iteration < 7; iteration += 1) {
      for (const joint of joints) {
        rotateJointToward(joint, hand, target, 0.7);
      }
    }

    if (poleTarget) {
      unit.model.updateMatrixWorld(true);
      const shoulderPosition = upperArm.getWorldPosition(new THREE.Vector3());
      const elbowPosition = foreArm.getWorldPosition(new THREE.Vector3());
      const shoulderToTarget = target.clone().sub(shoulderPosition);
      if (shoulderToTarget.lengthSq() > 1e-8) {
        shoulderToTarget.normalize();
        const currentPole = elbowPosition
          .clone()
          .sub(shoulderPosition)
          .addScaledVector(
            shoulderToTarget,
            -elbowPosition.clone()
              .sub(shoulderPosition)
              .dot(shoulderToTarget)
          );
        const desiredPole = poleTarget
          .clone()
          .sub(shoulderPosition)
          .addScaledVector(
            shoulderToTarget,
            -poleTarget.clone()
              .sub(shoulderPosition)
              .dot(shoulderToTarget)
          );
        if (currentPole.lengthSq() > 1e-8 && desiredPole.lengthSq() > 1e-8) {
          currentPole.normalize();
          desiredPole.normalize();
          const signedAngle = Math.atan2(
            shoulderToTarget.dot(
              currentPole.clone().cross(desiredPole)
            ),
            clamp(currentPole.dot(desiredPole), -1, 1)
          );
          deltaQuaternion.setFromAxisAngle(
            shoulderToTarget,
            clamp(signedAngle, -0.72, 0.72)
          );
          upperArm.getWorldQuaternion(jointWorldQuaternion);
          desiredWorldQuaternion
            .copy(deltaQuaternion)
            .multiply(jointWorldQuaternion);
          upperArm.parent.getWorldQuaternion(parentWorldQuaternion);
          localQuaternion
            .copy(parentWorldQuaternion)
            .invert()
            .multiply(desiredWorldQuaternion);
          upperArm.quaternion.copy(localQuaternion).normalize();
        }
      }
      for (let correction = 0; correction < 3; correction += 1) {
        rotateJointToward(foreArm, hand, target, 0.72);
        rotateJointToward(upperArm, hand, target, 0.42);
      }
    }
    unit.model.updateMatrixWorld(true);
  }

  sampleMarineFireReference(unit, rig) {
    if (
      !rig?.referenceRoot
      || !rig?.referenceMixer
      || !rig?.referenceAction
      || !rig?.referenceNodes?.body
      || !rig?.referenceNodes?.rightHand
      || !rig?.referenceNodes?.leftHand
    ) return null;
    const clip = rig.referenceAction.getClip();
    const configuredWindow = unit.definition.combatReferenceWindow || [0.28, 1.28];
    const start = clamp(Number(configuredWindow[0]) || 0, 0, clip.duration);
    const end = clamp(
      Number(configuredWindow[1]) || clip.duration,
      start + 0.01,
      clip.duration
    );
    const span = Math.max(0.01, end - start);
    const rate = unit.definition.combatReferenceRate || 1.25;
    const phaseOffset = (unit.aiIndex || 0) * 0.071;
    const referenceTime = start + (
      (this.elapsed * rate + phaseOffset) % span
    );
    rig.referenceMixer.setTime(referenceTime);
    rig.referenceRoot.updateMatrixWorld(true);
    const bodyQuaternion = rig.referenceNodes.body.getWorldQuaternion(
      new THREE.Quaternion()
    );
    const rightPosition = rig.referenceNodes.rightHand.getWorldPosition(
      new THREE.Vector3()
    );
    const leftPosition = rig.referenceNodes.leftHand.getWorldPosition(
      new THREE.Vector3()
    );
    const handSpan = leftPosition.distanceTo(rightPosition);
    const recoil = clamp(
      (-rightPosition.z - 0.065) * 0.22,
      -0.012,
      0.012
    );
    rig.referencePose = {
      time: referenceTime,
      recoil,
      handSpan,
      bodyRoll: bodyQuaternion.z,
      source: rig.referenceSource,
      clip: rig.referenceClipName
    };
    return rig.referencePose;
  }

  setMarineWeaponWorldTransform(rig, worldPosition, worldQuaternion) {
    if (!rig?.weaponAnchor?.parent) return;
    const weaponParent = rig.weaponAnchor.parent;
    weaponParent.updateWorldMatrix(true, false);
    const parentWorldQuaternion = weaponParent.getWorldQuaternion(
      new THREE.Quaternion()
    );
    rig.weaponAnchor.position.copy(
      weaponParent.worldToLocal(worldPosition.clone())
    );
    rig.weaponAnchor.quaternion
      .copy(parentWorldQuaternion)
      .invert()
      .multiply(worldQuaternion)
      .normalize();
    // Instanced rifle geometry is authored at its normalized display size.
    // Keeping this control node at world scale 1 also keeps muzzle/grip/stock
    // sockets in the same metre-like coordinate space.
    rig.weaponAnchor.scale.set(1, 1, 1);
    rig.weaponAnchor.updateWorldMatrix(true, true);
  }

  applyMarineReadyWeapon(unit, rig) {
    if (!unit?.model || !rig?.rightHand || !rig?.weaponAnchor) return;
    unit.model.updateMatrixWorld(true);
    const handPosition = rig.rightHand.getWorldPosition(new THREE.Vector3());
    const handQuaternion = rig.rightHand.getWorldQuaternion(
      new THREE.Quaternion()
    );
    const handScale = rig.rightHand.getWorldScale(new THREE.Vector3());
    const weaponOffset = new THREE.Vector3()
      .fromArray(unit.definition.weaponOffset || [0, 0, 0])
      .multiply(handScale)
      .applyQuaternion(handQuaternion);
    const worldQuaternion = handQuaternion
      .clone()
      .multiply(rig.weaponLocalQuaternion || new THREE.Quaternion())
      .normalize();
    this.setMarineWeaponWorldTransform(
      rig,
      handPosition.clone().add(weaponOffset),
      worldQuaternion
    );
  }

  applyMarineShoulderAim(unit, rig) {
    if (
      !unit?.model
      || !rig?.rightShoulder
      || !rig?.rightArm
      || !rig?.rightForeArm
      || !rig?.rightHand
      || !rig?.leftArm
      || !rig?.leftForeArm
      || !rig?.leftHand
      || !rig?.weaponAnchor
    ) return;

    unit.model.updateMatrixWorld(true);
    if (rig.rightHandBindQuaternion) {
      rig.rightHand.quaternion.copy(rig.rightHandBindQuaternion);
    }
    if (rig.leftHandBindQuaternion) {
      rig.leftHand.quaternion.copy(rig.leftHandBindQuaternion);
    }
    const referencePose = this.sampleMarineFireReference(unit, rig);
    unit.model.updateMatrixWorld(true);
    const aimDirection = unit.forward.clone().setY(0);
    if (aimDirection.lengthSq() < 1e-8) return;
    aimDirection.normalize();
    const weaponUp = WORLD_UP.clone();
    const weaponSide = aimDirection.clone().cross(weaponUp).normalize();
    const weaponBasis = new THREE.Matrix4().makeBasis(
      aimDirection,
      weaponUp,
      weaponSide
    );
    const desiredWeaponQuaternion = new THREE.Quaternion()
      .setFromRotationMatrix(weaponBasis);
    const gripPoint = new THREE.Vector3().fromArray(
      unit.definition.weaponGripPoint || [-0.18, -0.04, 0]
    );
    const stockPoint = new THREE.Vector3().fromArray(
      unit.definition.weaponStockPoint || [-0.5, 0.02, 0]
    );
    const rightShoulder = rig.rightShoulder.getWorldPosition(
      new THREE.Vector3()
    );
    const shoulderPocket = rightShoulder
      .clone()
      .addScaledVector(WORLD_UP, -0.018)
      .addScaledVector(weaponSide, -0.012);
    if (referencePose?.recoil) {
      shoulderPocket.addScaledVector(aimDirection, -referencePose.recoil);
    }

    // Seat the stock in world space first. All socket positions now use the
    // normalized 0.86 m rifle dimensions instead of inheriting the tiny skin
    // scale from the character bones.
    const weaponWorldPosition = shoulderPocket
      .clone()
      .sub(stockPoint.clone().applyQuaternion(desiredWeaponQuaternion));
    this.setMarineWeaponWorldTransform(
      rig,
      weaponWorldPosition,
      desiredWeaponQuaternion
    );

    const rightHandTarget = rig.weaponAnchor.localToWorld(gripPoint.clone());
    const leftShoulderPosition = rig.leftShoulder?.getWorldPosition(
      new THREE.Vector3()
    ) || rightShoulder.clone().addScaledVector(weaponSide, 0.42);
    const shoulderSide = rightShoulder.clone().sub(leftShoulderPosition);
    if (shoulderSide.lengthSq() < 1e-8) shoulderSide.copy(weaponSide).negate();
    shoulderSide.normalize();
    const rightPoleTarget = rig.rightForeArm.getWorldPosition(
      new THREE.Vector3()
    )
      .addScaledVector(shoulderSide, 0.24)
      .addScaledVector(WORLD_UP, -0.16);
    this.solveMarineArmIk(
      unit,
      rig.rightArm,
      rig.rightForeArm,
      rig.rightHand,
      rightHandTarget,
      rightPoleTarget
    );

    unit.model.updateMatrixWorld(true);
    const supportTarget = rig.weaponAnchor.localToWorld(
      new THREE.Vector3().fromArray(
        unit.definition.weaponSupportPoint || [0.18, -0.02, 0]
      )
    );
    const leftPoleTarget = rig.leftForeArm.getWorldPosition(
      new THREE.Vector3()
    )
      .addScaledVector(shoulderSide, -0.2)
      .addScaledVector(WORLD_UP, -0.13)
      .addScaledVector(aimDirection, 0.08);
    this.solveMarineArmIk(
      unit,
      rig.leftArm,
      rig.leftForeArm,
      rig.leftHand,
      supportTarget,
      leftPoleTarget
    );
  }

  updateMarineAnimation(unit, delta) {
    const rig = unit.marineRig;
    if (!rig) return;

    /* 걷는 동작은 실제로 "나아간" 만큼만 나오게 한다.
     *
     * currentSpeed 는 내려던 속도다. 지형이나 옆 병사에 막히면 그 값은 남아
     * 있는데 몸은 제자리다. 해안 포대 경비 분대가 그랬다 — 속도는 1.5 라면서
     * 6초에 0.3 밖에 못 갔고 그동안 계속 걸었다.
     *
     * 한 프레임 거리로 재는 것도 부족하다. 막힌 병사는 앞뒤로 떨기 때문에
     * 순간 속도는 커도 앞으로는 못 간다. 그래서 0.5초 동안 실제로 이동한
     * 직선 거리를 본다. 떨림은 상쇄되고 진짜 이동만 남는다. */
    const PROGRESS_WINDOW = 0.5;
    if (!rig.progressAnchor) {
      rig.progressAnchor = unit.position.clone();
      rig.progressAt = this.elapsed;
      rig.progressSpeed = 0;
    } else if (this.elapsed - rig.progressAt >= PROGRESS_WINDOW) {
      const span = Math.max(0.0001, this.elapsed - rig.progressAt);
      rig.progressSpeed = planarDistance(unit.position, rig.progressAnchor) / span;
      rig.progressAnchor.copy(unit.position);
      rig.progressAt = this.elapsed;
    }

    const moving = (
      (rig.progressSpeed || 0) > unit.definition.speed * 0.08
      || this.elapsed < (unit.qaForceCombatWalkUntil || 0)
    );
    const combatReady = (
      unit.order?.type === "attack"
      || unit.order?.type === "attackMove"
      || this.elapsed - unit.lastShotAt < 1.2
    );
    const state = moving
      ? (combatReady ? "rifle-up-walk" : "low-ready-walk")
      : (combatReady ? "aim-fire" : "ready");
    const baseVisualYaw = unit.definition.modelYaw || 0;
    const aimVisualYaw = baseVisualYaw + (
      (combatReady || rig.strategic)
        ? unit.definition.weaponAimYawCorrection || 0
        : 0
    );
    unit.visualRoot.rotation.y += shortestAngle(
      unit.visualRoot.rotation.y,
      aimVisualYaw
    ) * Math.min(1, delta * 8.5);
    if (rig.strategic) {
      rig.state = state;
      unit.animationState = state;
      if (!unit.animationStatesSeen) unit.animationStatesSeen = new Set();
      unit.animationStatesSeen.add(state);
      return;
    }
    if (rig.meshy) {
      rig.animationAccumulator += delta;
      const stateChanged = rig.lastRequestedState !== state;
      rig.lastRequestedState = state;
      const usesExternalFireReference = Boolean(
        rig.referenceAction && rig.referenceNodes
      );
      const desiredAction = state === "ready"
        ? rig.idleAction || rig.combatAction || rig.walkAction
        : combatReady
          ? usesExternalFireReference
            ? rig.walkAction || rig.idleAction || rig.combatAction
            : rig.combatAction || rig.walkAction
          : rig.walkAction || rig.idleAction;
      if (desiredAction && desiredAction !== rig.activeAction) {
        desiredAction.reset().play();
        if (rig.activeAction) {
          desiredAction.crossFadeFrom(rig.activeAction, 0.16, true);
        }
        rig.activeAction = desiredAction;
      }
      if (desiredAction) {
        const referenceAimFreeze = (
          usesExternalFireReference
          && combatReady
          && !moving
        );
        const shouldAnimate = (
          moving
          || (!referenceAimFreeze && combatReady)
          || desiredAction === rig.idleAction
        );
        if (desiredAction.paused === shouldAnimate) {
          desiredAction.paused = !shouldAnimate;
        }
        if (referenceAimFreeze) {
          desiredAction.time = desiredAction.getClip().duration
            * (unit.definition.combatBasePoseFraction ?? 0.18);
          rig.mixer.update(0);
        } else if (!shouldAnimate && state === "ready") {
          desiredAction.time = desiredAction.getClip().duration
            * (rig.readyPoseFraction || 0.18);
          rig.mixer.update(0);
        }
      }
      const animationInterval = unit.team === "ally" ? 1 / 24 : 1 / 18;
      if (stateChanged || rig.animationAccumulator >= animationInterval) {
        rig.mixer.update(rig.animationAccumulator);
        rig.animationAccumulator = 0;
        if (combatReady && unit.definition.weaponStockPoint) {
          this.applyMarineShoulderAim(unit, rig);
        } else {
          this.applyMarineReadyWeapon(unit, rig);
        }
      }
      rig.state = state;
      unit.animationState = state;
      if (!unit.animationStatesSeen) unit.animationStatesSeen = new Set();
      unit.animationStatesSeen.add(state);
      return;
    }
    if (!rig?.leftArm || !rig?.rightArm || !rig?.leftLeg || !rig?.rightLeg) return;
    rig.phase += delta * (moving ? 7.4 : 2.1);
    const stride = moving ? Math.sin(rig.phase) : 0;
    const legSwing = stride * 0.72;
    const armSwing = stride * 0.46;
    rig.leftLeg.rotation.x += (legSwing - rig.leftLeg.rotation.x) * Math.min(1, delta * 11);
    rig.rightLeg.rotation.x += (-legSwing - rig.rightLeg.rotation.x) * Math.min(1, delta * 11);
    const aimingArm = -1.16 + Math.sin(rig.phase * 0.5) * 0.035;
    const leftArmTarget = combatReady ? aimingArm - 0.08 : -armSwing;
    const rightArmTarget = combatReady ? aimingArm : armSwing;
    rig.leftArm.rotation.x += (leftArmTarget - rig.leftArm.rotation.x) * Math.min(1, delta * 12);
    rig.rightArm.rotation.x += (rightArmTarget - rig.rightArm.rotation.x) * Math.min(1, delta * 12);
    rig.leftArm.rotation.z += (
      (combatReady ? -0.18 : 0.04) - rig.leftArm.rotation.z
    ) * Math.min(1, delta * 10);
    rig.rightArm.rotation.z += (
      (combatReady ? 0.12 : -0.04) - rig.rightArm.rotation.z
    ) * Math.min(1, delta * 10);
    const recoilWindow = clamp((this.elapsed - unit.lastShotAt) / 0.12, 0, 1);
    const recoil = this.elapsed - unit.lastShotAt < 0.12
      ? Math.sin(recoilWindow * Math.PI) * 0.18
      : 0;
    const weaponTarget = combatReady ? recoil : 0.58;
    rig.weapon.rotation.x += (weaponTarget - rig.weapon.rotation.x) * Math.min(1, delta * 18);
    rig.torso.rotation.z = moving ? Math.sin(rig.phase * 0.5) * 0.035 : 0;
    rig.head.rotation.y = moving ? Math.sin(rig.phase * 0.35) * 0.06 : 0;
    if (rig.muzzleFlash) {
      rig.muzzleFlash.visible = this.elapsed - unit.lastShotAt >= 0
        && this.elapsed - unit.lastShotAt < 0.065;
      rig.muzzleFlash.scale.setScalar(0.85 + Math.sin(this.elapsed * 85) * 0.24);
    }
    rig.state = state;
    unit.animationState = rig.state;
    if (!unit.animationStatesSeen) unit.animationStatesSeen = new Set();
    unit.animationStatesSeen.add(rig.state);
  }

  createFallbackModel(type, team) {
    if (type === "marine" || type === "enemyMarine") {
      return this.createMarineModel(team);
    }
    const group = new THREE.Group();
    const baseColor = new THREE.Color(
      team === "enemy" ? 0x744638 : team === "civilian" ? 0x758489 : 0x58777d
    );
    const darkColor = new THREE.Color(0x142128);
    const accentColor = new THREE.Color(
      team === "enemy" ? 0xb65a45 : team === "civilian" ? 0xb8c9cc : 0x75c8cf
    );
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.48,
      metalness: 0.45,
      emissive: TEAM_EMISSIVE[team],
      emissiveIntensity: 0.34
    });
    const geometries = [];
    const addGeometry = (sourceGeometry, color = baseColor) => {
      const geometry = sourceGeometry.index
        ? sourceGeometry.toNonIndexed()
        : sourceGeometry;
      if (geometry !== sourceGeometry) sourceGeometry.dispose();
      geometry.deleteAttribute("uv");
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const vertexCount = geometry.getAttribute("position").count;
      const colors = new Float32Array(vertexCount * 3);
      for (let index = 0; index < vertexCount; index += 1) {
        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometries.push(geometry);
      return geometry;
    };
    const box = (width, height, depth, x, y, z, color = baseColor) => {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      geometry.translate(x, y, z);
      return addGeometry(geometry, color);
    };

    if (type === "fighter") {
      const shape = new THREE.Shape();
      shape.moveTo(0, -2.3);
      shape.lineTo(1.7, 1.0);
      shape.lineTo(0.48, 0.65);
      shape.lineTo(0.34, 2.0);
      shape.lineTo(0, 1.45);
      shape.lineTo(-0.34, 2.0);
      shape.lineTo(-0.48, 0.65);
      shape.lineTo(-1.7, 1.0);
      const wing = new THREE.ShapeGeometry(shape);
      wing.rotateX(-Math.PI / 2);
      addGeometry(wing, baseColor);
      const body = new THREE.CylinderGeometry(0.12, 0.28, 3.8, 8);
      body.rotateX(Math.PI / 2);
      body.translate(0, 0.2, 0);
      addGeometry(body, accentColor);
    } else if (type === "bomber") {
      const shape = new THREE.Shape();
      shape.moveTo(0, -2.7);
      shape.lineTo(2.8, 1.1);
      shape.lineTo(1.65, 0.86);
      shape.lineTo(0.82, 1.7);
      shape.lineTo(0, 1.15);
      shape.lineTo(-0.82, 1.7);
      shape.lineTo(-1.65, 0.86);
      shape.lineTo(-2.8, 1.1);
      const wing = new THREE.ShapeGeometry(shape);
      wing.rotateX(-Math.PI / 2);
      addGeometry(wing, baseColor);
      box(0.68, 0.2, 2.6, 0, 0.18, -0.25, accentColor);
      box(1.35, 0.16, 0.55, 0, 0.24, 0.5, darkColor);
    } else if (type === "helicopter") {
      const body = new THREE.SphereGeometry(0.55, 10, 7);
      body.scale(0.86, 0.64, 1.34);
      addGeometry(body, baseColor);
      box(0.16, 0.16, 1.9, 0, 0, 1.3, darkColor);
      const rotorGeometry = mergeGeometries([
        new THREE.BoxGeometry(3.2, 0.018, 0.052),
        new THREE.BoxGeometry(0.052, 0.018, 3.2)
      ]);
      const rotor = new THREE.Mesh(
        rotorGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xa8f8fb,
          transparent: true,
          opacity: 0.48,
          depthWrite: false
        })
      );
      rotor.position.y = 0.7;
      rotor.name = "animated-main-rotor";
      group.add(rotor);
    } else if (type === "mine") {
      addGeometry(new THREE.SphereGeometry(0.42, 12, 8), baseColor);
      const spikeGeometry = new THREE.ConeGeometry(0.11, 0.44, 7);
      const directions = [
        new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
      ];
      for (const direction of directions) {
        const spike = spikeGeometry.clone();
        spike.applyQuaternion(
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
        );
        spike.translate(
          direction.x * 0.57,
          direction.y * 0.57,
          direction.z * 0.57
        );
        addGeometry(spike, accentColor);
      }
      spikeGeometry.dispose();
    } else if (type === "carrier") {
      addGeometry(createShipHullGeometry(8.2, 2.15, 0.72), baseColor);
      box(2.55, 0.18, 7.2, -0.22, 0.82, 0, accentColor);
      box(0.72, 0.9, 1.35, 0.72, 1.32, 0.5, baseColor);
      box(0.34, 0.72, 0.34, 0.72, 2.05, 0.48, darkColor);
      box(1.48, 0.06, 2.2, -0.52, 0.94, -1.45, new THREE.Color(0x3a555a));
      box(1.48, 0.06, 2.2, -0.52, 0.94, 1.35, new THREE.Color(0x3a555a));
    } else if (type === "tanker") {
      addGeometry(createShipHullGeometry(6.6, 2.35, 0.62), baseColor);
      box(1.82, 0.15, 4.75, 0, 0.7, 0, accentColor);
      box(1.52, 0.68, 0.9, 0, 1.0, 2.25, new THREE.Color(0xc7d2d1));
      box(1.2, 0.24, 0.74, 0, 1.45, 2.23, darkColor);
      const stack = new THREE.CylinderGeometry(0.18, 0.22, 0.6, 10);
      stack.translate(0, 1.66, 1.75);
      addGeometry(stack, darkColor);
      for (const z of [-1.55, -0.35, 0.85]) {
        box(1.5, 0.34, 0.78, 0, 0.9, z, baseColor);
      }
      for (const x of [-0.48, 0.48]) {
        const pipe = new THREE.CylinderGeometry(0.065, 0.065, 3.75, 8);
        pipe.rotateX(Math.PI / 2);
        pipe.translate(x, 0.83, -0.36);
        addGeometry(pipe, accentColor);
      }
      box(1.42, 0.12, 3.9, 0, 0.71, -0.36, accentColor);
    } else if (type === "destroyer") {
      addGeometry(createShipHullGeometry(6.2, 1.2, 0.54), baseColor);
      box(0.96, 0.16, 4.1, 0, 0.62, -0.1, accentColor);
      box(0.78, 0.72, 1.05, 0, 1.0, 0.45, baseColor);
      box(0.48, 0.34, 0.62, 0, 1.52, 0.38, darkColor);
      box(0.18, 1.05, 0.18, 0, 2.02, 0.34, accentColor);
      const gun = new THREE.CylinderGeometry(0.24, 0.3, 0.3, 10);
      gun.translate(0, 0.92, -2.1);
      addGeometry(gun, darkColor);
      const barrel = new THREE.CylinderGeometry(0.055, 0.055, 0.85, 8);
      barrel.rotateX(Math.PI / 2);
      barrel.translate(0, 1.06, -2.42);
      addGeometry(barrel, darkColor);
    } else if (type === "usv") {
      addGeometry(createShipHullGeometry(3.2, 0.92, 0.38), baseColor);
      box(0.68, 0.48, 0.88, 0, 0.66, 0.05, darkColor);
      box(0.1, 0.62, 0.1, 0, 1.08, 0.05, accentColor);
      const sensor = new THREE.SphereGeometry(0.16, 8, 6);
      sensor.translate(0, 1.32, 0.05);
      addGeometry(sensor, accentColor);
    } else if (type === "bunkerEntrance") {
      const rockColors = [
        new THREE.Color(0x786449),
        new THREE.Color(0x8b7352),
        new THREE.Color(0x66543f)
      ];
      [
        [-1.52, 0.58, 0.38, 1.34, 0.82, 1.18],
        [1.48, 0.62, 0.42, 1.28, 0.9, 1.12],
        [-1.18, 0.68, 1.25, 1.18, 0.94, 1.08],
        [1.12, 0.72, 1.3, 1.24, 1.02, 1.14],
        [0, 0.88, 1.62, 1.5, 1.12, 0.92]
      ].forEach(([x, y, z, sx, sy, sz], index) => {
        const rock = new THREE.IcosahedronGeometry(0.92, 1);
        rock.scale(sx, sy, sz);
        rock.rotateY(index * 0.72);
        rock.translate(x, y, z);
        addGeometry(rock, rockColors[index % rockColors.length]);
      });
      box(2.72, 0.12, 3.25, 0, 0.1, -1.72, new THREE.Color(0x77746c));
      box(2.92, 0.28, 0.68, 0, 0.32, -0.2, new THREE.Color(0xbeb6a3));
      box(0.38, 1.7, 0.72, -1.28, 1.08, -0.18, new THREE.Color(0xb1a793));
      box(0.38, 1.7, 0.72, 1.28, 1.08, -0.18, new THREE.Color(0xb1a793));
      box(2.94, 0.36, 0.76, 0, 1.82, -0.18, new THREE.Color(0xc5bca7));
      box(1.92, 1.28, 0.24, 0, 1.03, -0.56, new THREE.Color(0x171b1c));
      box(0.12, 1.1, 0.06, -0.42, 1.03, -0.7, new THREE.Color(0xd4aa4b));
      box(0.12, 1.1, 0.06, 0.42, 1.03, -0.7, new THREE.Color(0xd4aa4b));
      box(0.1, 0.06, 2.35, 0, 0.19, -1.78, new THREE.Color(0xe7c35e));
      for (const x of [-0.62, 0.62]) {
        const bollard = new THREE.CylinderGeometry(0.09, 0.11, 0.5, 10);
        bollard.translate(x, 0.32, -2.72);
        addGeometry(bollard, new THREE.Color(0xd8a84e));
      }
      const vent = new THREE.CylinderGeometry(0.22, 0.3, 1.18, 12);
      vent.translate(0.92, 1.74, 1.02);
      addGeometry(vent, darkColor);
    } else if (type === "tel") {
      box(2.35, 0.42, 1.05, 0, 0.45, 0, baseColor);
      box(0.78, 0.62, 0.92, 0, 0.9, 0.55, darkColor);
      const launcher = new THREE.BoxGeometry(1.5, 0.28, 0.82);
      launcher.rotateX(-0.22);
      launcher.translate(0, 1.24, -0.24);
      addGeometry(launcher, accentColor);
      for (const x of [-0.82, 0.82]) {
        for (const z of [-0.34, 0.34]) {
          const wheel = new THREE.CylinderGeometry(0.24, 0.24, 0.18, 10);
          wheel.rotateZ(Math.PI / 2);
          wheel.translate(x, 0.24, z);
          addGeometry(wheel, darkColor);
        }
      }
    } else {
      addGeometry(createShipHullGeometry(2.5, 0.78, 0.36), baseColor);
      box(0.48, 0.42, 0.62, 0, 0.53, 0.15, darkColor);
    }
    const merged = mergeGeometries(geometries, false);
    if (merged) group.add(new THREE.Mesh(merged, material));
    geometries.forEach((geometry) => geometry.dispose());
    return group;
  }

  /**
   * 좌상단 HORMUZ 를 누르면 본편 시작 화면으로 돌아간다.
   *
   * 전투가 이미 시작됐다면 한 번 물어본다. 이 전투 결과는 기록되지 않는다.
   * 본편 안에 iframe 으로 박혀 있을 때는 부모 창을 옮겨야 게임이 중첩되지 않는다.
   */
  bindBrandHome() {
    const brand = document.getElementById("brand-home");
    if (!brand) return;
    brand.addEventListener("click", () => {
      if (this.started && !this.ended && !window.confirm(this.text("confirmLeaveBattle"))) return;
      const target = new URL("index.html", location.href);
      target.searchParams.set("lang", this.lang);
      const viewer = this.embedded && window.parent !== window ? window.parent : window;
      try {
        viewer.location.href = target.href;
      } catch {
        // 부모 창 접근이 막히면 현재 창만이라도 옮긴다.
        window.location.href = target.href;
      }
    });
  }

  bindInput() {
    this.bindBrandHome();
    this.dom.start.addEventListener("click", () => this.startBattle());
    this.dom.retry.addEventListener("click", () => this.retryBattle());
    this.dom.resultContinue.addEventListener("click", () => this.handleResultAction());
    this.dom.requestCongressBudget.addEventListener("click", () => this.openCongressBudget());
    window.addEventListener("resize", () => this.resize());
    this.watchHudMetrics();
    this.canvas.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.cancelPointer(event));
    this.canvas.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener("auxclick", (event) => {
      if (event.button === 1) event.preventDefault();
    });

    document.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => this.handleCommand(button.dataset.command));
    });
    document.querySelectorAll("[data-fleet-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const type = button.closest("[data-fleet-type]")?.dataset.fleetType;
        this.updateFleetSelection(type, Number(button.dataset.fleetStep));
      });
    });

    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
  }

  startBattle() {
    if (!this.initialized || this.started) return;
    const totalUnits = Object.values(this.fleetSelection).reduce((sum, count) => sum + count, 0);
    const requiredFleetType = this.config.battle.requiredFleetType || null;
    if (
      totalUnits === 0
      || (requiredFleetType && this.fleetSelection[requiredFleetType] <= 0)
    ) {
      this.updateFleetBuilder();
      return;
    }
    this.spawnUnits();
    this.initializeRescueMission();
    this.dom.shell.dataset.battleScale = this.config.battle.scale || "standard";
    this.dom.shell.dataset.initialAllyUnits = String(
      this.units.filter((unit) => unit.team === "ally").length
    );
    this.dom.shell.dataset.initialEnemyUnits = String(
      this.units.filter((unit) => unit.team === "enemy").length
    );
    this.dom.shell.dataset.initialCivilianUnits = String(
      this.units.filter((unit) => unit.team === "civilian").length
    );
    this.dom.shell.dataset.initialTotalUnits = String(this.units.length);
    const initialAllies = this.units.filter((unit) => unit.team === "ally" && unit.alive);
    const initialAllyTypes = [...new Set(initialAllies.map((unit) => unit.type))];
    this.dom.shell.dataset.alliedTypeCount = String(initialAllyTypes.length);
    this.dom.shell.dataset.alliedTypes = initialAllyTypes.join("|");
    const landUnits = this.units.filter((unit) => unit.definition.domain === "land");
    this.dom.shell.dataset.landUnitCount = String(landUnits.length);
    this.dom.shell.dataset.landPlacementValid = String(
      landUnits.every((unit) => unit.geographic.onLand)
    );
    this.started = true;
    this.dom.briefing.classList.add("hidden");
    this.dom.status.textContent = this.text("statusEngaged");
    this.selectUnits(
      this.config.battle.scale === "large"
        ? initialAllies.filter((unit) => unit.type === "destroyer")
        : initialAllies
    );
    this.addLog(this.text("statusEngaged"), "good");
    const adaptive = this.config.battle.adaptiveProfile;
    if (adaptive) {
      this.addLog(
        `${this.text("difficultyLabel")} ${adaptive.difficulty}/5 · ${this.text(`difficultyTier${adaptive.difficulty}`)}`,
        adaptive.difficulty >= 4 ? "alert" : "good"
      );
      if (adaptive.counterType) this.addLog(this.text("adaptiveBrief"), "alert");
    }
    this.addLog(this.contactCountdownLine());
    this.audioManager.unlock().then(() => {
      this.startCombatAudioLoops();
      this.playTone("start");
    });
  }

  /** 편성 화면에 머무는 동안 작전 상황 그림을 미리 받아 둔다. */
  warmMissionCueImages() {
    if (this.missionCuesWarmed) return;
    this.missionCuesWarmed = true;
    /* 열 장을 한꺼번에 받는다.
     *
     * 예전에는 한 장이 150~270KB 라 나눠 받아야 했는데, 화면에 뜨는 크기(380px)에
     * 맞춰 줄이고 나니 한 장이 31~62KB, 전부 합쳐도 460KB 다. 줄 세울 이유가
     * 없어졌고, 나눠 받으면 전투가 일찍 시작될 때 뒤쪽 그림이 못 따라온다. */
    for (const url of Object.values(MISSION_CUE_IMAGES)) {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }

  onPointerDown(event) {
    if (!this.started || (this.ended && !this.resultPending)) return;
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      this.beginCameraPan(event);
      return;
    }
    if (event.button !== 0) return;
    this.pointerDown = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType
    };
    this.draggingSelection = false;
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event) {
    if (this.cameraDrag && event.pointerId === this.cameraDrag.pointerId) {
      event.preventDefault();
      const dx = event.clientX - this.cameraDrag.x;
      const dy = event.clientY - this.cameraDrag.y;
      this.cameraDrag.x = event.clientX;
      this.cameraDrag.y = event.clientY;
      this.panCameraByPixels(dx, dy, this.cameraDrag.input);
      return;
    }
    if (!this.pointerDown || event.pointerId !== this.pointerDown.pointerId) return;
    const dx = event.clientX - this.pointerDown.x;
    const dy = event.clientY - this.pointerDown.y;
    if (Math.hypot(dx, dy) < 7 || this.pointerDown.pointerType === "touch") return;
    this.draggingSelection = true;
    const left = Math.min(this.pointerDown.x, event.clientX);
    const top = Math.min(this.pointerDown.y, event.clientY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    Object.assign(this.selectionBox.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    });
    this.selectionBox.hidden = false;
  }

  onPointerUp(event) {
    if (this.cameraDrag && event.pointerId === this.cameraDrag.pointerId) {
      event.preventDefault();
      this.endCameraPan(event);
      return;
    }
    if (!this.pointerDown || event.pointerId !== this.pointerDown.pointerId) return;
    const origin = this.pointerDown;
    this.canvas.releasePointerCapture?.(event.pointerId);
    if (this.draggingSelection) {
      this.selectByRectangle(origin.x, origin.y, event.clientX, event.clientY, event.shiftKey);
    } else {
      this.handlePrimaryClick(event, origin.pointerType);
    }
    this.cancelPointer();
  }

  cancelPointer(event = null) {
    if (this.cameraDrag) this.endCameraPan(event);
    this.pointerDown = null;
    this.draggingSelection = false;
    this.selectionBox.hidden = true;
  }

  beginCameraPan(event) {
    this.cancelPointer();
    this.cameraFollowUnit = null;
    this.cameraDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      input: event.button === 1 ? "middle-drag" : "alt-left-drag"
    };
    this.canvas.setPointerCapture?.(event.pointerId);
    this.dom.shell.classList.add("camera-panning");
    this.dom.shell.dataset.cameraPanActive = "true";
    this.dom.shell.dataset.cameraPanInput = this.cameraDrag.input;
  }

  endCameraPan(event = null) {
    if (!this.cameraDrag) return;
    const pointerId = event?.pointerId ?? this.cameraDrag.pointerId;
    this.canvas.releasePointerCapture?.(pointerId);
    this.cameraDrag = null;
    this.dom.shell.classList.remove("camera-panning");
    this.dom.shell.dataset.cameraPanActive = "false";
  }

  clampCameraFocus() {
    const bounds = this.config.battle.bounds;
    this.cameraFocus.x = clamp(this.cameraFocus.x, bounds.minX, bounds.maxX);
    this.cameraFocus.z = clamp(this.cameraFocus.z, bounds.minZ, bounds.maxZ);
  }

  panCameraByPixels(dx, dy, input = "api") {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const pixelDistance = Math.hypot(dx, dy);
    if (pixelDistance < 0.01) return;
    const viewDistance = Math.hypot(this.cameraHeight, this.cameraDistance);
    const worldPerPixel = (
      2
      * viewDistance
      * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
      / Math.max(1, this.canvas.clientHeight)
    );
    this.cameraFollowUnit = null;
    this.cameraFocus.x -= dx * worldPerPixel;
    this.cameraFocus.z -= dy * worldPerPixel;
    this.clampCameraFocus();
    this.cameraPanStats.count += 1;
    this.cameraPanStats.distance += pixelDistance;
    this.cameraPanStats.input = input;
    this.dom.shell.dataset.cameraPanCount = String(this.cameraPanStats.count);
    this.dom.shell.dataset.cameraPanDistance = this.cameraPanStats.distance.toFixed(1);
    this.dom.shell.dataset.cameraPanFocus = [
      this.cameraFocus.x.toFixed(2),
      this.cameraFocus.z.toFixed(2)
    ].join(",");
    this.updateCameraPosition(true);
  }

  handlePrimaryClick(event, pointerType) {
    const hitUnit = this.pickUnit(event.clientX, event.clientY);
    this.dom.shell.dataset.lastPrimaryPick = hitUnit?.id || "none";
    this.dom.shell.dataset.lastPrimaryPickMode = this.lastPickMode || "none";
    if (hitUnit) {
      if (
        this.commandMode === "attackMove"
        && hitUnit.team === "enemy"
        && this.selected.size
      ) {
        this.issueAttack(hitUnit);
        this.setCommandMode(null);
        return;
      }
      if (hitUnit.team === "ally") {
        this.selectUnits([hitUnit], event.shiftKey);
      } else if (hitUnit.team === "enemy") {
        this.inspectEnemies([hitUnit]);
      }
      return;
    }
    const ground = this.pickGround(event.clientX, event.clientY);
    if (this.commandMode === "attackMove" && ground) {
      this.issueMove(ground, true);
      this.setCommandMode(null);
      return;
    }
    if (pointerType === "touch" && ground && this.selected.size) {
      this.issueMove(ground, false);
      return;
    }
    if (!event.shiftKey) this.clearSelection();
  }

  onDoubleClick(event) {
    if (
      !this.started
      || (this.ended && !this.resultPending)
      || event.button !== 0
    ) return;
    event.preventDefault();
    const hitUnit = this.pickUnit(event.clientX, event.clientY);
    if (!hitUnit || !hitUnit.alive) return;
    const matchingUnits = this.units.filter((unit) => (
      unit.alive
      && unit.team === hitUnit.team
      && unit.type === hitUnit.type
      && this.isUnitOnScreen(unit)
    ));
    if (hitUnit.team === "ally") {
      this.selectUnits(matchingUnits);
    } else if (hitUnit.team === "enemy") {
      this.inspectEnemies(matchingUnits);
    }
    this.dom.shell.dataset.lastDoubleClickSelection = (
      `${hitUnit.team}:${hitUnit.type}:${matchingUnits.length}`
    );
  }

  isUnitOnScreen(unit) {
    const point = unit.group.position.clone().project(this.camera);
    return (
      point.z > -1
      && point.z < 1
      && point.x >= -1
      && point.x <= 1
      && point.y >= -1
      && point.y <= 1
    );
  }

  onContextMenu(event) {
    event.preventDefault();
    if (
      !this.started
      || (this.ended && !this.resultPending)
      || !this.selected.size
    ) return;
    const hitUnit = this.pickUnit(event.clientX, event.clientY);
    if (hitUnit?.team === "enemy") {
      this.issueAttack(hitUnit);
      return;
    }
    const ground = this.pickGround(event.clientX, event.clientY);
    if (ground) this.issueMove(ground, false);
  }

  selectByRectangle(x1, y1, x2, y2, additive) {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    const rect = this.canvas.getBoundingClientRect();
    const matches = this.units.filter((unit) => {
      if (!unit.alive || unit.team !== "ally") return false;
      const projected = unit.group.position.clone().project(this.camera);
      const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
      return projected.z > -1 && projected.z < 1 && x >= left && x <= right && y >= top && y <= bottom;
    });
    this.selectUnits(matches, additive);
  }

  setPointerNdc(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
  }

  pickUnit(clientX, clientY) {
    this.setPointerNdc(clientX, clientY);
    const intersects = this.raycaster.intersectObjects(
      this.units.filter((unit) => unit.alive).map((unit) => unit.group),
      true
    );
    for (const hit of intersects) {
      const unit = hit.object.userData.unit;
      if (unit?.alive) {
        this.lastPickMode = "raycast";
        return unit;
      }
    }
    const rect = this.canvas.getBoundingClientRect();
    let closestUnit = null;
    let closestDistance = Infinity;
    let nearestDebug = null;
    for (const unit of this.units) {
      if (!unit.alive) continue;
      const center = unit.group.position.clone();
      center.y += unit.definition.desiredSize * 0.32;
      const edge = center.clone().add(
        new THREE.Vector3(unit.definition.desiredSize * 0.5, 0, 0)
      );
      center.project(this.camera);
      edge.project(this.camera);
      if (
        center.z <= -1
        || center.z >= 1
        || center.x < -1.08
        || center.x > 1.08
        || center.y < -1.08
        || center.y > 1.08
      ) continue;
      const x = rect.left + (center.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-center.y * 0.5 + 0.5) * rect.height;
      const edgeX = rect.left + (edge.x * 0.5 + 0.5) * rect.width;
      const edgeY = rect.top + (-edge.y * 0.5 + 0.5) * rect.height;
      const pickRadius = clamp(
        Math.hypot(edgeX - x, edgeY - y) * 1.35,
        28,
        120
      );
      const distance = Math.hypot(clientX - x, clientY - y);
      if (!nearestDebug || distance < nearestDebug.distance) {
        nearestDebug = {
          id: unit.id,
          x: Math.round(x),
          y: Math.round(y),
          z: Number(center.z.toFixed(3)),
          radius: Math.round(pickRadius),
          distance: Math.round(distance)
        };
      }
      if (distance <= pickRadius && distance < closestDistance) {
        closestDistance = distance;
        closestUnit = unit;
      }
    }
    this.dom.shell.dataset.lastPickDebug = nearestDebug
      ? `${Math.round(clientX)},${Math.round(clientY)}|${nearestDebug.id}:${nearestDebug.x},${nearestDebug.y},z${nearestDebug.z},r${nearestDebug.radius},d${nearestDebug.distance}`
      : `${Math.round(clientX)},${Math.round(clientY)}|none`;
    this.lastPickMode = closestUnit ? "screen-fallback" : "none";
    return closestUnit;
  }

  pickGround(clientX, clientY) {
    this.setPointerNdc(clientX, clientY);
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, point) ? point : null;
  }

  selectUnits(units, additive = false) {
    this.inspectedEnemies.clear();
    this.dom.shell.dataset.inspectedEnemyCount = "0";
    this.dom.shell.dataset.inspectedEnemyIds = "";
    if (!additive) this.selected.clear();
    for (const unit of units) {
      if (!unit.alive || unit.team !== "ally") continue;
      if (additive && this.selected.has(unit)) this.selected.delete(unit);
      else this.selected.add(unit);
    }
    this.syncSelectionVisuals();
  }

  inspectEnemies(units) {
    this.selected.clear();
    this.inspectedEnemies.clear();
    for (const unit of units) {
      if (!unit.alive || unit.team !== "enemy") continue;
      this.inspectedEnemies.add(unit);
    }
    this.dom.shell.dataset.inspectedEnemyCount = String(this.inspectedEnemies.size);
    this.dom.shell.dataset.inspectedEnemyIds = [...this.inspectedEnemies]
      .map((unit) => unit.id)
      .join(",");
    this.syncSelectionVisuals();
    this.showHint(
      this.inspectedEnemies.size > 1
        ? this.text("enemyGroupInspectHint").replace(
          "{count}",
          String(this.inspectedEnemies.size)
        )
        : this.text("enemyInspectHint")
    );
  }

  clearSelection() {
    this.selected.clear();
    this.inspectedEnemies.clear();
    this.dom.shell.dataset.inspectedEnemyCount = "0";
    this.dom.shell.dataset.inspectedEnemyIds = "";
    this.syncSelectionVisuals();
  }

  syncSelectionVisuals() {
    for (const unit of [...this.inspectedEnemies]) {
      if (!unit.alive) this.inspectedEnemies.delete(unit);
    }
    const selectedCount = this.selected.size + this.inspectedEnemies.size;
    for (const unit of this.units) {
      const selected = this.selected.has(unit) || this.inspectedEnemies.has(unit);
      unit.selected = selected;
      unit.selectionRing.visible = (
        selected
        && unit.alive
        && (this.config.battle.scale !== "large" || selectedCount <= 6)
      );
      unit.rangeRing.visible = (
        selected
        && selectedCount <= 6
        && unit.alive
        && unit.definition.range > 0
      );
      unit.label?.classList.toggle("selected", selected && unit.alive);
    }
    this.renderForceList();
    this.renderSelectionSummary();
    this.updateCommandButtons();
  }

  handleCommand(command) {
    if (command === "pause") {
      this.togglePause();
      return;
    }
    if (!this.started || (this.ended && !this.resultPending)) return;
    if (command === "autoBattle") {
      this.setAutoBattleEnabled(!this.autoBattleEnabled);
    } else if (command === "selectAll") {
      this.selectUnits(this.units.filter((unit) => unit.team === "ally" && unit.alive));
    } else if (command === "attackMove") {
      this.disableAutoBattleForManualCommand();
      this.setCommandMode(this.commandMode === "attackMove" ? null : "attackMove");
    } else if (command === "hold") {
      this.issueHold();
    } else if (command === "stop") {
      this.issueStop();
    } else if (command === "retreat") {
      this.issueRetreat();
    }
  }

  updateAutoBattleButton() {
    const button = this.dom?.autoBattle;
    if (!button) return;
    button.classList.toggle("active", this.autoBattleEnabled);
    button.setAttribute("aria-pressed", String(this.autoBattleEnabled));
    button.setAttribute(
      "aria-label",
      this.text(this.autoBattleEnabled ? "autoBattleOn" : "autoBattleOff")
    );
    this.dom.shell.dataset.autoBattle = this.autoBattleEnabled ? "on" : "off";
  }

  setAutoBattleEnabled(enabled, { announce = true } = {}) {
    const next = Boolean(enabled) && this.started && !this.ended;
    if (next === this.autoBattleEnabled) {
      this.updateAutoBattleButton();
      return;
    }
    this.autoBattleEnabled = next;
    this.setCommandMode(null);
    this.updateAutoBattleButton();
    if (next) {
      for (const unit of this.units) {
        if (unit.team !== "ally" || !unit.alive) continue;
        unit.nextAutoDecisionAt = -Infinity;
        unit.autoAttackRun = null;
        unit.order = {
          type: "hold",
          autoBattle: true,
          autoBattleReset: true
        };
      }
      this.selectUnits(this.units.filter((unit) => unit.team === "ally" && unit.alive));
    } else {
      for (const unit of this.units) {
        if (unit.team === "ally") unit.autoAttackRun = null;
      }
    }
    if (announce) {
      const key = next ? "autoBattleHintOn" : "autoBattleHintOff";
      this.showHint(this.text(key));
      this.addLog(this.text(key), next ? "good" : "");
      this.playTone("command");
    }
  }

  disableAutoBattleForManualCommand() {
    if (!this.autoBattleEnabled) return;
    this.setAutoBattleEnabled(false);
  }

  setCommandMode(mode) {
    this.commandMode = mode;
    document.querySelector("[data-command='attackMove']")?.classList.toggle("active", mode === "attackMove");
    if (mode === "attackMove") this.showHint(this.text("commandAttackMove"));
  }

  resumeStaticQaForCommand() {
    if (!this.paused || this.params.get("qa") !== "strategic-visibility") return;
    this.paused = false;
    this.dom.status.textContent = this.text("statusEngaged");
    document.getElementById("cmd-pause").textContent = this.text("pause");
    document.querySelector("[data-command='pause']")?.classList.remove("active");
    this.dom.shell.dataset.staticQaResumed = "true";
  }

  issueMove(point, attackMove) {
    this.disableAutoBattleForManualCommand();
    this.resumeStaticQaForCommand();
    const units = [...this.selected].filter((unit) => unit.alive);
    if (!units.length) return;
    const columns = Math.ceil(Math.sqrt(units.length));
    units.forEach((unit, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const offset = new THREE.Vector3(
        (column - (columns - 1) * 0.5) * 2.4,
        0,
        (row - (Math.ceil(units.length / columns) - 1) * 0.5) * 2.4
      );
      let target = point.clone().add(offset);
      target.x = clamp(target.x, this.config.battle.bounds.minX, this.config.battle.bounds.maxX);
      target.z = clamp(target.z, this.config.battle.bounds.minZ, this.config.battle.bounds.maxZ);
      if (unit.definition.domain === "sea") {
        target = this.resolveSeaCommandTarget(unit, target);
      } else if (unit.definition.domain === "land") {
        target = this.resolveLandCommandTarget(unit, target);
      }
      unit.order = {
        type: attackMove ? "attackMove" : "move",
        targetPos: target,
        resumePos: attackMove ? target.clone() : null,
        issuedAt: this.elapsed
      };
      if (unit.definition.domain === "sea" && unit.definition.speed > 0) {
        const commandDirection = target.clone().sub(unit.position).setY(0);
        if (commandDirection.lengthSq() > 0.0001) {
          const commandHeading = Math.atan2(commandDirection.x, commandDirection.z);
          unit.group.rotation.y += shortestAngle(
            unit.group.rotation.y,
            commandHeading
          ) * 0.2;
          unit.forward.set(
            Math.sin(unit.group.rotation.y),
            0,
            Math.cos(unit.group.rotation.y)
          );
        }
        unit.currentSpeed = Math.max(
          unit.currentSpeed,
          unit.definition.speed * 0.18
        );
        unit.velocity.copy(unit.forward).multiplyScalar(unit.currentSpeed);
      }
      if (unit.definition.domain === "air") unit.loiterAnchor = null;
    });
    this.lastCommand = attackMove ? "attackMove" : "move";
    this.dom.shell.dataset.lastCommand = this.lastCommand;
    this.dom.shell.dataset.lastCommandUnitCount = String(units.length);
    this.dom.shell.dataset.lastCommandTarget = [
      point.x.toFixed(2),
      point.z.toFixed(2)
    ].join(",");
    this.addOrderMarker(point, attackMove ? "attack" : "move");
    this.showHint(this.text(attackMove ? "commandAttackMove" : "commandMove"));
    this.playTone("command");
  }

  issueAttack(target) {
    this.disableAutoBattleForManualCommand();
    this.resumeStaticQaForCommand();
    if (!target?.alive || target.team !== "enemy") return;
    for (const unit of this.selected) {
      if (
        !unit.alive
        || unit.definition.damage <= 0
        || !this.canUnitAttackTarget(unit, target)
      ) continue;
      unit.order = { type: "attack", targetUnit: target };
      if (
        unit.definition.weapon === "bunkerBomb"
        && unit.shotsFired > 0
        && unit.shotsFired < (unit.definition.maxShots || 2)
        && Number.isFinite(unit.nextShotAt)
      ) {
        unit.nextShotAt = Math.min(unit.nextShotAt, this.elapsed + 1.2);
      }
    }
    this.lastCommand = `attack:${target.id}`;
    this.dom.shell.dataset.lastCommand = this.lastCommand;
    this.dom.shell.dataset.lastCommandUnitCount = String(this.selected.size);
    this.dom.shell.dataset.lastCommandTarget = target.id;
    this.addOrderMarker(target.group.position, "attack");
    this.showHint(`${this.text("commandAttack")} · ${target.callsign}`);
    this.showMissionCue("targetLock", "cueTargetLock");
    this.playTone("command");
  }

  issueHold() {
    this.disableAutoBattleForManualCommand();
    for (const unit of this.selected) {
      unit.order = { type: "hold", anchor: unit.group.position.clone() };
    }
    this.lastCommand = "hold";
    this.showHint(this.text("commandHold"));
  }

  issueStop() {
    this.disableAutoBattleForManualCommand();
    for (const unit of this.selected) unit.order = { type: "stop" };
    this.lastCommand = "stop";
    this.showHint(this.text("commandStop"));
  }

  issueRetreat() {
    this.disableAutoBattleForManualCommand();
    const exit = this.project(55.34, 26.12, 0);
    this.issueMove(exit, false);
    for (const unit of this.selected) unit.order.retreat = true;
    this.lastCommand = "retreat";
    this.showHint(this.text("commandRetreat"));
  }

  onKeyDown(event) {
    if (["Space", "KeyA", "KeyB", "KeyH", "KeyS", "KeyR", "KeyF", "Home", "F1"].includes(event.code)) event.preventDefault();
    if (event.code === "Space" && !event.repeat) {
      this.togglePause();
      return;
    }
    if (!this.started || (this.ended && !this.resultPending)) return;
    if (event.code === "KeyB" && !event.repeat) this.setAutoBattleEnabled(!this.autoBattleEnabled);
    else if (event.code === "KeyA" && !event.repeat) {
      this.disableAutoBattleForManualCommand();
      this.setCommandMode("attackMove");
    }
    else if (event.code === "KeyH" && !event.repeat) this.issueHold();
    else if (event.code === "KeyS" && !event.repeat) this.issueStop();
    else if (event.code === "KeyR" && !event.repeat) this.issueRetreat();
    else if (event.code === "KeyF" && !event.repeat) this.focusSelectedUnits();
    else if (event.code === "Home" && !event.repeat) this.resetCameraOverview();
    else if (event.code === "F1" && !event.repeat) {
      this.selectUnits(this.units.filter((unit) => unit.team === "ally" && unit.alive));
    } else if (/^Digit[1-5]$/.test(event.code)) {
      const number = Number(event.code.slice(-1));
      if (event.ctrlKey) {
        this.commandGroups.set(number, [...this.selected].map((unit) => unit.id));
        this.showHint(`${this.text("groupSaved")} ${number}`);
      } else {
        const ids = this.commandGroups.get(number) || [];
        this.selectUnits(ids.map((id) => this.units.find((unit) => unit.id === id)).filter(Boolean));
      }
    }
    this.keys.add(event.code);
  }

  focusSelectedUnits() {
    const units = [...this.selected, ...this.inspectedEnemies]
      .filter((unit) => unit.alive);
    if (!units.length) return;
    const primary = units[0];
    this.cameraFollowUnit = primary;
    this.cameraFocus.copy(primary.position).setY(0);
    this.cameraHeight = primary.definition.domain === "air" ? 10 : 12;
    this.cameraDistance = primary.definition.domain === "air" ? 8 : 10;
    this.updateCameraPosition();
    this.showHint(this.text("cameraFocus"));
  }

  resetCameraOverview() {
    this.cameraFollowUnit = null;
    this.cameraFocus.copy(this.project(
      this.config.battle.camera.centerLon,
      this.config.battle.camera.centerLat,
      0
    ));
    this.cameraHeight = this.config.battle.camera.height;
    this.cameraDistance = this.config.battle.camera.distance;
    this.updateCameraPosition();
    this.showHint(this.text("cameraOverview"));
  }

  togglePause() {
    if (!this.started || this.ended) return;
    this.paused = !this.paused;
    this.dom.status.textContent = this.text(this.paused ? "statusPaused" : "statusEngaged");
    document.getElementById("cmd-pause").textContent = this.text(this.paused ? "resume" : "pause");
    document.querySelector("[data-command='pause']")?.classList.toggle("active", this.paused);
    this.showHint(this.text(this.paused ? "statusPaused" : "statusEngaged"));
    this.playTone(this.paused ? "pause" : "command");
  }

  onWheel(event) {
    event.preventDefault();
    if (!this.started) return;
    const minimumHeight = this.config.battle.camera.height * this.cameraWheelZoomInLimit;
    const minimumDistance = this.config.battle.camera.distance * this.cameraWheelZoomInLimit;
    let nextHeight = clamp(
      this.cameraHeight + event.deltaY * 0.025,
      minimumHeight,
      76
    );
    let nextDistance = clamp(
      this.cameraDistance + event.deltaY * 0.02,
      minimumDistance,
      68
    );
    if (this.googleBattleMap?.active) {
      const maximumViewDistance = this.googleBattleMap.getWorldViewLimits().max;
      const requestedViewDistance = Math.hypot(nextHeight, nextDistance);
      const currentViewDistance = Math.hypot(this.cameraHeight, this.cameraDistance);
      if (currentViewDistance > maximumViewDistance + 0.01) {
        const scale = maximumViewDistance / requestedViewDistance;
        nextHeight *= scale;
        nextDistance *= scale;
      } else if (event.deltaY > 0 && currentViewDistance >= maximumViewDistance - 0.01) {
        nextHeight = this.cameraHeight;
        nextDistance = this.cameraDistance;
      } else if (requestedViewDistance > maximumViewDistance) {
        const scale = maximumViewDistance / requestedViewDistance;
        nextHeight *= scale;
        nextDistance *= scale;
      }
      this.dom.shell.dataset.googleBattleMaximumWorldView = maximumViewDistance.toFixed(3);
    }
    this.cameraHeight = nextHeight;
    this.cameraDistance = nextDistance;
    this.updateCameraPosition(true);
  }

  updateCameraPosition(forceGoogleSync = false) {
    // 세로 화면에서는 좁아진 가로 시야를 메우려고 카메라를 더 물린다.
    // 배율은 resize() 가 화면비에서 계산해 둔다. 확대·추적 값은 그대로 두고
    // 그리는 순간에만 곱해, 휠 확대 한계 같은 기존 규칙이 흔들리지 않게 한다.
    const scale = this.cameraFrameScale || 1;
    const tilt = this.cameraTilt || 1;
    const height = this.cameraHeight * scale * tilt;
    const distance = this.cameraDistance * scale / tilt;
    this.camera.position.set(
      this.cameraFocus.x,
      this.cameraFocus.y + height,
      this.cameraFocus.z + distance
    );
    this.camera.lookAt(this.cameraFocus);
    this.googleBattleMap?.syncCamera(
      this.cameraFocus,
      height,
      distance,
      this.camera.fov,
      forceGoogleSync
    );
  }

  updateCamera(delta) {
    const manualPan = this.keys.has("KeyI")
      || this.keys.has("ArrowUp")
      || this.keys.has("KeyK")
      || this.keys.has("ArrowDown")
      || this.keys.has("KeyJ")
      || this.keys.has("ArrowLeft")
      || this.keys.has("KeyL")
      || this.keys.has("ArrowRight");
    if (manualPan) this.cameraFollowUnit = null;
    if (this.cameraFollowUnit?.alive) {
      const follow = Math.min(1, delta * 4.6);
      this.cameraFocus.x += (this.cameraFollowUnit.position.x - this.cameraFocus.x) * follow;
      this.cameraFocus.z += (this.cameraFollowUnit.position.z - this.cameraFocus.z) * follow;
    }
    const pan = 21 * delta;
    if (this.keys.has("KeyI") || this.keys.has("ArrowUp")) this.cameraFocus.z -= pan;
    if (this.keys.has("KeyK") || this.keys.has("ArrowDown")) this.cameraFocus.z += pan;
    if (this.keys.has("KeyJ") || this.keys.has("ArrowLeft")) this.cameraFocus.x -= pan;
    if (this.keys.has("KeyL") || this.keys.has("ArrowRight")) this.cameraFocus.x += pan;
    this.clampCameraFocus();
    this.updateCameraPosition();
    if (this.cameraShake > 0.002) {
      this.cameraShakePhase += delta * 44;
      const shakeX = Math.sin(this.cameraShakePhase) * this.cameraShake;
      const shakeY = Math.cos(this.cameraShakePhase * 1.37) * this.cameraShake * 0.34;
      const shakeZ = Math.sin(this.cameraShakePhase * 0.73) * this.cameraShake * 0.48;
      this.camera.position.x += shakeX;
      this.camera.position.y += shakeY;
      this.camera.position.z += shakeZ;
      this.googleBattleMap?.syncShake(
        shakeX,
        shakeY,
        shakeZ,
        this.cameraShake,
        this.cameraHeight,
        this.cameraDistance
      );
      this.cameraShake *= Math.exp(-delta * 6.8);
    } else {
      this.cameraShake = 0;
      this.googleBattleMap?.syncShake(
        0,
        0,
        0,
        0,
        this.cameraHeight,
        this.cameraDistance
      );
    }
  }

  updateUnits(delta, nowSeconds) {
    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (unit.team === "civilian") {
        this.updateConvoyUnit(unit, delta);
      } else {
        if (unit.team === "enemy") this.updateEnemyAi(unit);
        if (unit.team === "ally" && this.autoBattleEnabled) this.updateAllyAutoAi(unit);
        this.updateCombatUnit(unit, delta, nowSeconds);
      }
      unit.selectionRing.rotation.z += delta * 0.48;
      const selectionPulse = unit.selected
        ? 1 + Math.sin(this.elapsed * 4.6 + unit.aiIndex * 0.7) * 0.055
        : 1;
      unit.selectionRing.scale.setScalar(selectionPulse);
      unit.rangeRing.rotation.z -= delta * 0.05;
      this.updateMarineAnimation(unit, delta);
      this.updateUnitWake(unit, delta);
    }
    this.resolveUnitCollisions();
  }

  updateRotors(delta) {
    for (const unit of this.units) {
      if (!unit.alive) continue;
      for (const rotor of unit.rotors || []) {
        rotor.object.rotation.y = (rotor.object.rotation.y + delta * rotor.speed) % (Math.PI * 2);
      }
    }
  }

  initializeRescueMission() {
    if (this.scenarioId !== "tanker_rescue" || this.rescueMarker) return;
    this.rescueTarget = this.units.find((unit) => unit.rescueTarget) || null;
    if (!this.rescueTarget) return;
    const radius = this.config.battle.rescueRadius || 4.8;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.82, radius, 72),
      new THREE.MeshBasicMaterial({
        color: 0xffc45b,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 28;
    const field = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.8, 72),
      new THREE.MeshBasicMaterial({
        color: 0xffc45b,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide
      })
    );
    field.rotation.x = -Math.PI / 2;
    field.renderOrder = 27;
    group.add(field, ring);
    group.position.copy(this.rescueTarget.position);
    group.position.y = 0.24;
    this.effectRoot.add(group);
    this.rescueMarker = { group, ring, field };
    this.dom.shell.dataset.rescueStage = this.rescueStage;
    this.dom.shell.dataset.rescueTarget = this.rescueTarget.id;
    this.addLog(this.text("rescueStageIntercept"), "alert");
    this.showHint(this.text("rescueStageIntercept"));
  }

  setRescueStage(stage) {
    if (this.rescueStage === stage) return;
    this.rescueStage = stage;
    this.dom.shell.dataset.rescueStage = stage;
    if (!this.rescueMarker) return;
    const color = stage === "approach"
      ? 0x67e8f2
      : stage === "egress"
        ? 0x76f3a7
        : 0xffc45b;
    this.rescueMarker.ring.material.color.setHex(color);
    this.rescueMarker.field.material.color.setHex(color);
  }

  updateRescueMission(delta) {
    if (
      this.scenarioId !== "tanker_rescue"
      || !this.rescueTarget
      || !this.rescueTarget.alive
    ) return;
    const marker = this.rescueMarker;
    if (marker) {
      marker.group.position.x = this.rescueTarget.position.x;
      marker.group.position.z = this.rescueTarget.position.z;
      const pulse = 1 + Math.sin(this.elapsed * 3.2) * 0.055;
      marker.group.scale.setScalar(pulse);
      marker.ring.rotation.z += delta * 0.34;
      marker.ring.material.opacity = 0.56 + Math.sin(this.elapsed * 4.1) * 0.12;
    }

    if (this.rescueStage === "intercept" && this.getAliveForceCount("enemy") === 0) {
      this.setRescueStage("approach");
      this.addLog(this.text("rescueInterceptComplete"), "good");
      this.showHint(this.text("rescueInterceptComplete"));
      this.showMissionCue("reentry", "cueRescueApproach", 7000);
    }

    if (this.rescueStage === "approach") {
      const helicopters = this.units.filter((unit) => (
        unit.alive && unit.team === "ally" && unit.type === "helicopter"
      ));

      /* ★ 적을 다 잡아도 전투가 안 끝난다는 신고의 실제 원인이 여기였다.
       *
       *   적 전멸은 승리 조건이 아니라 승선 단계로 넘어가는 조건일 뿐이다. 그 다음
       *   헬기를 유조선까지 몰고 가 5초를 버텨야 하는데, 헬기가 대기 상태로 28 넘게
       *   떨어져 있으면 아무 일도 일어나지 않는다. 화면에는 "차단·구조·이탈"이라는
       *   전체 목표만 적혀 있어서 지금 무엇을 해야 하는지 알 수가 없었다.
       *
       *   그래서 두 가지를 한다. 지금 할 일을 목표 줄에 그대로 쓰고, 그래도 헬기가
       *   한동안 놀고 있으면 스스로 유조선 쪽으로 향하게 한다. 플레이어가 직접
       *   몰면 그 명령이 우선이고, 이 유도는 막힌 판을 푸는 용도다. */
      this.rescueGuideAt = this.rescueGuideAt || 0;
      const idleHelicopters = helicopters.filter((unit) => (
        !unit.order || unit.order.type === "standby" || unit.order.type === "hold"
      ));
      if (idleHelicopters.length && this.elapsed - this.rescueGuideAt > 8) {
        this.rescueGuideAt = this.elapsed;
        for (const unit of idleHelicopters) {
          unit.order = {
            type: "move",
            targetPos: this.rescueTarget.position.clone(),
            autoEvade: false
          };
        }
        if (!this.rescueStageNotices.has("guide")) {
          this.rescueStageNotices.add("guide");
          this.addLog(this.text("rescueGuideHint"), "alert");
          this.showHint(this.text("rescueGuideHint"));
        }
      }
      const nearestDistance = helicopters.length
        ? Math.min(...helicopters.map((unit) => planarDistance(
          unit.position,
          this.rescueTarget.position
        )))
        : Infinity;
      const insideZone = nearestDistance <= (this.config.battle.rescueRadius || 4.8);
      if (insideZone) {
        if (!this.rescueStageNotices.has("boarding")) {
          this.rescueStageNotices.add("boarding");
          this.addLog(this.text("rescueBoardingStarted"), "good");
          this.showHint(this.text("rescueBoardingStarted"));
        }
        this.rescueProgress = Math.min(
          this.config.battle.rescueHoldSeconds || 5,
          this.rescueProgress + delta
        );
      } else {
        this.rescueProgress = Math.max(0, this.rescueProgress - delta * 0.5);
        this.rescueStageNotices.delete("boarding");
      }
      if (this.rescueProgress >= (this.config.battle.rescueHoldSeconds || 5)) {
        this.rescueTarget.captured = false;
        this.rescueTarget.rescued = true;
        this.rescueTarget.routeT = 0;
        this.rescueTarget.order = { type: "convoy" };
        this.audioManager.startLoop(
          "tankerEngine",
          this.rescueTarget.group,
          `engine:${this.rescueTarget.id}`
        );
        this.setRescueStage("egress");
        this.addLog(this.text("rescueSecured"), "good");
        this.showHint(this.text("rescueSecured"));
        this.showMissionCue("success", "cueRescueSecured", 7000);
      }
    }

    // 목표 줄은 지금 해야 할 일을 말해야 한다. 전체 목록만 적혀 있으면
    // 적을 다 잡은 뒤 무엇을 더 해야 하는지 알 수 없다.
    const objectiveKey = this.rescueStage === "intercept"
      ? "rescueObjectiveIntercept"
      : (this.rescueStage === "approach" ? "rescueObjectiveApproach" : "rescueObjectiveEgress");
    const objectiveText = this.text(objectiveKey);
    if (this.dom.objective && this.dom.objective.textContent !== objectiveText) {
      this.dom.objective.textContent = objectiveText;
    }

    this.dom.shell.dataset.rescueProgress = this.rescueProgress.toFixed(2);
    this.dom.shell.dataset.rescueTargetEscaped = String(this.rescueTarget.escaped);
  }

  updateConvoyUnit(unit, delta) {
    if (unit.hp <= 0) return;
    if (unit.rescueTarget && !unit.rescued) {
      this.brakeUnit(unit, delta);
      unit.velocity.set(0, 0, 0);
      unit.group.position.y = unit.definition.altitude;
      return;
    }
    unit.currentSpeed = moveToward(
      unit.currentSpeed,
      unit.definition.speed,
      unit.definition.acceleration * delta
    );
    unit.routeT += delta * unit.currentSpeed * 0.0021;
    if (unit.routeT >= 1) {
      unit.routeT = 1;
      unit.escaped = true;
      this.stopUnitAudioLoops(unit);
      unit.currentSpeed = moveToward(unit.currentSpeed, 0, unit.definition.deceleration * delta);
      return;
    }
    const position = this.routePoint(this.convoyRoute, unit.routeT);
    const ahead = this.routePoint(this.convoyRoute, Math.min(1, unit.routeT + 0.008));
    const direction = ahead.sub(position).setY(0).normalize();
    const previousYaw = unit.group.rotation.y;
    unit.group.rotation.y = Math.atan2(direction.x, direction.z);
    unit.lastTurnRate = shortestAngle(previousYaw, unit.group.rotation.y) / Math.max(delta, 0.001);
    unit.forward.copy(direction);
    unit.velocity.copy(direction).multiplyScalar(unit.currentSpeed);
    const blockingUnit = this.findUnitMovementBlocker(unit, position);
    if (blockingUnit) {
      this.navigationStats.unitCollisionBlocks += 1;
      unit.routeT = Math.max(0, unit.routeT - delta * unit.currentSpeed * 0.0021);
      unit.currentSpeed = moveToward(
        unit.currentSpeed,
        0,
        unit.definition.deceleration * delta * 2
      );
      unit.velocity.set(0, 0, 0);
    } else if (this.segmentTouchesLand(
      unit.position,
      position,
      this.getSeaClearance(unit)
    )) {
      this.navigationStats.blockedMoves += 1;
      unit.routeT = Math.max(0, unit.routeT - delta * unit.currentSpeed * 0.0021);
      unit.currentSpeed = moveToward(
        unit.currentSpeed,
        0,
        unit.definition.deceleration * delta * 2
      );
      unit.velocity.set(0, 0, 0);
    } else {
      unit.group.position.x = position.x;
      unit.group.position.z = position.z;
      unit.lastWaterPosition.copy(unit.position).setY(unit.definition.altitude);
    }
    unit.group.position.y = unit.definition.altitude;
  }

  updateEnemyAi(unit) {
    const engageDelay = this.config.battle.enemyEngageDelaySeconds || 0;
    if (this.elapsed < engageDelay && unit.lastHitAt < 0) {
      unit.order = { type: "standby" };
      return;
    }
    if (unit.fixed || unit.type === "mine") {
      unit.order = { type: "hold" };
      return;
    }
    this.showMissionCue("contact", "cueContact");
    const current = unit.order?.targetUnit;
    if (current?.alive && (current.team === "civilian" || current.team === "ally")) return;
    /* 나포한 배는 자기들이 격침시키지 않는다.
     *
     * 적 AI 는 민간 선박을 아군보다 먼저 노린다. 그런데 라락 구출작전에서는
     * 그 민간 선박이 바로 적이 붙잡고 있는 인질이다. 교전 지연을 없애자 6척이
     * 시작하자마자 인질선으로 몰려 0.7초에 격침시켰고, 난이도 1에서도 17초 만에
     * 작전이 실패했다. 예전에는 25초 지연이 이 장면을 가리고 있었을 뿐이다.
     * 이탈 단계에 들어가면 배를 놓친 것이므로 그때부터는 노려도 된다. */
    const seized = this.rescueTarget && this.rescueStage !== "egress"
      ? this.rescueTarget
      : null;
    const civilianTargets = unit.definition.domain === "land"
      ? []
      : this.units.filter((candidate) => (
        candidate.alive
        && candidate.team === "civilian"
        && !candidate.escaped
        && candidate !== seized
      ));
    const allyTargets = this.units.filter((candidate) => (
      candidate.alive
      && candidate.team === "ally"
      && (
        unit.definition.domain !== "land"
        || candidate.definition.domain === "land"
      )
      && (
        unit.definition.domain !== "sea"
        || candidate.definition.domain !== "land"
      )
    ));
    /* 해상 적은 수상 표적을 먼저 노린다.
     *
     * 교전 지연을 없애자 라락 구출작전에서 고속정 8척이 시작하자마자 구조 헬기
     * (체력 125, 아군 중 가장 약하다)에 화력을 몰아 30초 안에 떨어뜨렸다. 헬기는
     * 그 임무를 할 수 있는 유일한 병과라 그 순간 승리가 불가능해진다. 뒤로 물려도
     * 쫓아와 죽여서, 난이도 3 이상은 사람이 조작해도 이길 수 없는 판이 됐다.
     * 대함 무장 위주인 소형 고속정이 헬기부터 떨어뜨리는 것도 앞뒤가 맞지 않는다.
     * 수상 표적이 하나도 없을 때만 항공기를 노린다. */
    let combatPool = allyTargets;
    if (unit.definition.domain === "sea") {
      const surface = allyTargets.filter((candidate) => candidate.definition.domain !== "air");
      if (surface.length) combatPool = surface;
    }
    const pool = civilianTargets.length ? civilianTargets : combatPool;
    if (!pool.length) return;
    pool.sort((a, b) => planarDistance(unit.position, a.position) - planarDistance(unit.position, b.position));
    const targetWindow = (
      unit.definition.domain === "land"
      || (this.config.battle.scale === "large" && unit.type === "fastBoat")
    )
      ? pool.length
      : Math.min(3, pool.length);
    const offset = unit.aiIndex % targetWindow;
    unit.order = { type: "attack", targetUnit: pool[offset] || pool[0] };
  }

  getAutoTargetPriority(unit, target) {
    let priority = planarDistance(unit.position, target.position);
    const preferred = {
      marine: ["enemyMarine", "tel"],
      bomber: ["bunkerEntrance", "bunker", "tel"],
      usv: ["mine", "fastBoat"],
      fighter: ["airThreat", "fastBoat", "tel"],
      helicopter: ["fastBoat", "enemyMarine", "tel"],
      destroyer: ["fastBoat", "airThreat", "tel"],
      carrier: ["fastBoat", "airThreat", "tel"]
    }[unit.type] || [];
    const preferenceIndex = preferred.indexOf(target.type);
    if (preferenceIndex >= 0) priority -= 12 - preferenceIndex * 3;
    if (target.objectiveTarget) priority -= 4;
    const assignedAttackers = this.units.filter((candidate) => (
      candidate !== unit
      && candidate.team === "ally"
      && candidate.alive
      && candidate.order?.autoBattle
      && candidate.order?.targetUnit === target
    )).length;
    priority += assignedAttackers * (
      this.isAutoStrikeAircraft(unit) ? 5.5 : 2.4
    );
    const expectedHits = Math.max(
      1,
      Math.ceil(target.hp / Math.max(1, unit.definition.damage))
    );
    if (assignedAttackers >= expectedHits) priority += 8;
    return priority;
  }

  getIncomingAutoThreat(unit) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const projectile of this.projectiles) {
      if (
        !projectile.guided
        || projectile.lockLost
        || projectile.attacker?.team !== "enemy"
        || projectile.target !== unit
      ) continue;
      const distance = planarDistance(projectile.object.position, unit.position);
      if (distance < nearestDistance) {
        nearest = projectile;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= Math.max(8, unit.definition.desiredSize * 2.4)
      ? nearest
      : null;
  }

  issueAutoEvasion(unit, projectile) {
    const incoming = projectile.velocity.clone().setY(0);
    if (incoming.lengthSq() < 0.0001) incoming.copy(unit.forward);
    incoming.normalize();
    const side = unit.aiIndex % 2 === 0 ? 1 : -1;
    const lateral = new THREE.Vector3(-incoming.z * side, 0, incoming.x * side);
    let target = unit.position.clone()
      .addScaledVector(lateral, Math.max(6, unit.definition.desiredSize * 1.7))
      .addScaledVector(unit.forward, 2.2);
    target.x = clamp(target.x, this.config.battle.bounds.minX, this.config.battle.bounds.maxX);
    target.z = clamp(target.z, this.config.battle.bounds.minZ, this.config.battle.bounds.maxZ);
    if (unit.definition.domain === "sea") target = this.resolveSeaCommandTarget(unit, target);
    else if (unit.definition.domain === "land") target = this.resolveLandCommandTarget(unit, target);
    unit.order = { type: "move", targetPos: target, autoEvade: true };
    unit.autoAttackRun = null;
    unit.autoEvadeUntil = this.elapsed + 1.35;
    unit.nextAutoDecisionAt = this.elapsed + 1.2;
    this.autoBattleEvades += 1;
  }

  isAutoStrikeAircraft(unit) {
    return (
      unit.team === "ally"
      && unit.definition.domain === "air"
      && (unit.type === "fighter" || unit.type === "bomber")
    );
  }

  getAutoStrikeProfile(unit) {
    const range = Math.max(1, unit.definition.range);
    const bunkerBomb = unit.definition.weapon === "bunkerBomb";
    if (bunkerBomb) {
      return {
        releaseMin: range * 0.24,
        releaseMax: range * 0.52,
        resetDistance: range * 1.16,
        reentryLead: 2.2
      };
    }
    if (unit.type === "fighter") {
      return {
        releaseMin: range * 0.55,
        releaseMax: range * 0.88,
        resetDistance: range * 1.2,
        reentryLead: 1.9
      };
    }
    return {
      releaseMin: range * 0.6,
      releaseMax: range * 0.9,
      resetDistance: range * 1.22,
      reentryLead: 2.5
    };
  }

  clampAutoAirWaypoint(point) {
    const margin = 0.8;
    point.x = clamp(
      point.x,
      this.config.battle.bounds.minX + margin,
      this.config.battle.bounds.maxX - margin
    );
    point.z = clamp(
      point.z,
      this.config.battle.bounds.minZ + margin,
      this.config.battle.bounds.maxZ - margin
    );
    return point;
  }

  makeAutoAirEgressWaypoint(unit, target, distance, passSide) {
    const away = unit.position.clone().sub(target.position).setY(0);
    if (away.lengthSq() < 0.0001) {
      away.copy(unit.forward).setY(0).multiplyScalar(-1);
    }
    if (away.lengthSq() < 0.0001) away.set(passSide, 0, 1);
    away.normalize().applyAxisAngle(WORLD_UP, passSide * 0.18);
    const candidates = [0, 0.42, -0.42, 0.82, -0.82, 1.22, -1.22]
      .map((angle) => {
        const direction = away.clone().applyAxisAngle(WORLD_UP, angle);
        const point = target.position.clone()
          .addScaledVector(direction, distance)
          .setY(unit.definition.altitude);
        this.clampAutoAirWaypoint(point);
        return {
          point,
          clearance: planarDistance(point, target.position),
          alignment: direction.dot(away)
        };
      })
      .sort((a, b) => (
        (b.clearance + b.alignment * 1.6)
        - (a.clearance + a.alignment * 1.6)
      ));
    return candidates[0].point;
  }

  beginAutoAirEgress(unit, target, reason = "reposition") {
    const profile = this.getAutoStrikeProfile(unit);
    const previous = unit.autoAttackRun;
    const passSide = previous?.passSide || (unit.aiIndex % 2 === 0 ? 1 : -1);
    const pass = previous?.pass || 0;
    unit.autoAttackRun = {
      targetId: target.id,
      phase: "egress",
      pass,
      passSide,
      reason,
      waypoint: this.makeAutoAirEgressWaypoint(
        unit,
        target,
        profile.resetDistance,
        passSide
      )
    };
    unit.loiterAnchor = null;
    this.autoAirAttackRuns.egressLegs += 1;
  }

  beginAutoAirIngress(unit, target, reentry = false) {
    const previous = unit.autoAttackRun;
    unit.autoAttackRun = {
      targetId: target.id,
      phase: "ingress",
      pass: previous?.pass || 0,
      passSide: previous?.passSide || (unit.aiIndex % 2 === 0 ? 1 : -1),
      reason: reentry ? "reentry" : "initial",
      startedAt: this.elapsed
    };
    unit.loiterAnchor = null;
    this.autoAirAttackRuns.ingressLegs += 1;
    if (reentry) this.autoAirAttackRuns.reentries += 1;
  }

  initializeAutoAirAttackRun(unit, target, nowSeconds) {
    const profile = this.getAutoStrikeProfile(unit);
    const distance = planarDistance(unit.position, target.position);
    const readyAt = Number.isFinite(unit.nextShotAt) ? unit.nextShotAt : nowSeconds;
    this.autoAirAttackRuns.started += 1;
    if (
      distance < profile.releaseMin
      || readyAt - nowSeconds > profile.reentryLead
    ) {
      this.beginAutoAirEgress(unit, target, "reposition");
    } else {
      this.beginAutoAirIngress(unit, target, false);
    }
  }

  updateAutoAirAttackRun(unit, target, delta, nowSeconds) {
    if (
      Number.isFinite(unit.definition.maxShots)
      && unit.shotsFired >= unit.definition.maxShots
    ) {
      if (!unit.autoAttackRun?.waypoint) {
        this.beginAutoAirEgress(unit, target, "weapons-spent");
      }
      const safePoint = unit.autoAttackRun.waypoint;
      if (safePoint && planarDistance(unit.position, safePoint) > 1.2) {
        this.moveUnitToward(unit, safePoint, delta);
      } else {
        unit.loiterAnchor = safePoint?.clone() || unit.position.clone();
        this.updateAirLoiter(unit, delta);
      }
      return;
    }

    if (
      !unit.autoAttackRun
      || unit.autoAttackRun.targetId !== target.id
    ) {
      this.initializeAutoAirAttackRun(unit, target, nowSeconds);
    }
    const profile = this.getAutoStrikeProfile(unit);
    const run = unit.autoAttackRun;
    const distance = planarDistance(unit.position, target.position);
    const readyAt = Number.isFinite(unit.nextShotAt) ? unit.nextShotAt : nowSeconds;
    const readyIn = Math.max(0, readyAt - nowSeconds);

    if (run.phase === "egress") {
      const safeDistanceReached = distance >= profile.resetDistance * 0.86;
      if (safeDistanceReached && readyIn <= profile.reentryLead) {
        this.beginAutoAirIngress(unit, target, true);
        return;
      }
      if (!run.waypoint || planarDistance(unit.position, run.waypoint) < 1.1) {
        run.passSide *= -1;
        run.waypoint = this.makeAutoAirEgressWaypoint(
          unit,
          target,
          profile.resetDistance,
          run.passSide
        );
      }
      this.moveUnitToward(unit, run.waypoint, delta);
      return;
    }

    const launchConeDot = unit.definition.weapon === "bunkerBomb"
      ? 0.82
      : this.getLaunchConeDot(unit);

    if (distance < profile.releaseMin) {
      /* 사격 지점을 지나쳐도, 쏠 수 있으면 쏘고 빠진다.
       *
       * 적이 개전과 동시에 마주 달려오게 바꾸자 거리가 예상보다 빨리 좁혀져
       * 전투기가 매번 사격 지점을 지나쳤다. 지나쳤다고 무조건 선회하니
       * 해협 방패에서 진입 4회에 투하 0회, 라락도 투하 0회였다 — 전투기가
       * 한 발도 못 쏘고 맴돌기만 했다. 적이 멈춰 있던 시절에는 없던 일이다. */
      if (
        readyIn <= 0.05
        && distance <= unit.definition.range
        && this.getTargetForwardDot(unit, target) >= launchConeDot
        && this.tryFire(unit, target, nowSeconds)
      ) {
        run.pass += 1;
        this.autoAirAttackRuns.releases += 1;
        this.beginAutoAirEgress(unit, target, "weapon-release");
        return;
      }
      this.autoAirAttackRuns.abortedPasses += 1;
      this.beginAutoAirEgress(unit, target, "overshoot");
      return;
    }

    if (distance > profile.releaseMax) {
      this.moveUnitToward(unit, target.position, delta, { directApproach: true });
      return;
    }

    if (readyIn > 0.05) {
      if (readyIn <= 0.6 && distance > profile.releaseMin * 1.04) {
        this.moveUnitToward(unit, target.position, delta, { directApproach: true });
      } else {
        this.beginAutoAirEgress(unit, target, "cooldown");
      }
      return;
    }

    if (this.getTargetForwardDot(unit, target) < launchConeDot) {
      this.moveUnitToward(unit, target.position, delta, { directApproach: true });
      return;
    }

    if (this.tryFire(unit, target, nowSeconds)) {
      run.pass += 1;
      this.autoAirAttackRuns.releases += 1;
      this.beginAutoAirEgress(unit, target, "weapon-release");
    } else {
      this.moveUnitToward(unit, target.position, delta, { directApproach: true });
    }
  }

  updateAutoHelicopterEngagement(unit, target, delta, nowSeconds) {
    const distance = planarDistance(unit.position, target.position);
    const desiredDistance = unit.definition.range * 0.68;
    const nearDistance = unit.definition.range * 0.5;
    const farDistance = unit.definition.range * 0.86;
    if (distance > farDistance) {
      this.moveUnitToward(unit, target.position, delta);
      return;
    }
    if (distance < nearDistance) {
      const away = unit.position.clone().sub(target.position).setY(0);
      if (away.lengthSq() < 0.0001) away.copy(unit.forward).multiplyScalar(-1);
      away.normalize();
      const lateral = new THREE.Vector3(-away.z, 0, away.x)
        .multiplyScalar(unit.aiIndex % 2 === 0 ? 1 : -1);
      const waypoint = target.position.clone()
        .addScaledVector(away, desiredDistance)
        .addScaledVector(lateral, unit.definition.range * 0.16)
        .setY(unit.definition.altitude);
      this.clampAutoAirWaypoint(waypoint);
      this.moveUnitToward(unit, waypoint, delta);
      this.autoAirAttackRuns.helicopterStandoffActions += 1;
      return;
    }
    const toTarget = target.position.clone().sub(unit.position).setY(0);
    if (toTarget.lengthSq() > 0.0001) {
      this.turnUnitToward(unit, toTarget.normalize(), delta);
    }
    this.brakeUnit(unit, delta);
    if (this.getTargetForwardDot(unit, target) >= this.getLaunchConeDot(unit)) {
      this.tryFire(unit, target, nowSeconds);
    }
  }

  updateAllyAutoAi(unit) {
    if (this.elapsed < (unit.autoEvadeUntil || -Infinity)) return;
    const incoming = this.getIncomingAutoThreat(unit);
    if (incoming) {
      this.issueAutoEvasion(unit, incoming);
      return;
    }

    if (
      this.scenarioId === "tanker_rescue"
      && this.rescueStage === "approach"
      && this.rescueTarget?.alive
    ) {
      if (unit.type === "helicopter") {
        const distance = planarDistance(unit.position, this.rescueTarget.position);
        if (distance > (this.config.battle.rescueRadius || 4.8) * 0.58) {
          unit.order = {
            type: "move",
            targetPos: this.rescueTarget.position.clone(),
            autoRescue: true
          };
        } else {
          unit.order = { type: "hold", autoRescue: true };
        }
      } else {
        unit.order = { type: "hold" };
      }
      return;
    }

    const currentOrder = unit.order;
    const weaponsSpent = (
      Number.isFinite(unit.definition.maxShots)
      && unit.shotsFired >= unit.definition.maxShots
    );
    if (weaponsSpent && !currentOrder?.targetUnit?.alive) {
      unit.order = { type: "hold", autoBattle: true, weaponsSpent: true };
      unit.autoAttackRun = null;
      return;
    }
    const currentTarget = currentOrder?.targetUnit;
    if (
      currentTarget?.alive
      && currentTarget.team === "enemy"
      && this.canUnitAttackTarget(unit, currentTarget)
      && currentOrder.autoBattle
    ) {
      if (weaponsSpent) return;
      const distance = planarDistance(unit.position, currentTarget.position);
      if (!Number.isFinite(currentOrder.lastProgressAt)) {
        currentOrder.lastProgressAt = this.elapsed;
        currentOrder.bestDistance = distance;
        currentOrder.shotsAtProgress = unit.shotsFired;
      }
      if (
        unit.shotsFired > currentOrder.shotsAtProgress
        || distance < currentOrder.bestDistance - 0.35
      ) {
        currentOrder.lastProgressAt = this.elapsed;
        currentOrder.bestDistance = Math.min(currentOrder.bestDistance, distance);
        currentOrder.shotsAtProgress = unit.shotsFired;
      }
      const stallLimit = this.isAutoStrikeAircraft(unit) ? 14 : 11;
      if (this.elapsed - currentOrder.lastProgressAt <= stallLimit) return;
      unit.autoAttackRun = null;
      unit.order = { type: "hold", autoBattle: true, recoveredFromStall: true };
      unit.nextAutoDecisionAt = -Infinity;
      this.autoAirAttackRuns.stalledRecoveries += 1;
    }
    if (this.elapsed < (unit.nextAutoDecisionAt || -Infinity)) return;
    unit.nextAutoDecisionAt = this.elapsed + 0.75 + (unit.aiIndex % 4) * 0.11;
    this.autoBattleDecisionCount += 1;

    let targets = this.units
      .filter((candidate) => (
        candidate.team === "enemy"
        && candidate.alive
        && this.canUnitAttackTarget(unit, candidate)
      ))
      .sort((a, b) => (
        this.getAutoTargetPriority(unit, a) - this.getAutoTargetPriority(unit, b)
      ));
    if (this.scenarioId === "pickaxe_mountain" && unit.type === "bomber") {
      const missionTargets = targets.filter((candidate) => candidate.objectiveTarget);
      if (missionTargets.length) targets = missionTargets;
    }
    if (!targets.length) {
      unit.order = { type: "hold" };
      return;
    }
    const targetWindow = Math.min(
      targets.length,
      this.config.battle.scale === "large" ? 6 : 3
    );
    const sameTypeAllies = this.units
      .filter((candidate) => (
        candidate.team === "ally"
        && candidate.alive
        && candidate.type === unit.type
      ))
      .sort((a, b) => a.aiIndex - b.aiIndex);
    const formationSlot = Math.max(0, sameTypeAllies.indexOf(unit));
    const target = targets[formationSlot % targetWindow] || targets[0];
    unit.order = {
      type: "attack",
      targetUnit: target,
      autoBattle: true,
      assignedAt: this.elapsed,
      lastProgressAt: this.elapsed,
      bestDistance: planarDistance(unit.position, target.position),
      shotsAtProgress: unit.shotsFired
    };
    unit.autoAttackRun = null;
    unit.loiterAnchor = null;
    this.autoBattleTargetAssignments += 1;
  }

  updateCombatUnit(unit, delta, nowSeconds) {
    const order = unit.order || { type: "hold" };
    if (order.type === "attack" && (!order.targetUnit || !order.targetUnit.alive)) {
      unit.autoAttackRun = null;
      if (order.resumePos) unit.order = { type: "attackMove", targetPos: order.resumePos, resumePos: order.resumePos };
      else unit.order = { type: unit.team === "enemy" ? "hunt" : "hold" };
      return;
    }

    if (order.type === "attackMove") {
      const target = this.findNearestHostile(unit, unit.definition.vision);
      if (target) {
        unit.order = {
          type: "attack",
          targetUnit: target,
          resumePos: order.resumePos || order.targetPos
        };
        return;
      }
    }

    if (order.type === "standby" || order.type === "stop") {
      this.brakeUnit(unit, delta);
      return;
    }

    if (order.type === "hold") {
      const target = this.findNearestHostile(unit, unit.definition.range * 1.08);
      if (unit.definition.domain === "air") {
        if (target && this.getTargetForwardDot(unit, target) < this.getLaunchConeDot(unit)) {
          this.moveUnitToward(unit, target.position, delta);
        } else {
          if (target) this.tryFire(unit, target, nowSeconds);
          this.updateAirLoiter(unit, delta);
        }
      } else {
        if (target) this.tryFire(unit, target, nowSeconds);
        this.brakeUnit(unit, delta);
      }
      return;
    }

    if (order.type === "hunt") return;

    if (order.type === "attack") {
      const target = order.targetUnit;
      const distance = planarDistance(unit.position, target.position);
      if (order.autoBattle && this.isAutoStrikeAircraft(unit)) {
        this.updateAutoAirAttackRun(unit, target, delta, nowSeconds);
        return;
      }
      if (
        order.autoBattle
        && unit.type === "helicopter"
        && unit.definition.domain === "air"
      ) {
        this.updateAutoHelicopterEngagement(unit, target, delta, nowSeconds);
        return;
      }
      if (distance <= unit.definition.range) {
        if (unit.definition.domain === "air") {
          const minimumEngagementRange = this.getMinimumEngagementRange(unit);
          if (distance < minimumEngagementRange) {
            const breakaway = unit.position.clone().sub(target.position).setY(0);
            if (breakaway.lengthSq() < 0.0001) {
              breakaway.copy(unit.forward).multiplyScalar(-1);
            } else {
              breakaway.normalize();
            }
            const lateral = new THREE.Vector3(-breakaway.z, 0, breakaway.x);
            const passSide = unit.aiIndex % 2 === 0 ? 1 : -1;
            const breakawayTarget = target.position.clone()
              .addScaledVector(breakaway, minimumEngagementRange * 1.75)
              .addScaledVector(lateral, passSide * minimumEngagementRange * 0.42);
            this.moveUnitToward(unit, breakawayTarget, delta);
            return;
          }
          const targetForwardDot = this.getTargetForwardDot(unit, target);
          const launchConeDot = this.getLaunchConeDot(unit);
          if (targetForwardDot < launchConeDot) {
            this.moveUnitToward(unit, target.position, delta);
          } else {
            this.tryFire(unit, target, nowSeconds);
            const toTarget = target.position.clone().sub(unit.position).setY(0);
            if (toTarget.lengthSq() > 0.0001) toTarget.normalize();
            else toTarget.copy(unit.forward);
            const lateral = new THREE.Vector3(-toTarget.z, 0, toTarget.x);
            const passSide = unit.aiIndex % 2 === 0 ? 1 : -1;
            const passTarget = target.position.clone()
              .addScaledVector(toTarget, unit.definition.range * 0.42)
              .addScaledVector(lateral, passSide * unit.definition.range * 0.1);
            this.moveUnitToward(unit, passTarget, delta);
          }
        } else if (
          order.autoBattle
          && unit.definition.domain === "sea"
          && distance < unit.definition.range * (
            unit.type === "carrier" ? 0.62
              : unit.type === "destroyer" ? 0.52
                : 0.38
          )
        ) {
          this.tryFire(unit, target, nowSeconds);
          const away = unit.position.clone().sub(target.position).setY(0);
          if (away.lengthSq() < 0.0001) away.copy(unit.forward).multiplyScalar(-1);
          away.normalize();
          const standoffTarget = this.resolveSeaCommandTarget(
            unit,
            unit.position.clone().addScaledVector(away, Math.max(
              2.5,
              unit.definition.range * 0.18
            ))
          );
          this.moveUnitToward(unit, standoffTarget, delta);
        } else if (unit.team === "enemy" && distance < unit.definition.range * 0.45) {
          this.tryFire(unit, target, nowSeconds);
          const away = unit.position.clone().sub(target.position).setY(0).normalize();
          this.moveUnitToward(unit, unit.position.clone().addScaledVector(away, 3), delta);
        } else {
          this.tryFire(unit, target, nowSeconds);
          this.brakeUnit(unit, delta);
        }
      } else {
        this.moveUnitToward(unit, target.position, delta);
      }
      return;
    }

    if ((order.type === "move" || order.type === "attackMove") && order.targetPos) {
      const distance = planarDistance(unit.position, order.targetPos);
      if (distance < 0.6) {
        if (order.retreat) unit.escaped = true;
        unit.order = { type: "hold" };
      } else {
        this.moveUnitToward(unit, order.targetPos, delta);
      }
    }
  }

  moveUnitToward(unit, target, delta, { directApproach = false } = {}) {
    const toTarget = target.clone().sub(unit.position).setY(0);
    const distance = toTarget.length();
    if (distance < 0.001) {
      this.brakeUnit(unit, delta);
      return;
    }
    let desiredDirection = toTarget.normalize();
    const separation = new THREE.Vector3();
    let collisionSpeedFactor = 1;
    let peakAvoidance = 0;
    for (const nearby of directApproach ? [] : this.units) {
      const minimumSeparation = this.getUnitMinimumSeparation(unit, nearby);
      if (!minimumSeparation) continue;
      if (
        this.config.battle.scale === "large"
        && unit.type === "fastBoat"
        && nearby.type === "fastBoat"
        && Math.abs((nearby.aiIndex || 0) - (unit.aiIndex || 0)) > 4
      ) continue;
      const offset = unit.position.clone().sub(nearby.position).setY(0);
      let nearbyDistance = offset.length();
      const influenceRadius = (
        minimumSeparation * 1.55
        + unit.currentSpeed * 0.35
      );
      if (nearbyDistance >= influenceRadius) continue;
      if (nearbyDistance < 0.001) {
        const side = String(unit.id).localeCompare(String(nearby.id)) <= 0 ? 1 : -1;
        offset.set(side, 0, side * 0.37).normalize();
        nearbyDistance = 0;
      } else {
        offset.multiplyScalar(1 / nearbyDistance);
      }
      const proximity = clamp(
        (influenceRadius - nearbyDistance) / influenceRadius,
        0,
        1
      );
      peakAvoidance = Math.max(peakAvoidance, proximity);
      separation.addScaledVector(offset, proximity);
      const toNearby = offset.clone().multiplyScalar(-1);
      const ahead = desiredDirection.dot(toNearby);
      if (ahead > 0.05) {
        const side = String(unit.id).localeCompare(String(nearby.id)) <= 0 ? 1 : -1;
        const tangent = new THREE.Vector3(
          -toNearby.z * side,
          0,
          toNearby.x * side
        );
        separation.addScaledVector(tangent, proximity * (0.72 + ahead * 0.48));
        collisionSpeedFactor = Math.min(
          collisionSpeedFactor,
          clamp(
            (nearbyDistance - minimumSeparation * 0.96)
              / Math.max(0.1, influenceRadius - minimumSeparation * 0.96),
            0.48,
            1
          )
        );
      }
    }
    if (separation.lengthSq() > 0.001) {
      desiredDirection.addScaledVector(
        separation.normalize(),
        0.58 + peakAvoidance * 0.84
      ).normalize();
    }
    if (unit.definition.domain === "sea") {
      desiredDirection = this.getSeaSteeringDirection(
        unit,
        desiredDirection,
        target,
        delta
      );
    }

    const angleDifference = this.turnUnitToward(unit, desiredDirection, delta);
    const headingAlignment = Math.max(0, Math.cos(angleDifference));
    const slowRadius = unit.definition.slowRadius || unit.definition.desiredSize * 1.4;
    const arrival = clamp(distance / Math.max(0.25, slowRadius), 0.12, 1);
    let desiredSpeed = unit.definition.speed * arrival;
    if (unit.definition.domain === "sea") {
      desiredSpeed *= 0.42 + headingAlignment * 0.58;
      if (Math.abs(angleDifference) > 1.18) desiredSpeed *= 0.65;
    } else {
      desiredSpeed *= 0.58 + headingAlignment * 0.42;
    }
    desiredSpeed *= collisionSpeedFactor;
    const acceleration = desiredSpeed >= unit.currentSpeed
      ? unit.definition.acceleration
      : unit.definition.deceleration;
    unit.currentSpeed = moveToward(unit.currentSpeed, desiredSpeed, acceleration * delta);
    unit.forward.set(Math.sin(unit.group.rotation.y), 0, Math.cos(unit.group.rotation.y));
    unit.velocity.copy(unit.forward).multiplyScalar(unit.currentSpeed);
    this.moveUnitSafely(unit, Math.min(distance, unit.currentSpeed * delta));
    unit.position.y = unit.definition.altitude + (
      unit.definition.domain === "air"
        ? Math.sin(this.elapsed * 2.15 + unit.aiIndex) * 0.07
        : Math.sin(this.elapsed * 1.1 + unit.aiIndex) * 0.025
    );
  }

  turnUnitToward(unit, direction, delta) {
    const desiredAngle = Math.atan2(direction.x, direction.z);
    const difference = shortestAngle(unit.group.rotation.y, desiredAngle);
    const speedRatio = clamp(unit.currentSpeed / Math.max(0.001, unit.definition.speed), 0, 1);
    const authority = unit.definition.domain === "sea" ? 0.65 + speedRatio * 0.35 : 1;
    const maxTurn = unit.definition.turnRate * authority * delta;
    const turn = clamp(difference, -maxTurn, maxTurn);
    unit.group.rotation.y += turn;
    unit.lastTurnRate = delta > 0 ? turn / delta : 0;
    unit.forward.set(Math.sin(unit.group.rotation.y), 0, Math.cos(unit.group.rotation.y));
    if (unit.definition.domain === "air") {
      const bank = clamp(-unit.lastTurnRate * 0.32, -0.44, 0.44);
      unit.visualRoot.rotation.z += (bank - unit.visualRoot.rotation.z) * Math.min(1, delta * 4.4);
    }
    return difference;
  }

  brakeUnit(unit, delta) {
    unit.currentSpeed = moveToward(unit.currentSpeed, 0, unit.definition.deceleration * delta);
    unit.forward.set(Math.sin(unit.group.rotation.y), 0, Math.cos(unit.group.rotation.y));
    unit.velocity.copy(unit.forward).multiplyScalar(unit.currentSpeed);
    if (unit.currentSpeed > 0.005) {
      this.moveUnitSafely(unit, unit.currentSpeed * delta);
    }
    if (unit.definition.domain === "air") {
      unit.visualRoot.rotation.z *= Math.max(0, 1 - delta * 3.5);
    }
  }

  updateAirLoiter(unit, delta) {
    if (!unit.loiterAnchor) unit.loiterAnchor = unit.position.clone().setY(unit.definition.altitude);
    unit.loiterPhase += delta * Math.max(0.24, unit.definition.speed * 0.055);
    const radius = unit.definition.loiterRadius || 3.4;
    const target = unit.loiterAnchor.clone().add(new THREE.Vector3(
      Math.cos(unit.loiterPhase) * radius,
      0,
      Math.sin(unit.loiterPhase) * radius
    ));
    this.moveUnitToward(unit, target, delta);
  }

  updateUnitWake(unit, delta) {
    if (!unit.wake || unit.definition.domain !== "sea") return;
    this.fx.sampleWake(
      unit.wake,
      unit.position,
      unit.forward,
      unit.currentSpeed,
      unit.definition.speed,
      unit.definition.beam || unit.definition.desiredSize * 0.2,
      unit.definition.sternOffset || unit.definition.desiredSize * 0.48,
      delta
    );
  }

  canUnitAttackTarget(unit, candidate) {
    if (!unit?.alive || !candidate?.alive || unit.team === candidate.team) return false;
    if (
      unit.definition.domain === "land"
      && candidate.definition.domain !== "land"
    ) return false;
    if (unit.type === "tel" && candidate.definition.domain === "land") return false;
    return true;
  }

  findNearestHostile(unit, range) {
    const targetTeam = unit.team === "ally" ? "enemy" : "ally";
    let best = null;
    let bestDistance = range;
    for (const candidate of this.units) {
      if (!candidate.alive || candidate.team !== targetTeam) continue;
      if (!this.canUnitAttackTarget(unit, candidate)) continue;
      const distance = planarDistance(unit.position, candidate.position);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  getLaunchConeDot(unit) {
    if (unit.definition.domain !== "air") return -1;
    if (unit.type === "fighter") return 0.76;
    if (unit.type === "helicopter") return 0.3;
    if (unit.type === "bomber") return 0.64;
    return -1;
  }

  getTargetForwardDot(attacker, target) {
    const toTarget = target.position.clone().sub(attacker.position).setY(0);
    if (toTarget.lengthSq() < 0.0001) return 1;
    const forward = attacker.forward.clone().setY(0);
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, 1);
    return forward.normalize().dot(toTarget.normalize());
  }

  getWeaponTargetForwardDot(attacker, target, weapon) {
    const socketName = weapon === "missile" ? "missile" : "muzzle";
    const muzzle = this.getSocketWorldPosition(attacker, socketName);
    const toTarget = target.position.clone().sub(muzzle).setY(0);
    if (toTarget.lengthSq() < 0.0001) return -1;
    const forward = attacker.forward.clone().setY(0);
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, 1);
    return forward.normalize().dot(toTarget.normalize());
  }

  getMinimumEngagementRange(attacker) {
    if (attacker.type === "fighter") return attacker.definition.desiredSize * 1.7;
    if (attacker.type === "helicopter") return attacker.definition.desiredSize * 0.75;
    if (attacker.type === "bomber") return attacker.definition.desiredSize * 1.35;
    return 0;
  }

  getAttackProfile(attacker, target) {
    const definition = attacker.definition;
    if (
      definition.closeWeapon
      && planarDistance(attacker.position, target.position) <= definition.closeWeapon.range
    ) {
      return definition.closeWeapon;
    }
    return {
      weapon: definition.weapon,
      damage: definition.damage,
      cooldown: definition.cooldown,
      projectileSpeed: definition.projectileSpeed
    };
  }

  getProjectileTargetPosition(target, origin, projectileSpeed, leadScale = 0.68) {
    const targetPosition = target.position.clone();
    targetPosition.y += target.definition.domain === "air" ? 0.12 : 0.35;
    const timeToTarget = clamp(
      targetPosition.distanceTo(origin) / Math.max(0.001, projectileSpeed),
      0,
      0.9
    );
    targetPosition.addScaledVector(target.velocity, timeToTarget * leadScale);
    return targetPosition;
  }

  tryFire(attacker, target, nowSeconds) {
    if (this.ended && this.resultPending) return false;
    if (!attacker.alive || !target.alive) return false;
    if (
      Number.isFinite(attacker.definition.maxShots)
      && attacker.shotsFired >= attacker.definition.maxShots
    ) {
      if (!attacker.ammoEmptyNotified) {
        attacker.ammoEmptyNotified = true;
        this.showHint(this.text("bunkerAmmoEmpty"));
        this.addLog(`${attacker.callsign} · ${this.text("bunkerAmmoEmpty")}`, "alert");
      }
      return false;
    }
    const attackProfile = this.getAttackProfile(attacker, target);
    if (!attackProfile || attackProfile.damage <= 0) return false;
    const weapon = attackProfile.weapon || "tracer";
    const guidedAirWeapon = attacker.definition.domain === "air"
      && (weapon === "missile" || weapon === "rocket");
    if (guidedAirWeapon) {
      if (planarDistance(attacker.position, target.position) < this.getMinimumEngagementRange(attacker)) {
        return false;
      }
      if (this.getWeaponTargetForwardDot(attacker, target, weapon) < this.getLaunchConeDot(attacker)) {
        return false;
      }
    }
    if (attacker.nextShotAt === null) {
      attacker.nextShotAt = nowSeconds + attacker.fireStagger;
    }
    if (nowSeconds < attacker.nextShotAt) return false;
    attacker.lastShotAt = nowSeconds;
    attacker.shotsFired += 1;
    const cadenceVariation = 0.96 + (attacker.aiIndex % 3) * 0.035;
    attacker.nextShotAt = nowSeconds + attackProfile.cooldown * cadenceVariation;
    this.spawnProjectile(attacker, target, attackProfile);
    if (weapon === "bunkerBomb") {
      const total = Number(attacker.definition.maxShots) || 2;
      const remaining = Math.max(0, total - attacker.shotsFired);
      const status = this.text("bunkerAmmoStatus")
        .replace("{remaining}", String(remaining))
        .replace("{total}", String(total));
      this.addLog(`${attacker.callsign} · ${status}`, remaining ? "good" : "alert");
    } else if (weapon === "carrierAirWing") {
      this.showHint(this.text("carrierAirWingLaunched"), 4200);
      this.addLog(
        `${attacker.callsign} · ${this.text("carrierAirWingLaunched")}`,
        "good"
      );
    }
    return true;
  }

  getSocketWorldPosition(unit, socketName) {
    const socket = unit.definition.sockets?.[socketName]
      || [0, unit.definition.domain === "air" ? 0 : 0.42, unit.definition.desiredSize * 0.38];
    return unit.group.localToWorld(new THREE.Vector3(socket[0], socket[1], socket[2]));
  }

  createProjectileVisual(weapon, color) {
    if (weapon === "carrierAirWing") {
      const group = new THREE.Group();
      const source = this.strategicModels.fighter || this.models.fighter;
      if (source) {
        for (const side of [-1, 1]) {
          const fighter = source.clone(true);
          fighter.position.set(side * 0.72, side * 0.1, side * -0.42);
          fighter.rotation.y = this.config.unitTypes.fighter.modelYaw || 0;
          fighter.scale.multiplyScalar(1.15);
          group.add(fighter);
        }
        group.userData.sharedModel = true;
      } else {
        for (const side of [-1, 1]) {
          const fighter = new THREE.Mesh(
            new THREE.ConeGeometry(0.22, 1.15, 5),
            new THREE.MeshStandardMaterial({
              color: 0x7f8d91,
              roughness: 0.46,
              metalness: 0.58
            })
          );
          fighter.rotation.x = Math.PI / 2;
          fighter.position.x = side * 0.48;
          group.add(fighter);
        }
      }
      return group;
    }
    if (weapon === "bunkerBomb") {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.12, 0.82, 10),
        new THREE.MeshStandardMaterial({
          color: 0x353a35,
          roughness: 0.56,
          metalness: 0.52
        })
      );
      body.rotation.x = Math.PI / 2;
      group.add(body);
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 0.24, 8),
        new THREE.MeshStandardMaterial({
          color: 0x6d735f,
          roughness: 0.62,
          metalness: 0.28
        })
      );
      tail.rotation.x = -Math.PI / 2;
      tail.position.z = -0.5;
      group.add(tail);
      return group;
    }
    if (weapon === "missile" || weapon === "rocket") {
      const bodyLength = weapon === "missile" ? 0.62 : 0.38;
      const radius = weapon === "missile" ? 0.055 : 0.04;
      const geometry = new THREE.CylinderGeometry(
        radius * 0.18,
        radius,
        bodyLength,
        7,
        1,
        false
      );
      geometry.rotateX(Math.PI / 2);
      const projectile = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color })
      );
      return projectile;
    }
    const dimensions = weapon === "navalGun"
      ? [0.045, 0.045, 0.52]
      : [0.028, 0.028, 0.3];
    return new THREE.Mesh(
      new THREE.BoxGeometry(...dimensions),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
  }

  orientProjectile(projectile, direction) {
    projectile.quaternion.setFromUnitVectors(PROJECTILE_FORWARD, direction);
    this.projectileVisualForward
      .copy(PROJECTILE_FORWARD)
      .applyQuaternion(projectile.quaternion)
      .normalize();
    this.projectileAxisMinimumDot = Math.min(
      this.projectileAxisMinimumDot,
      this.projectileVisualForward.dot(direction)
    );
  }

  spawnProjectile(attacker, target, attackProfile = null) {
    const ally = attacker.team === "ally";
    const color = ally ? 0xbffaff : 0xff7b54;
    const profile = attackProfile || this.getAttackProfile(attacker, target);
    const weapon = profile.weapon || "tracer";
    const projectile = this.createProjectileVisual(weapon, color);
    const muzzle = this.getSocketWorldPosition(attacker, weapon === "missile" ? "missile" : "muzzle");
    const targetPosition = target.position.clone();
    targetPosition.y += weapon === "carrierAirWing"
      ? 3.4
      : target.definition.domain === "air" ? 0.12 : 0.38;
    const guided = weapon === "missile" || weapon === "rocket";
    const enemyGuided = guided && !ally;
    const launchDirection = guided
      ? attacker.forward.clone().setY(0)
      : targetPosition.clone().sub(muzzle);
    if (launchDirection.lengthSq() < 0.0001) launchDirection.set(0, 0, 1);
    launchDirection.normalize();
    if (weapon === "missile" && attacker.type === "fighter") {
      const side = attacker.shotsFired % 2 === 0 ? -1 : 1;
      const lateral = new THREE.Vector3(launchDirection.z, 0, -launchDirection.x);
      muzzle.addScaledVector(lateral, side * attacker.definition.desiredSize * 0.22);
      this.fighterShooters.add(attacker.id);
    }
    projectile.position.copy(muzzle);
    this.orientProjectile(projectile, launchDirection);
    this.effectRoot.add(projectile);
    const launchSpeedScale = weapon === "missile" ? 0.62 : weapon === "rocket" ? 0.54 : 1;
    const launchDot = launchDirection.dot(attacker.forward.clone().setY(0).normalize());
    if (guided) {
      const targetDirection = targetPosition.clone().sub(muzzle);
      if (targetDirection.lengthSq() > 0.0001) {
        const planarTargetDirection = targetDirection.setY(0).normalize();
        this.missileTargetLaunchDots.push(
          Number(launchDirection.dot(planarTargetDirection).toFixed(3))
        );
      }
      this.missileLaunchDots.push(Number(launchDot.toFixed(3)));
      this.guidedLaunches += 1;
    }
    this.projectiles.push({
      object: projectile,
      attacker,
      target,
      weapon,
      guided,
      launchPosition: muzzle.clone(),
      launchDirection: launchDirection.clone(),
      velocity: launchDirection.clone().multiplyScalar(
        profile.projectileSpeed * launchSpeedScale
      ),
      age: 0,
      guidanceDelay: weapon === "missile" ? 0.1 : 0.06,
      ignitionDelay: weapon === "missile" ? 0.045 : 0.025,
      maxTurnRate: enemyGuided
        ? weapon === "missile" ? 1.15 : 0.9
        : weapon === "missile" ? 4.2 : 3.1,
      guidanceDuration: enemyGuided
        ? weapon === "missile" ? 2.25 : 1.7
        : Infinity,
      seekerCos: enemyGuided ? Math.cos(68 * Math.PI / 180) : -1,
      lockLost: false,
      evaded: false,
      acceleration: profile.projectileSpeed * (weapon === "missile" ? 3.8 : 3.1),
      speed: profile.projectileSpeed,
      damage: profile.damage * attacker.damageMultiplier,
      life: 5.6,
      closestTargetDistance: Infinity
    });
    if (
      enemyGuided
      && target.team === "ally"
      && this.elapsed - this.lastMissileWarningAt >= 3.5
    ) {
      this.lastMissileWarningAt = this.elapsed;
      this.showHint(this.text("incomingMissileHint"));
    }
    if (weapon !== "carrierAirWing") this.fx.muzzle(muzzle, color, weapon);
    this.shots[attacker.team]++;
    this.weaponShots[weapon] = (this.weaponShots[weapon] || 0) + 1;
    const audioEvent = ally ? this.getWeaponAudioEvent(attacker, weapon) : null;
    if (audioEvent) {
      const played = this.audioManager.play(audioEvent, attacker.group);
      if (!played && (!this.audioManager.ready || !this.audioManager.unlocked)) {
        this.playTone("allyFire");
      }
    } else {
      this.playTone(ally ? "allyFire" : "enemyFire");
    }
    if (ally) {
      this.showMissionCue("weaponFire", "cueWeaponFire");
      if (attacker.type === "fighter" && attacker.shotsFired >= 2) {
        this.showMissionCue("reentry", "cueReentry");
      }
    }
  }

  getWeaponAudioEvent(attacker, weapon) {
    if (attacker.type === "destroyer" && weapon === "navalGun") return "destroyerMk45";
    if (attacker.type === "fighter" && weapon === "missile") return "fighterHarpoon";
    if (attacker.type === "carrier" && weapon === "carrierAirWing") return "fighterHarpoon";
    if (attacker.type === "helicopter" && weapon === "machineGun") return "helicopterGun";
    if (attacker.type === "helicopter" && (weapon === "missile" || weapon === "rocket")) {
      return "helicopterGuidedLaunch";
    }
    return null;
  }

  removeProjectile(shot) {
    this.effectRoot.remove(shot.object);
    if (shot.object.userData.sharedModel) return;
    shot.object.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
  }

  updateProjectiles(delta) {
    for (let index = this.projectiles.length - 1; index >= 0; index--) {
      const shot = this.projectiles[index];
      shot.life -= delta;
      if (shot.payloadReleased) {
        if (shot.life <= 0) {
          this.removeProjectile(shot);
          this.projectiles.splice(index, 1);
        } else {
          shot.object.position.addScaledVector(shot.velocity, delta);
          shot.velocity.y += delta * 1.8;
          this.orientProjectile(
            shot.object,
            shot.velocity.clone().normalize()
          );
        }
        continue;
      }
      if (!shot.target?.alive || shot.life <= 0) {
        if (shot.guided) {
          if (!shot.target.alive) this.guidedAborts += 1;
          else {
            this.guidedMisses += 1;
            const waterImpact = shot.object.position.clone();
            waterImpact.y = 0.12;
            this.addExplosion(waterImpact, false, false, true);
            this.audioManager.play("waterImpact", waterImpact);
          }
        }
        this.removeProjectile(shot);
        this.projectiles.splice(index, 1);
        continue;
      }
      const actualTargetPosition = shot.target.position.clone();
      actualTargetPosition.y += shot.weapon === "carrierAirWing"
        ? 3.4
        : shot.target.definition.domain === "air" ? 0.12 : 0.35;
      let impacted = false;
      if (shot.guided) {
        shot.age += delta;
        const targetPosition = this.getProjectileTargetPosition(
          shot.target,
          shot.object.position,
          Math.max(shot.velocity.length(), shot.speed * 0.55)
        );
        const toTarget = targetPosition.sub(shot.object.position);
        const distance = toTarget.length();
        const desiredDirection = distance > 0.0001
          ? toTarget.clone().multiplyScalar(1 / distance)
          : shot.velocity.clone().normalize();
        const currentDirection = shot.velocity.clone().normalize();
        const seekerDot = currentDirection.dot(desiredDirection);
        if (
          !shot.lockLost
          && (
            shot.age > shot.guidanceDuration
            || seekerDot < shot.seekerCos
          )
        ) {
          shot.lockLost = true;
          shot.evaded = true;
          shot.life = Math.min(shot.life, 1.4);
          this.guidedEvades += 1;
        }
        if (shot.age >= shot.guidanceDelay && !shot.lockLost) {
          const headingError = currentDirection.angleTo(desiredDirection);
          if (headingError > 0.0001) {
            const turnAmount = Math.min(1, shot.maxTurnRate * delta / headingError);
            currentDirection.lerp(desiredDirection, turnAmount).normalize();
            this.guidanceTurnSamples.push(Number(Math.min(headingError, shot.maxTurnRate * delta).toFixed(4)));
          }
        }
        const currentSpeed = Math.min(
          shot.speed,
          shot.velocity.length() + shot.acceleration * delta
        );
        const travel = currentSpeed * delta;
        this.projectileNextPosition
          .copy(shot.object.position)
          .addScaledVector(currentDirection, travel);
        const fuseRadius = Math.max(
          0.3,
          (shot.target.definition.collisionRadius || 1) * 0.34
        );
        const passDistance = pointToSegmentDistance(
          actualTargetPosition,
          shot.object.position,
          this.projectileNextPosition
        );
        shot.closestTargetDistance = Math.min(shot.closestTargetDistance, passDistance);
        if (passDistance <= fuseRadius) {
          impacted = true;
        } else {
          shot.velocity.copy(currentDirection).multiplyScalar(currentSpeed);
          shot.object.position.copy(this.projectileNextPosition);
          this.orientProjectile(shot.object, currentDirection);
          if (shot.age < shot.guidanceDelay) {
            this.projectileDisplacement
              .copy(shot.object.position)
              .sub(shot.launchPosition)
              .normalize();
            this.straightFlightMinimumDot = Math.min(
              this.straightFlightMinimumDot,
              this.projectileDisplacement.dot(shot.launchDirection)
            );
          }
          if (shot.age >= shot.ignitionDelay) {
            this.fx.missileSmoke(shot.object.position, shot.attacker.team === "enemy");
          }
        }
      } else {
        const direction = actualTargetPosition.sub(shot.object.position);
        const distance = direction.length();
        const travel = shot.speed * delta;
        if (distance <= travel + 0.18) {
          impacted = true;
        } else {
          direction.normalize();
          shot.object.position.addScaledVector(direction, travel);
          this.orientProjectile(shot.object, direction);
          if (shot.weapon === "carrierAirWing" && Math.random() < 0.52) {
            this.fx.missileSmoke(shot.object.position, false);
          }
        }
      }
      if (impacted) {
        if (shot.guided) this.guidedHits += 1;
        this.weaponHits[shot.weapon] = (this.weaponHits[shot.weapon] || 0) + 1;
        if (shot.weapon === "carrierAirWing") {
          shot.payloadReleased = true;
          shot.life = Math.min(shot.life, 1.8);
          shot.velocity.copy(shot.launchDirection)
            .multiplyScalar(shot.speed * 1.15);
          this.applyDamage(shot.target, shot.damage, shot.attacker, shot.weapon);
          continue;
        }
        this.removeProjectile(shot);
        this.projectiles.splice(index, 1);
        this.applyDamage(shot.target, shot.damage, shot.attacker, shot.weapon);
        continue;
      }
    }
  }

  applyDamage(target, damage, attacker, weapon = "") {
    if (!target.alive) return;
    target.hp = Math.max(0, target.hp - damage);
    target.lastHitAt = this.elapsed;
    if (
      target.team === "ally"
      && target.type === "marine"
      && (target.order?.type === "standby" || target.order?.type === "hold")
      && attacker?.alive
      && attacker.definition.domain === "land"
    ) {
      target.order = { type: "attack", targetUnit: attacker };
    }
    this.hits[attacker.team]++;
    this.addExplosion(
      target.position,
      attacker.team === "ally",
      weapon === "bunkerBomb",
      target.definition.domain === "sea",
      weapon
    );
    if (target.team === "enemy") {
      this.showMissionCue("targetHit", "cueTargetHit");
    } else if (target.team === "civilian") {
      this.showMissionCue("convoyThreat", "cueConvoyThreat", 7200);
      this.addLog(`${this.text("tankerHit")} · ${target.callsign}`, "alert");
    } else if (target.team === "ally") {
      this.showMissionCue("allyHit", "cueAllyHit", 7000);
    }
    if (target.hp <= 0) this.destroyUnit(target, attacker, weapon);
  }

  destroyUnit(unit, attacker, weapon = "") {
    unit.alive = false;
    unit.hp = 0;
    unit.group.visible = false;
    unit.label.style.opacity = "0";
    this.selected.delete(unit);
    this.inspectedEnemies.delete(unit);
    if (unit.team === "enemy") {
      this.destroyedEnemies += unit.forceCount;
      this.addLog(`${this.text("enemyDestroyed")} · ${unit.callsign}`, "good");
    } else if (unit.team === "ally") {
      this.addLog(`${this.text("unitLost")} · ${unit.callsign}`, "alert");
    } else {
      this.addLog(`${this.text("tankerHit")} · ${unit.callsign} LOST`, "alert");
    }
    this.addExplosion(unit.position, attacker.team === "ally", true, unit.definition.domain === "sea");
    this.fx.stopWake(unit.wake);
    this.stopUnitAudioLoops(unit);
    const playedExplosion = (
      unit.definition.domain === "sea"
      || unit.type === "bunkerEntrance"
    )
      && this.audioManager.play("navalExplosion", unit.position.clone());
    if (!playedExplosion && (!this.audioManager.ready || !this.audioManager.unlocked)) {
      this.playTone("explosion");
    }
    this.syncSelectionVisuals();
    this.renderForceList();
    if (
      this.scenarioId === "pickaxe_mountain"
      && unit.type === "bunkerEntrance"
      && attacker?.type === "bomber"
      && attacker.shotsFired < (attacker.definition.maxShots || 2)
      && this.getObjectiveDestroyedCount() < this.config.battle.objectiveEnemyCount
    ) {
      this.showHint(this.text("bunkerNextTarget"), 5200);
      this.addLog(this.text("bunkerNextTarget"), "good");
    }
    this.checkOutcome();
  }

  addExplosion(position, allyHit, large = false, water = false, weapon = "") {
    const impactPosition = position.clone();
    impactPosition.y = water ? Math.max(0.12, impactPosition.y) : impactPosition.y;
    if (weapon === "bunkerBomb") {
      this.fx.bunkerPenetratorImpact(impactPosition);
      this.cameraShake = Math.max(this.cameraShake, 1.05);
    } else {
      this.fx.impact(impactPosition, {
        large,
        water,
        friendlyFire: !allyHit
      });
      if (large) this.cameraShake = Math.max(this.cameraShake, water ? 0.48 : 0.62);
    }
  }

  addOrderMarker(position, type) {
    const attack = type === "attack";
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 40),
      new THREE.MeshBasicMaterial({
        color: attack ? TEAM_COLORS.enemy : TEAM_COLORS.ally,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(position).setY(0.17);
    this.effectRoot.add(ring);
    this.orderMarkers.push({ ring, life: 1.1 });
  }

  updateEffects(delta) {
    this.fx.update(delta);
    for (let index = this.orderMarkers.length - 1; index >= 0; index--) {
      const marker = this.orderMarkers[index];
      marker.life -= delta;
      marker.ring.scale.multiplyScalar(1 + delta * 1.7);
      marker.ring.material.opacity = Math.max(0, marker.life);
      if (marker.life <= 0) {
        this.effectRoot.remove(marker.ring);
        this.orderMarkers.splice(index, 1);
      }
    }
  }

  getAliveForceCount(team) {
    return this.units
      .filter((unit) => unit.team === team && unit.alive)
      .reduce((sum, unit) => sum + unit.forceCount, 0);
  }

  getObjectiveDestroyedCount() {
    const objectiveTargetType = this.config.battle.objectiveTargetType;
    if (!objectiveTargetType) return this.destroyedEnemies;
    return this.units
      .filter((unit) => (
        unit.team === "enemy"
        && unit.type === objectiveTargetType
        && !unit.alive
      ))
      .reduce((sum, unit) => sum + unit.forceCount, 0);
  }

  /**
   * 목표를 더 이상 달성할 수 없게 됐는지 본다.
   *
   * 곡괭이산처럼 목표 파괴에 특정 병과의 한정 탄약(B-2 의 GBU-57)이 필요한
   * 전투는, 남은 탄이 남은 목표 수보다 적어지는 순간 승리가 불가능해진다.
   * 이때 타이머가 끝날 때까지 기다리게 두면 플레이어는 아무것도 할 수 없는
   * 화면에 갇힌다. 그래서 즉시 실패로 끊고 결과 화면을 띄운다.
   */
  objectiveUnreachable() {
    const remainingTargets = Math.max(
      0,
      this.config.battle.objectiveEnemyCount - this.getObjectiveDestroyedCount()
    );
    if (remainingTargets === 0) return false;
    const required = this.config.battle.requiredFleetType;

    if (required) {
      const strikers = this.units.filter((unit) => (
        unit.team === "ally" && unit.type === required
      ));

      // 임무를 그 병과만 할 수 있는데 전멸했으면 그것으로 끝이다.
      // 탄약이 남았는지 따질 것도 없다. (구출 임무의 헬기가 이 경우다.)
      if (!strikers.some((unit) => unit.alive)) return true;

      if (strikers.some((unit) => Number.isFinite(unit.definition.maxShots))) {
        const remainingShots = strikers.reduce((sum, unit) => {
          if (!unit.alive || !Number.isFinite(unit.definition.maxShots)) return sum;
          return sum + Math.max(0, unit.definition.maxShots - unit.shotsFired);
        }, 0);
        // 아직 날아가는 폭탄이 목표에 닿을 수 있다. 명중·소멸 시 배열에서 제거되므로
        // 남아 있는 항목은 모두 비행 중이다. 이 수를 남은 탄으로 함께 센다.
        // ★ 반드시 그 병과가 쏜 것만 센다. 예전에는 적이 쏜 미사일까지 세어
        //   "아직 폭탄이 날아간다"고 착각해 판정이 뒤집혔다.
        const inFlight = (this.projectiles || []).filter((projectile) => (
          projectile.attacker?.team === "ally"
          && projectile.attacker?.type === required
        )).length;
        if (remainingShots + inFlight < remainingTargets) return true;
      }
    }

    /* 여기부터는 병과·탄약과 무관한 일반 판정이다.
     *
     * ★ 남은 목표를 때릴 수 있는 아군이 하나도 없으면 승리는 불가능하다.
     *   해안 포대 작전에서 USV 만으로 편성하면(편성 화면에서 합법적으로 가능하다)
     *   지상 목표를 때릴 수단이 전혀 없는 채로 시작된다. 예전에는 그 상태로
     *   제한시간 260초를 끝까지 기다려야 했다.
     *   사거리는 보지 않는다 — 배는 움직여 접근할 수 있다. 애초에 때릴 수 없는
     *   조합(도메인 불일치)만 잡는다.
     */
    return !this.objectiveStrikeReachable();
  }

  /**
   * 살아 있는 아군 중 남은 목표를 실제로 때릴 수 있는 유닛이 하나라도 있는가.
   *
   * ★ 병과가 맞느냐만 봐서는 부족하다. 해안 포대 작전에서 USV(사거리 7.5)만 골라도
   *   편성이 통과되는데, 배는 해안선에서 멈추므로 육상 포대까지 사거리가 닿지 않는다.
   *   승리가 처음부터 불가능한데 제한시간 260초를 그대로 기다려야 했다.
   *   그래서 지형까지 본다 — 목표 주변 물 위 지점 중 사거리 안에 드는 곳이 있는지.
   *
   * 지도는 전투 중에 바뀌지 않으므로, 살아 있는 병과 구성이 그대로면 다시 계산하지 않는다.
   * 이 판정은 종료 검사에서 자주 불린다.
   */
  objectiveStrikeReachable() {
    const objectiveTargetType = this.config.battle.objectiveTargetType;
    const targets = this.units.filter((unit) => (
      unit.alive
      && unit.team === "enemy"
      && (!objectiveTargetType || unit.type === objectiveTargetType)
    ));
    if (!targets.length) return true;
    const attackers = this.units.filter((unit) => unit.alive && unit.team === "ally");
    if (!attackers.length) return false;

    const key = `${[...new Set(attackers.map((unit) => unit.type))].sort().join(",")}`
      + `|${[...new Set(targets.map((unit) => unit.type))].sort().join(",")}`;
    if (this.strikeReachKey === key) return this.strikeReachValue;
    this.strikeReachKey = key;
    this.strikeReachValue = targets.some((target) => attackers.some(
      (unit) => this.unitCanStrikeTarget(unit, target)
    ));
    return this.strikeReachValue;
  }

  /** 이 유닛이 저 목표까지 실제로 닿는가. 지형에 막히는 해상 유닛만 따로 본다. */
  unitCanStrikeTarget(unit, target) {
    if (!this.canUnitAttackTarget(unit, target)) return false;
    if (unit.definition.domain !== "sea") return true;
    const range = unit.definition.range || 0;
    if (range <= 0) return false;
    const clearance = this.getSeaClearance(unit);
    // 목표가 물 위면 배가 그대로 접근할 수 있다.
    if (!this.isWorldLand(target.position, clearance)) return true;
    // 목표가 뭍이면, 사거리 안에 배가 설 수 있는 물이 있어야 한다.
    for (let radius = 0.6; radius <= range; radius += 0.6) {
      for (let step = 0; step < 24; step += 1) {
        const angle = step / 24 * Math.PI * 2;
        const point = new THREE.Vector3(
          target.position.x + Math.cos(angle) * radius,
          0,
          target.position.z + Math.sin(angle) * radius
        );
        if (!this.isWorldLand(point, clearance)) return true;
      }
    }
    return false;
  }

  checkOutcome() {
    if (this.ended) return;
    const enemies = this.getAliveForceCount("enemy");
    const allies = this.getAliveForceCount("ally");
    const civilians = this.getAliveForceCount("civilian");
    const objectiveDestroyed = this.getObjectiveDestroyedCount();
    if (this.scenarioId === "tanker_rescue") {
      const rescued = this.rescueStage === "egress" && Boolean(this.rescueTarget?.alive);

      /* 구출을 마치고 위협이 사라졌으면 그것이 작전 성공이다.
       *
       * ★ 예전에는 유조선이 탈출 항로를 100% 완주해야(routeT >= 1) 승리였다.
       *   그 완주에는 353초가 드는데 이 작전의 제한시간은 300초다. 즉 적을 모두
       *   격파하고 승선까지 끝내도 승리가 산술적으로 불가능했고, 플레이어는
       *   할 일이 없는 채로 4분 넘게 기다리다 패배 화면을 봤다.
       *   "적을 다 부쉈는데 왜 안 끝나느냐"는 신고가 바로 이것이었다.
       */
      if (rescued && (enemies === 0 || this.rescueTarget.escaped)) {
        this.endBattle(true);
        return;
      }

      /* 구출은 헬기만 할 수 있다. 헬기가 전멸하면 승선 단계가 영영 진행되지 않는데,
       * 아군과 유조선이 남아 있어 패배 판정도 걸리지 않았다. 남은 제한시간 내내
       * 아무것도 못 하는 화면에 갇힌다. 곡괭이산에서 고친 것과 같은 부류라,
       * 이제는 같은 함수로 판정한다. 이 분기가 그 함수를 아예 안 부른 게 근본 누락이었다. */
      const rescuerType = this.config.battle.requiredFleetType || "helicopter";
      const rescuers = this.units.filter((unit) => (
        unit.alive && unit.team === "ally" && unit.type === rescuerType
      ));
      const rescueImpossible = !rescued
        && (rescuers.length === 0 || this.objectiveUnreachable());

      if (
        allies === 0
        || civilians < this.config.battle.minimumTankersToSave
        || this.remaining <= 0
        || rescueImpossible
      ) {
        this.endBattle(false);
      }
      return;
    }
    if (
      objectiveDestroyed >= this.config.battle.objectiveEnemyCount
      && civilians >= this.config.battle.minimumTankersToSave
    ) {
      this.endBattle(true);
    } else if (
      allies === 0
      || civilians < this.config.battle.minimumTankersToSave
      || this.remaining <= 0
      || this.objectiveUnreachable()
    ) {
      this.endBattle(false);
    }
  }

  createCampaignResult() {
    const adaptive = this.config.battle.adaptiveProfile || this.battleContext;
    return {
      missionId: this.scenarioId,
      success: Boolean(this.battleSuccess),
      completedAt: Date.now(),
      destroyed: this.getObjectiveDestroyedCount(),
      targetCount: this.config.battle.objectiveEnemyCount,
      difficulty: adaptive.difficulty,
      variant: adaptive.variant,
      reinforcements: adaptive.reinforcements || 0,
      budgetUsed: this.getFleetBudgetUsed(),
      budgetAuthorized: this.config.fleetSelection.budget,
      supplementalBudget: this.supplementalBudget,
      alliesAlive: this.getAliveForceCount("ally"),
      civiliansAlive: this.getAliveForceCount("civilian"),
      forces: { ...this.fleetSelection },
      politics: {
        congressSupport: Math.round(this.politics.congressSupport),
        partySupport: Math.round(this.politics.partySupport),
        approvalDelta: this.politics.approvalDelta,
        intlDelta: this.politics.intlDelta,
        forcedAppropriation: this.politics.forcedAppropriation
      }
    };
  }

  handleResultAction() {
    if (!this.ended) {
      location.reload();
      return;
    }
    const result = this.createCampaignResult();
    if (this.embedded && window.parent !== window) {
      window.parent.postMessage(
        { type: "hormuz-rts-result", result },
        location.origin
      );
      return;
    }
    if (this.campaignMode === "intro" && result.success) {
      try {
        localStorage.setItem("hormuzIntroBattleResultV1", JSON.stringify(result));
        const target = new URL(this.returnPath, location.href);
        if (target.origin === location.origin) {
          location.href = target.href;
          return;
        }
      } catch {
        // 저장소가 차단된 경우 같은 전투를 다시 시작하게 둡니다.
      }
    }
    location.reload();
  }

  retryBattle() {
    const target = new URL(location.href);
    const replayCount = clamp(
      Math.round(Number(target.searchParams.get("replay")) || 0) + 1,
      1,
      99
    );
    target.searchParams.set("replay", String(replayCount));
    target.searchParams.delete("qa");
    this.dom.shell.dataset.retryRequested = "true";
    this.dom.shell.dataset.retryTarget = target.href;
    location.href = target.href;
  }

  endBattle(success) {
    if (this.ended) return;
    this.setAutoBattleEnabled(false, { announce: false });
    this.ended = true;
    this.battleSuccess = Boolean(success);
    this.resultPending = true;
    this.postBattleElapsed = 0;
    this.resultRevealReady = false;
    this.dom.status.textContent = this.text(success ? "statusVictory" : "statusDefeat");
    this.dom.shell.dataset.resultPending = "true";
    this.dom.shell.dataset.resultReviewInteractive = "true";
    this.dom.shell.dataset.resultDelayMs = String(RESULT_REVEAL_DELAY_MS);
    this.resultPendingStartedAt = performance.now();
    this.dom.shell.dataset.resultActualDelayMs = "0";
    this.dom.shell.dataset.resultVisible = "false";
    this.dom.result.hidden = true;
    this.dom.resultCard.classList.toggle("failure", !success);
    this.dom.resultImage.src = success && this.config.battle.successImage
      ? this.config.battle.successImage
      : MISSION_CUE_IMAGES[success ? "success" : "failure"];
    this.dom.resultImage.alt = this.text(success ? "cueSuccess" : "cueFailure");
    this.dom.resultStatus.textContent = this.text(success ? "statusVictory" : "statusDefeat");
    this.dom.resultTitle.textContent = this.text(success ? "victoryTitle" : "defeatTitle");
    this.dom.resultText.textContent = this.text(success ? "victoryText" : "defeatText");
    this.dom.resultEnemy.textContent = `${this.getObjectiveDestroyedCount()}/${this.config.battle.objectiveEnemyCount}`;
    const initialCivilianCount = this.config.spawns
      .filter((spawn) => spawn.team === "civilian")
      .reduce((sum, spawn) => sum + (spawn.forceCount || 1), 0);
    this.dom.resultCivilian.textContent = `${this.getAliveForceCount("civilian")}/${initialCivilianCount}`;
    this.dom.resultAlly.textContent = `${this.getAliveForceCount("ally")}/${Object.values(this.fleetSelection).reduce((sum, count) => sum + count, 0)}`;
    const canContinue = this.embedded || (this.campaignMode === "intro" && success);
    this.dom.resultContinue.hidden = !canContinue;
    this.dom.resultContinue.textContent = this.embedded
      ? this.text("returnToMain")
      : this.text("enterSituationRoom");
    this.showHint(
      this.text(success ? "victoryReviewHint" : "defeatReviewHint"),
      RESULT_REVEAL_DELAY_MS
    );
    this.updateCommandButtons();
    window.clearTimeout(this.resultRevealTimer);
    this.resultRevealTimer = window.setTimeout(() => {
      this.resultRevealReady = true;
    }, RESULT_REVEAL_DELAY_MS);
  }

  revealBattleResult() {
    if (!this.ended || !this.resultPending) return;
    this.resultPending = false;
    this.resultRevealReady = false;
    this.paused = true;
    this.audioManager.stopAllLoops();
    this.dom.shell.dataset.resultPending = "false";
    this.dom.shell.dataset.resultReviewInteractive = "false";
    this.dom.shell.dataset.resultActualDelayMs = String(
      Math.round(performance.now() - this.resultPendingStartedAt),
    );
    this.dom.shell.dataset.resultVisible = "true";
    this.dom.result.hidden = false;
    this.updateCommandButtons();
    this.playTone(this.battleSuccess ? "victory" : "defeat");
  }

  addLog(message, tone = "") {
    const line = document.createElement("div");
    line.className = `log-line ${tone}`;
    const elapsed = Math.floor(this.elapsed);
    line.innerHTML = `<time>${formatTime(elapsed)}</time><span>${message}</span>`;
    this.dom.log.prepend(line);
    while (this.dom.log.children.length > 7) this.dom.log.lastElementChild.remove();
  }

  showHint(message, durationMs = 1500) {
    this.dom.hint.textContent = message;
    this.dom.hint.classList.add("visible");
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(
      () => this.dom.hint.classList.remove("visible"),
      durationMs
    );
  }

  showMissionCue(id, textKey, durationMs = 6500) {
    if (!MISSION_CUE_IMAGES[id] || this.shownMissionCues.has(id)) return;
    this.shownMissionCues.add(id);
    clearTimeout(this.missionCueTimer);
    this.dom.missionCueImage.src = MISSION_CUE_IMAGES[id];
    this.dom.missionCueImage.alt = this.text(textKey);
    this.dom.missionCueTitle.textContent = this.text(textKey);
    this.dom.missionCue.setAttribute("aria-hidden", "false");
    this.dom.missionCue.classList.add("visible");
    this.missionCueTimer = setTimeout(() => {
      this.dom.missionCue.classList.remove("visible");
      this.dom.missionCue.setAttribute("aria-hidden", "true");
    }, durationMs);
  }

  renderForceList() {
    const allies = this.units.filter((unit) => unit.team === "ally");
    const signature = allies.map((unit) => `${unit.id}:${unit.callsign}`).join("|");
    if (signature !== this.forceListSignature) {
      this.forceListSignature = signature;
      this.dom.allyList.innerHTML = allies.map((unit) => (
        `<div class="force-item" data-unit-id="${unit.id}">
          <strong>${unit.callsign}</strong>
          <small data-unit-detail>${this.unitDisplayName(unit.definition)}</small>
          <div class="hp-track"><i></i></div>
        </div>`
      )).join("");
      this.dom.allyList.querySelectorAll("[data-unit-id]").forEach((element) => {
        element.addEventListener("click", () => {
          const unit = this.units.find((candidate) => candidate.id === element.dataset.unitId);
          if (unit?.alive) this.selectUnits([unit]);
        });
      });
    }
    const elementsById = new Map(
      [...this.dom.allyList.querySelectorAll("[data-unit-id]")]
        .map((element) => [element.dataset.unitId, element])
    );
    for (const unit of allies) {
      const element = elementsById.get(unit.id);
      if (!element) continue;
      element.classList.toggle("selected", this.selected.has(unit));
      element.classList.toggle("lost", !unit.alive);
      const hpBar = element.querySelector(".hp-track i");
      if (hpBar) hpBar.style.width = `${Math.round((unit.hp / unit.maxHp) * 100)}%`;
      const detail = element.querySelector("[data-unit-detail]");
      if (detail) {
        const totalShots = Number(unit.definition.maxShots);
        detail.textContent = unit.type === "carrier"
          ? `${this.unitDisplayName(unit.definition)} · ${this.text("carrierAirWingReady")}`
          : Number.isFinite(totalShots)
          ? `${this.unitDisplayName(unit.definition)} · GBU-57 ${Math.max(0, totalShots - unit.shotsFired)}/${totalShots}${this.text("shotUnit")}`
          : this.unitDisplayName(unit.definition);
      }
    }
  }

  renderSelectionSummary() {
    const inspectedEnemies = [...this.inspectedEnemies].filter((unit) => unit.alive);
    if (inspectedEnemies.length) {
      const averageHp = Math.round(
        inspectedEnemies.reduce(
          (sum, unit) => sum + unit.hp / unit.maxHp,
          0
        ) / inspectedEnemies.length * 100
      );
      const primary = inspectedEnemies[0];
      this.dom.selectionLabel.textContent = this.text("selectedEnemy");
      this.dom.selectionSummary.textContent = this.text("enemySelectionSummary")
        .replace("{count}", String(inspectedEnemies.length))
        .replace("{hp}", String(averageHp))
        .replace("{range}", String(primary.definition.range));
      return;
    }
    const units = [...this.selected].filter((unit) => unit.alive);
    this.dom.selectionLabel.textContent = this.text("selected");
    if (!units.length) {
      this.dom.selectionSummary.textContent = this.text("noSelection");
      return;
    }
    const averageHp = Math.round(units.reduce((sum, unit) => sum + unit.hp / unit.maxHp, 0) / units.length * 100);
    const orderTypes = [...new Set(units.map((unit) => unit.order?.type || "standby"))];
    const orderText = orderTypes.length === 1
      ? this.text({
        move: "orderMoving",
        attackMove: "orderAttackMoving",
        attack: "orderAttacking",
        hold: "orderHolding",
        stop: "orderStopped",
        standby: "orderStandingBy",
        hunt: "orderSearching"
      }[orderTypes[0]] || "orderMixed")
      : this.text("orderMixed");
    if (units.length > 6) {
      this.dom.selectionSummary.textContent = `${this.text("allyGroupSelectionSummary")
        .replace("{count}", String(units.length))
        .replace("{hp}", String(averageHp))} · ${orderText}`;
      return;
    }
    const limitedAmmo = units
      .filter((unit) => Number.isFinite(unit.definition.maxShots))
      .map((unit) => (
        `GBU-57 ${Math.max(0, unit.definition.maxShots - unit.shotsFired)}`
        + `/${unit.definition.maxShots}${this.text("shotUnit")}`
      ));
    const ammoText = limitedAmmo.length ? ` · ${limitedAmmo.join(" · ")}` : "";
    const carrierText = units.some((unit) => unit.type === "carrier")
      ? ` · ${this.text("carrierAirWingReady")}`
      : "";
    this.dom.selectionSummary.textContent = `${units.map((unit) => unit.callsign).join(" · ")} / HP ${averageHp}% · ${orderText}${ammoText}${carrierText}`;
  }

  updateCommandButtons() {
    const disabled = (
      !this.selected.size
      || !this.started
      || (this.ended && !this.resultPending)
    );
    document.querySelectorAll("[data-command]:not([data-command='pause']):not([data-command='selectAll']):not([data-command='autoBattle'])").forEach((button) => {
      button.disabled = disabled;
    });
    if (this.dom.autoBattle) {
      this.dom.autoBattle.disabled = !this.started || this.ended;
    }
  }

  updateHud(force = false) {
    const now = performance.now();
    const interval = this.config.battle.scale === "large" ? 180 : 100;
    if (!force && now - this.lastHudAt < interval) return;
    this.lastHudAt = now;
    const alliesAlive = this.getAliveForceCount("ally");
    const enemiesAlive = this.getAliveForceCount("enemy");
    const civiliansAlive = this.getAliveForceCount("civilian");
    const objectiveDestroyed = this.getObjectiveDestroyedCount();
    this.dom.allyCount.textContent = alliesAlive;
    this.dom.enemyCount.textContent = enemiesAlive;
    this.dom.civilianCount.textContent = civiliansAlive;
    if (this.scenarioId === "tanker_rescue") {
      const holdSeconds = this.config.battle.rescueHoldSeconds || 5;
      const egressPercent = this.rescueTarget
        ? Math.round(clamp(this.rescueTarget.routeT, 0, 1) * 100)
        : 0;
      if (this.rescueStage === "intercept") {
        this.dom.enemySummary.textContent = `${this.text("rescueHudStep1")} · ${this.destroyedEnemies}/${this.config.battle.objectiveEnemyCount}`;
        this.dom.objectiveFill.style.width = `${clamp(
          this.destroyedEnemies / this.config.battle.objectiveEnemyCount * 60,
          0,
          60
        )}%`;
      } else if (this.rescueStage === "approach") {
        this.dom.enemySummary.textContent = `${this.text("rescueHudStep2")} · ${this.rescueProgress.toFixed(1)}/${holdSeconds}${this.text("rescueSeconds")}`;
        this.dom.objectiveFill.style.width = `${60 + clamp(
          this.rescueProgress / holdSeconds * 20,
          0,
          20
        )}%`;
      } else {
        this.dom.enemySummary.textContent = `${this.text("rescueHudStep3")} · ${egressPercent}%`;
        this.dom.objectiveFill.style.width = `${80 + clamp(egressPercent * 0.2, 0, 20)}%`;
      }
    } else {
      this.dom.enemySummary.textContent = `${objectiveDestroyed} / ${this.config.battle.objectiveEnemyCount} ${this.text("enemyProgress")}`;
      this.dom.objectiveFill.style.width = `${clamp(objectiveDestroyed / this.config.battle.objectiveEnemyCount * 100, 0, 100)}%`;
    }
    this.dom.time.textContent = formatTime(this.remaining);
    for (const unit of this.units) {
      const labelBar = unit.label.querySelector("i");
      if (labelBar) labelBar.style.width = `${Math.round(unit.hp / unit.maxHp * 100)}%`;
    }
    const movingSeaUnits = this.units.filter(
      (unit) => unit.alive && unit.definition.domain === "sea" && unit.currentSpeed > 0.05
    );
    const seaUnitsOnLand = this.units.filter(
      (unit) => (
        unit.alive
        && unit.definition.domain === "sea"
        && this.isWorldLand(unit.position, 0)
      )
    );
    const landUnitsOffLand = this.units.filter(
      (unit) => (
        unit.alive
        && unit.definition.domain === "land"
        && !this.isWorldLand(unit.position, 0)
      )
    );
    const minimumHeadingDot = movingSeaUnits.length
      ? Math.min(...movingSeaUnits.map((unit) => {
        const velocity = unit.velocity.clone().setY(0);
        if (velocity.lengthSq() < 0.0001) return 1;
        return velocity.normalize().dot(unit.forward);
      }))
      : 1;
    const fxStats = this.fx.getStats();
    const fighters = this.units.filter((unit) => unit.alive && unit.type === "fighter");
    const helicopters = this.units.filter((unit) => unit.alive && unit.type === "helicopter");
    const alliedMarines = this.units.filter(
      (unit) => unit.alive && unit.team === "ally" && unit.type === "marine"
    );
    const enemyGround = this.units.filter(
      (unit) => unit.alive && unit.team === "enemy" && unit.type === "enemyMarine"
    );
    const fighterOrders = fighters.map((unit) => {
      const orderTarget = unit.order?.targetPos || unit.order?.targetUnit?.position;
      const targetText = orderTarget
        ? `${orderTarget.x.toFixed(1)},${orderTarget.z.toFixed(1)}`
        : "-";
      return `${unit.id}:${unit.order?.type || "none"}:${targetText}`;
    });
    this.dom.shell.dataset.headingDot = minimumHeadingDot.toFixed(3);
    this.dom.shell.dataset.seaUnitsOnLand = String(seaUnitsOnLand.length);
    this.dom.shell.dataset.landUnitsOffLand = String(landUnitsOffLand.length);
    this.dom.shell.dataset.landUnitsOffLandIds = landUnitsOffLand
      .map((unit) => unit.id)
      .join("|");
    this.dom.shell.dataset.correctedSeaSpawns = String(
      this.navigationStats.correctedSeaSpawns
    );
    this.dom.shell.dataset.adjustedSeaCommands = String(
      this.navigationStats.adjustedSeaCommands
    );
    this.dom.shell.dataset.coastContacts = String(this.navigationStats.coastContacts);
    this.dom.shell.dataset.coastAvoidanceTurns = String(
      this.navigationStats.avoidanceTurns
    );
    this.dom.shell.dataset.coastBlockedMoves = String(this.navigationStats.blockedMoves);
    if (this.params.get("qa") === "coast-collision" && this.elapsed >= 16) {
      this.dom.shell.dataset.shoreQa = (
        seaUnitsOnLand.length === 0
        && this.navigationStats.coastContacts > 0
        && this.navigationStats.avoidanceTurns > 0
      ) ? "passed" : "failed";
    }
    this.dom.shell.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.dom.shell.dataset.triangles = String(this.renderer.info.render.triangles);
    this.dom.shell.dataset.wakeSamples = String(fxStats.wakeSamples);
    this.dom.shell.dataset.activeParticles = String(fxStats.hotParticles + fxStats.smokeParticles);
    this.dom.shell.dataset.fighterModels = String(
      fighters.reduce((sum, unit) => sum + (unit.modelInstances?.length || 1), 0)
    );
    this.dom.shell.dataset.fighterUnits = String(fighters.length);
    this.dom.shell.dataset.fighterSelected = String(
      fighters.filter((unit) => this.selected.has(unit)).length
    );
    this.dom.shell.dataset.fighterIndependent = String(
      new Set(fighters.map((unit) => unit.id)).size === fighters.length
    );
    this.dom.shell.dataset.fighterShooters = String(this.fighterShooters.size);
    this.dom.shell.dataset.fighterOrders = fighterOrders.join("|");
    this.dom.shell.dataset.helicopterModels = String(
      helicopters.reduce((sum, unit) => sum + (unit.modelInstances?.length || 1), 0)
    );
    this.dom.shell.dataset.helicopterUnits = String(helicopters.length);
    this.dom.shell.dataset.helicopterRotors = String(
      helicopters.reduce((sum, unit) => sum + (unit.rotors?.length || 0), 0)
    );
    this.dom.shell.dataset.helicopterIndependent = String(
      new Set(helicopters.map((unit) => unit.id)).size === helicopters.length
    );
    this.dom.shell.dataset.helicopterSelected = String(
      helicopters.filter((unit) => this.selected.has(unit)).length
    );
    this.dom.shell.dataset.helicopterGunShots = String(this.weaponShots.machineGun || 0);
    this.dom.shell.dataset.helicopterGunHits = String(this.weaponHits.machineGun || 0);
    this.dom.shell.dataset.marineUnits = String(alliedMarines.length);
    this.dom.shell.dataset.enemyGroundUnits = String(enemyGround.length);
    this.dom.shell.dataset.meshyMarineUnits = String(
      [...alliedMarines, ...enemyGround]
        .filter((unit) => unit.meshyModel)
        .length
    );
    this.dom.shell.dataset.meshyBomberUnits = String(
      this.units.filter((unit) => (
        unit.alive
        && unit.type === "bomber"
        && (unit.meshyModel || unit.instancedBatch?.meshySource)
      )).length
    );
    this.dom.shell.dataset.marineAnimationStates = alliedMarines
      .map((unit) => `${unit.id}:${unit.animationState || "ready"}`)
      .join("|");
    this.dom.shell.dataset.marineAnimationStatesSeen = alliedMarines
      .map((unit) => (
        `${unit.id}:${[...(unit.animationStatesSeen || [])].join(",") || "ready"}`
      ))
      .join("|");
    this.dom.shell.dataset.skinnedMarineMeshes = String(
      [...alliedMarines, ...enemyGround]
        .filter((unit) => Boolean(unit.marineRig))
        .length
    );
    this.dom.shell.dataset.meshyMarineAnimations = String(
      [...alliedMarines, ...enemyGround]
        .filter((unit) => (
          unit.marineRig?.meshy
          && !unit.marineRig?.strategic
        ))
        .length
    );
    this.dom.shell.dataset.meshyMarineLodUnits = String(
      [...alliedMarines, ...enemyGround]
        .filter((unit) => Boolean(unit.marineRig?.strategic))
        .length
    );
    this.dom.shell.dataset.marineLodBatches = String(
      this.marineLodBatches.length
    );
    this.dom.shell.dataset.marineWeaponBatches = String(
      this.marineWeaponBatches.length
    );
    this.dom.shell.dataset.instancedLodBatches = String(this.instancedLodBatches.length);
    this.dom.shell.dataset.activeProjectiles = String(this.projectiles.length);
    this.dom.shell.dataset.missileLaunchDot = String(
      this.missileLaunchDots.length ? Math.min(...this.missileLaunchDots).toFixed(3) : "1.000"
    );
    this.dom.shell.dataset.missileTargetDot = String(
      this.missileTargetLaunchDots.length
        ? Math.min(...this.missileTargetLaunchDots).toFixed(3)
        : "1.000"
    );
    this.dom.shell.dataset.guidedLaunches = String(this.guidedLaunches);
    this.dom.shell.dataset.guidedHits = String(this.guidedHits);
    this.dom.shell.dataset.guidedMisses = String(this.guidedMisses);
    this.dom.shell.dataset.guidedAborts = String(this.guidedAborts);
    this.dom.shell.dataset.guidedEvades = String(this.guidedEvades);
    this.dom.shell.dataset.projectileAxisDot = this.projectileAxisMinimumDot.toFixed(3);
    this.dom.shell.dataset.straightFlightDot = this.straightFlightMinimumDot.toFixed(3);
    this.dom.shell.dataset.curvedMissiles = String(
      this.projectiles.filter((shot) => Boolean(shot.curve)).length
    );
    this.dom.shell.dataset.guidanceTurns = String(this.guidanceTurnSamples.length);
    const helicopter = this.units.find((unit) => unit.alive && unit.type === "helicopter");
    this.dom.shell.dataset.mainRotorAngle = (
      helicopter?.rotors?.[0]?.object.rotation.y || 0
    ).toFixed(3);
    this.renderForceList();
    this.renderSelectionSummary();
  }

  updateLabels(force = false) {
    const now = performance.now();
    const interval = this.config.battle.scale === "large" ? 140 : 34;
    if (!force && now - this.lastLabelsAt < interval) return;
    this.lastLabelsAt = now;
    const rect = this.canvas.getBoundingClientRect();
    // 레이아웃이 아직 안 잡힌 순간에 계산하면 모든 이름표가 좌상단 한 점에 뭉친다.
    // 그 상태에서 화면이 멈추면(백그라운드 탭 등) 그대로 남는다. 그때는 건너뛴다.
    if (rect.width < 1 || rect.height < 1) return;
    for (const unit of this.units) {
      if (!unit.alive) {
        unit.label.style.opacity = "0";
        if (unit.groundShadowElement) unit.groundShadowElement.style.opacity = "0";
        continue;
      }
      if (unit.groundShadowElement) {
        const shadowOptions = unit.definition.contactShadow || {};
        const shadowWidth = shadowOptions.width || unit.definition.desiredSize * 1.28;
        const shadowDepth = shadowOptions.depth || unit.definition.desiredSize * 0.66;
        const shadowCenter = unit.group.position.clone().setY(0.055);
        const shadowEdge = shadowCenter.clone().add(
          new THREE.Vector3(shadowWidth * 0.5, 0, 0)
        );
        const forwardEdge = shadowCenter.clone().addScaledVector(
          unit.forward,
          Math.max(1, shadowDepth)
        );
        shadowCenter.project(this.camera);
        shadowEdge.project(this.camera);
        forwardEdge.project(this.camera);
        const visibleShadow = shadowCenter.z > -1 && shadowCenter.z < 1;
        const shadowX = (shadowCenter.x * 0.5 + 0.5) * rect.width;
        const shadowY = (-shadowCenter.y * 0.5 + 0.5) * rect.height;
        const edgeX = (shadowEdge.x * 0.5 + 0.5) * rect.width;
        const edgeY = (-shadowEdge.y * 0.5 + 0.5) * rect.height;
        const forwardX = (forwardEdge.x * 0.5 + 0.5) * rect.width;
        const forwardY = (-forwardEdge.y * 0.5 + 0.5) * rect.height;
        const projectedWidth = clamp(
          Math.hypot(edgeX - shadowX, edgeY - shadowY) * 2,
          24,
          520
        );
        const projectedDepth = clamp(projectedWidth * 0.38, 12, 190);
        const projectedAngle = Math.atan2(forwardY - shadowY, forwardX - shadowX);
        unit.groundShadowElement.style.left = `${shadowX}px`;
        unit.groundShadowElement.style.top = `${shadowY}px`;
        unit.groundShadowElement.style.width = `${projectedWidth}px`;
        unit.groundShadowElement.style.height = `${projectedDepth}px`;
        unit.groundShadowElement.style.opacity = visibleShadow ? "0.94" : "0";
        unit.groundShadowElement.style.transform = (
          `translate(-50%, -50%) rotate(${projectedAngle}rad)`
        );
      }
      const point = unit.group.position.clone();
      point.y += unit.definition.desiredSize * 0.4 + 1;
      point.project(this.camera);
      const visible = point.z > -1 && point.z < 1;
      // 이름표는 유닛 위에 가운데 정렬로 붙는다. 유닛이 화면 가장자리에 있으면
      // 절반이 화면 밖으로 나가 이름이 잘려 읽히지 않으므로 안쪽으로 밀어 넣는다.
      this.labelMetrics(unit);
      const halfWidth = unit.labelHalfWidth || 0;
      const labelHeight = unit.labelHeight || 0;
      const rawX = (point.x * 0.5 + 0.5) * rect.width;
      const rawY = (-point.y * 0.5 + 0.5) * rect.height;
      const labelX = rect.width > halfWidth * 2 + 8
        ? clamp(rawX, halfWidth + 4, rect.width - halfWidth - 4)
        : rawX;
      const labelY = rect.height > labelHeight + 8
        ? clamp(rawY, labelHeight + 4, rect.height - 4)
        : rawY;
      unit.label.style.transform = `translate(-50%,-100%) translate(${labelX}px,${labelY}px)`;
      const targeted = [...this.selected].some(
        (selected) => selected.order?.targetUnit === unit
      );
      const important = this.config.battle.scale === "large"
        ? (
          this.selected.has(unit)
          || this.inspectedEnemies.has(unit)
          || unit.team === "civilian"
          || unit.lastHitAt > this.elapsed - 3
          || targeted
        )
        : (
          unit.team !== "enemy"
          || this.inspectedEnemies.has(unit)
          || unit.lastHitAt > this.elapsed - 3
          || targeted
        );
      unit.label.style.opacity = visible && important ? "1" : "0";
    }
  }

  updateRadar(force = false) {
    const now = performance.now();
    if (!force && now - this.lastRadarAt < 120) return;
    this.lastRadarAt = now;
    const context = this.radarContext;
    const width = this.radar.width;
    const height = this.radar.height;
    context.clearRect(0, 0, width, height);
    const gradient = context.createRadialGradient(width * 0.5, height * 0.5, 4, width * 0.5, height * 0.5, width * 0.55);
    gradient.addColorStop(0, "#082630");
    gradient.addColorStop(1, "#020d12");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(93,220,230,.13)";
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += width / 8) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += height / 5) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    for (const unit of this.units) {
      if (!unit.alive) continue;
      const x = (unit.position.x - this.config.battle.bounds.minX)
        / (this.config.battle.bounds.maxX - this.config.battle.bounds.minX) * width;
      const y = (unit.position.z - this.config.battle.bounds.minZ)
        / (this.config.battle.bounds.maxZ - this.config.battle.bounds.minZ) * height;
      context.fillStyle = unit.team === "ally" ? "#64e4ee" : unit.team === "enemy" ? "#ff5b50" : "#e6efed";
      context.shadowColor = context.fillStyle;
      const highlighted = this.selected.has(unit) || this.inspectedEnemies.has(unit);
      context.shadowBlur = highlighted ? 10 : 4;
      context.beginPath();
      context.arc(x, y, highlighted ? 3.8 : 2.5, 0, Math.PI * 2);
      context.fill();
    }
    context.shadowBlur = 0;
  }

  playTone(type) {
    if (!this.started && type !== "start") return;
    try {
      if (!this.audioContext) {
        this.audioContext = this.audioManager?.context
          || new (window.AudioContext || window.webkitAudioContext)();
      }
      const context = this.audioContext;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      const settings = {
        start: [190, 420, 0.18, "sine"],
        command: [480, 620, 0.06, "sine"],
        pause: [260, 180, 0.12, "triangle"],
        allyFire: [780, 220, 0.05, "square"],
        enemyFire: [330, 120, 0.06, "sawtooth"],
        explosion: [110, 38, 0.2, "sawtooth"],
        victory: [280, 680, 0.36, "triangle"],
        defeat: [180, 52, 0.42, "sawtooth"]
      }[type] || [400, 500, 0.05, "sine"];
      oscillator.type = settings[3];
      oscillator.frequency.setValueAtTime(settings[0], now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, settings[1]), now + settings[2]);
      gain.gain.setValueAtTime(type.includes("Fire") ? 0.02 : 0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + settings[2]);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + settings[2]);
    } catch {
      // Audio is optional; browser policy may block it.
    }
  }

  /**
   * 화면비에 맞춰 시야를 보정한다.
   *
   * three.js 의 `fov` 는 세로 기준이다. 그래서 세로가 긴 화면에서는 세로 시야가
   * 그대로인 채 가로 시야만 좁아진다. 9:16 에서는 가로로 보이는 폭이 16:9 의
   * 1/3 수준까지 줄어, 전장이 한쪽으로 밀리고 화면 대부분이 빈 바다가 된다.
   *
   * 가로 폭을 되찾는 방법은 두 가지다. fov 를 넓히거나 카메라를 뒤로 물리거나.
   * fov 만 넓히면 원근이 과장돼 함선이 휘어 보이고, 거리만 물리면 유닛이
   * 지나치게 작아진다. 그래서 fov 를 상한까지만 넓히고 모자란 몫을 거리로 채운다.
   *
   * @returns 카메라 높이·거리에 곱할 배율. 세로가 아닐 때는 1이다.
   */
  aspectFraming() {
    const aspect = this.camera.aspect;
    const base = RTS_BASE_ASPECT;
    if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= base) {
      this.camera.fov = RTS_BASE_FOV;
      this.cameraTilt = 1;
      return 1;
    }
    const shortfall = base / aspect;                    // 되찾아야 할 가로 배수
    const baseHalf = Math.tan((RTS_BASE_FOV / 2) * Math.PI / 180);
    const wantedFov = 2 * Math.atan(baseHalf * shortfall) * 180 / Math.PI;
    this.camera.fov = Math.min(RTS_MAX_FOV, wantedFov);
    const coveredByFov = Math.tan((this.camera.fov / 2) * Math.PI / 180) / baseHalf;

    // 세로일수록 더 내려다본다. 높이·거리를 같은 비율로 늘리면 시야각만 커져
    // 화면 위쪽이 하늘로 채워진다. 각도를 세워 시선을 수면 쪽으로 내리면
    // 세로로 긴 화면이 전장의 앞뒤 깊이를 담는다.
    const portrait = clamp((base - aspect) / (base - RTS_PORTRAIT_ASPECT), 0, 1);
    this.cameraTilt = 1 + portrait * (RTS_PORTRAIT_TILT - 1);

    // fov 가 감당하지 못한 나머지는 카메라를 물려서 채운다.
    return Math.min(RTS_MAX_PULLBACK, Math.max(1, shortfall / coveredByFov));
  }

  /**
   * HUD 상자들의 자리를 실제 높이에서 계산해 CSS 변수로 내보낸다.
   *
   * 헤더 높이는 고정이 아니다. 화면이 좁아지면 목표 문구가 아래 줄로 내려가고,
   * 영문은 같은 문장이 한글보다 길어 한 줄을 더 먹는다. 실측하면 102px(세로 한글)
   * 에서 197px(320px 폭 영문)까지 벌어진다. CSS 가 110px/132px 를 상수로 박고
   * 있어서 그 차이만큼 전술 지형 배지와 좌우 패널이 목표 문구를 덮었다.
   * 무엇을 해야 하는지 읽을 수 없게 되는 자리라 상수로 둘 수 없다.
   *
   * 같은 이유로 아래쪽도 잰다. 명령바는 좁은 폭에서 두 줄이 되고 영문 라벨이
   * 길어지면 버튼이 더 높아져 선택 패널을 밀어 올린다.
   */
  syncHudMetrics() {
    const shell = this.dom.shell;
    if (!shell) return;
    const viewportHeight = shell.clientHeight || innerHeight;
    const viewportWidth = shell.clientWidth || innerWidth;
    const gap = viewportWidth <= 720 ? 6 : 10;

    const headerBottom = this.dom.header
      ? this.dom.header.getBoundingClientRect().bottom
      : 0;
    const badgeHeight = this.dom.terrainBadge
      ? this.dom.terrainBadge.getBoundingClientRect().height
      : 0;
    const commandTop = this.dom.commandBar
      ? this.dom.commandBar.getBoundingClientRect().top
      : viewportHeight;
    const selectionHeight = this.dom.selectionPanel
      ? this.dom.selectionPanel.getBoundingClientRect().height
      : 0;

    const top = Math.max(0, Math.round(headerBottom + gap));
    const badge = badgeHeight > 0 ? Math.round(badgeHeight + gap) : 0;
    const bottom = Math.max(0, Math.round(viewportHeight - commandTop + gap));
    // 좌측 열은 위에서 아군 목록, 아래에서 선택 패널이 자리를 나눠 쓴다.
    const leftBottom = Math.round(bottom + selectionHeight + gap);

    const next = { top, badge, bottom, leftBottom };
    const previous = this.hudMetrics;
    if (
      previous
      && previous.top === top
      && previous.badge === badge
      && previous.bottom === bottom
      && previous.leftBottom === leftBottom
    ) return;
    this.hudMetrics = next;

    shell.style.setProperty("--hud-top", `${top}px`);
    shell.style.setProperty("--hud-badge", `${badge}px`);
    shell.style.setProperty("--hud-bottom", `${bottom}px`);
    shell.style.setProperty("--hud-left-bottom", `${leftBottom}px`);
  }

  /**
   * HUD 상자의 크기가 바뀌는 순간을 지켜본다. 목표 문구·명령바 라벨은 언어 전환,
   * 전투 상황, 글꼴 로딩 뒤에 줄 수가 달라진다. resize 이벤트만으로는 그 순간을
   * 잡지 못해 한 번 어긋나면 전투 내내 겹친 채로 남는다.
   */
  watchHudMetrics() {
    this.syncHudMetrics();
    // 글꼴이 늦게 붙으면 줄 수가 달라진다. 붙은 뒤 한 번 더 잰다.
    document.fonts?.ready?.then(() => this.syncHudMetrics()).catch(() => {});
    if (typeof ResizeObserver !== "function") return;
    this.hudObserver = new ResizeObserver(() => this.syncHudMetrics());
    for (const element of [
      this.dom.header,
      this.dom.terrainBadge,
      this.dom.commandBar,
      this.dom.selectionPanel
    ]) {
      if (element) this.hudObserver.observe(element);
    }
  }

  /** 화면 폭이 바뀌면 이름표 글자 크기도 바뀐다. 캐시한 치수를 버린다. */
  invalidateLabelMetrics() {
    this.labelMetricsEpoch = (this.labelMetricsEpoch || 0) + 1;
  }

  /**
   * 이름표 크기는 만들 때 정해지고 그 뒤 바뀌지 않는다. 매 프레임 offsetWidth 를
   * 읽으면 레이아웃을 강제로 다시 계산하게 만들어 유닛 수만큼 느려지므로,
   * 화면 크기가 바뀔 때까지 재지 않고 캐시를 쓴다.
   */
  labelMetrics(unit) {
    const epoch = this.labelMetricsEpoch || 0;
    if (unit.labelMetricsEpoch !== epoch) {
      unit.labelHalfWidth = unit.label.offsetWidth / 2;
      unit.labelHeight = unit.label.offsetHeight;
      unit.labelMetricsEpoch = epoch;
    }
    return unit;
  }

  resize() {
    const width = this.canvas.clientWidth || innerWidth;
    const height = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.cameraFrameScale = this.aspectFraming();
    this.camera.updateProjectionMatrix();
    this.updateCameraPosition(true);
    this.invalidateLabelMetrics();
    this.syncHudMetrics();
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const rawDelta = Math.min(0.08, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (rawDelta > 0.0001) {
      this.frameRateSamples.push(1 / rawDelta);
      if (this.frameRateSamples.length > 120) this.frameRateSamples.shift();
      if (this.frameRateSamples.length >= 30) {
        const averageFps = this.frameRateSamples.reduce((sum, value) => sum + value, 0)
          / this.frameRateSamples.length;
        this.dom.shell.dataset.averageFps = averageFps.toFixed(1);
      }
    }
    const settlingBattlefield = this.ended && this.resultPending;
    const combatDelta = (
      this.started && !this.paused && !this.ended
        ? rawDelta * this.timeScale
        : 0
    );
    const celebrationDelta = (
      this.started && !this.paused && settlingBattlefield
        ? rawDelta
        : 0
    );
    const delta = combatDelta || celebrationDelta;

    if (this.ocean?.material?.uniforms?.time) {
      this.ocean.material.uniforms.time.value += rawDelta;
    }
    this.updateRotors(rawDelta);
    if (this.started && (!this.ended || settlingBattlefield)) this.updateCamera(rawDelta);
    if (delta > 0) {
      if (settlingBattlefield) {
        this.postBattleElapsed += delta;
      } else {
        this.elapsed += delta;
        this.remaining = Math.max(0, this.config.battle.durationSeconds - this.elapsed);
      }
      const simulationTime = this.elapsed + this.postBattleElapsed;
      this.updateUnits(delta, simulationTime);
      if (!this.ended) this.updateRescueMission(delta);
      this.updateInstancedLodBatches();
      this.updateMeshyMarineLodBatches();
      this.updateMarineWeaponBatches();
      this.updateMovementAudio();
      this.updateProjectiles(delta);
      this.updateEffects(delta);
      if (!this.ended) this.checkOutcome();
      if (
        settlingBattlefield
        && this.resultRevealReady
        && this.postBattleElapsed >= RESULT_REVIEW_MIN_SECONDS
      ) {
        this.revealBattleResult();
      }
    } else {
      this.updateEffects(rawDelta * (settlingBattlefield ? 1 : 0.25));
      this.updateInstancedLodBatches();
      this.updateMeshyMarineLodBatches();
      this.updateMarineWeaponBatches();
    }
    this.updateHud();
    this.updateLabels();
    this.updateRadar();
    this.renderer.render(this.scene, this.camera);
  }

  getSnapshot() {
    return {
      initialized: this.initialized,
      adaptiveDifficulty: {
        ...(this.config.battle.adaptiveProfile || this.battleContext),
        objectiveEnemyCount: this.config.battle.objectiveEnemyCount,
        engageDelaySeconds: this.config.battle.enemyEngageDelaySeconds,
        badge: this.dom.battleScaleBadge?.textContent || "",
        threat: document.getElementById("brief-threat-value")?.textContent || ""
      },
      map: {
        id: this.scenarioMap.id,
        name: this.lang === "en" ? this.scenarioMap.nameEn : this.scenarioMap.nameKo,
        provider: this.dom.shell.dataset.terrainProvider || "local-three",
        googleStatus: this.dom.shell.dataset.googleBattleMapStatus || "disabled",
        googleMapId: this.dom.shell.dataset.googleBattleMapId || "not-set",
        googleRange: Number(this.dom.shell.dataset.googleBattleRange) || 0,
        googleFov: Number(this.dom.shell.dataset.googleBattleFov) || 0,
        googleCenter: this.dom.shell.dataset.googleBattleCenter || "",
        googleTerrainShakeSamples: Number(
          this.dom.shell.dataset.googleTerrainShakeSamples
        ) || 0,
        googleTerrainMaxShakePx: Number(
          this.dom.shell.dataset.googleTerrainMaxShakePx
        ) || 0,
        bounds: { ...this.geo.bounds },
        center: [
          this.geo.projection.centerLon,
          this.geo.projection.centerLat
        ],
        routePoints: this.convoyRoute?.length || 0,
        landUnits: this.units
          .filter((unit) => unit.definition.domain === "land")
          .map((unit) => ({
            id: unit.id,
            requested: [...unit.geographic.requested],
            resolved: [...unit.geographic.resolved],
            onLand: unit.geographic.onLand,
            insideLand: this.isWorldLandInterior(
              unit.position,
              unit.groundClearance || 0
            ),
            contactShadow: Boolean(unit.contactShadow),
            contactShadowVisible: Boolean(unit.contactShadow?.visible),
            screenSpaceShadow: Boolean(unit.groundShadowElement),
            contactShadowWorldY: unit.contactShadow
              ? Number((unit.position.y + unit.contactShadow.position.y).toFixed(3))
              : null
          }))
      },
      navigation: {
        ...this.navigationStats,
        unitCollisions: this.getUnitCollisionSnapshot(),
        seaUnitsOnLand: this.units.filter(
          (unit) => (
            unit.alive
            && unit.definition.domain === "sea"
            && this.isWorldLand(unit.position, 0)
          )
        ).map((unit) => unit.id),
        landUnitsOffLand: this.units.filter(
          (unit) => (
            unit.alive
            && unit.definition.domain === "land"
            && !this.isWorldLand(unit.position, 0)
          )
        ).map((unit) => unit.id),
        landUnitsOutsideInterior: this.units.filter(
          (unit) => (
            unit.alive
            && unit.definition.domain === "land"
            && !this.isWorldLandInterior(
              unit.position,
              unit.groundClearance || 0
            )
          )
        ).map((unit) => unit.id)
      },
      fleet: {
        selection: { ...this.fleetSelection },
        budgetUsed: this.getFleetBudgetUsed(),
        budgetAuthorized: this.config.fleetSelection.budget,
        supplementalAmount: this.config.fleetSelection.supplementalAmount || 240,
        availableTypes: Object.entries(this.config.fleetSelection.options)
          .filter(([, option]) => option.maximum > 0)
          .map(([type]) => type)
      },
      started: this.started,
      paused: this.paused,
      ended: this.ended,
      resultPending: this.resultPending,
      resultDelayMs: RESULT_REVEAL_DELAY_MS,
      resultVisible: !this.dom.result.hidden,
      resultReviewInteractive: this.ended && this.resultPending,
      resultRevealReady: this.resultRevealReady,
      postBattleElapsed: Number(this.postBattleElapsed.toFixed(2)),
      autoBattle: {
        enabled: this.autoBattleEnabled,
        decisions: this.autoBattleDecisionCount,
        targetAssignments: this.autoBattleTargetAssignments,
        evades: this.autoBattleEvades,
        airAttackRuns: {
          ...this.autoAirAttackRuns,
          active: this.units
            .filter((unit) => (
              unit.team === "ally"
              && unit.alive
              && this.isAutoStrikeAircraft(unit)
              && unit.autoAttackRun
            ))
            .map((unit) => ({
              id: unit.id,
              type: unit.type,
              phase: unit.autoAttackRun.phase,
              targetId: unit.autoAttackRun.targetId,
              pass: unit.autoAttackRun.pass,
              distance: Number(planarDistance(
                unit.position,
                unit.order?.targetUnit?.position || unit.position
              ).toFixed(2)),
              shotsFired: unit.shotsFired
            }))
        },
        activeOrders: this.units.filter((unit) => (
          unit.team === "ally"
          && unit.alive
          && ["attack", "move", "attackMove", "hold"].includes(unit.order?.type)
        )).length,
        buttonActive: Boolean(this.dom.autoBattle?.classList.contains("active")),
        ariaPressed: this.dom.autoBattle?.getAttribute("aria-pressed") || "false"
      },
      elapsed: Number(this.elapsed.toFixed(2)),
      remaining: Number(this.remaining.toFixed(2)),
      allyAlive: this.units.filter((unit) => unit.team === "ally" && unit.alive).length,
      enemyAlive: this.units.filter((unit) => unit.team === "enemy" && unit.alive).length,
      civilianAlive: this.units.filter((unit) => unit.team === "civilian" && unit.alive).length,
      destroyedEnemies: this.destroyedEnemies,
      objectiveDestroyed: this.getObjectiveDestroyedCount(),
      rescue: {
        enabled: this.scenarioId === "tanker_rescue",
        stage: this.rescueStage,
        progress: Number(this.rescueProgress.toFixed(2)),
        holdSeconds: this.config.battle.rescueHoldSeconds || 0,
        radius: this.config.battle.rescueRadius || 0,
        targetId: this.rescueTarget?.id || null,
        targetAlive: Boolean(this.rescueTarget?.alive),
        targetRescued: Boolean(this.rescueTarget?.rescued),
        targetEscaped: Boolean(this.rescueTarget?.escaped),
        markerVisible: Boolean(this.rescueMarker?.group?.visible),
        helicopterDistances: this.rescueTarget
          ? this.units
            .filter((unit) => (
              unit.alive && unit.team === "ally" && unit.type === "helicopter"
            ))
            .map((unit) => Number(planarDistance(
              unit.position,
              this.rescueTarget.position
            ).toFixed(2)))
          : []
      },
      selected: [...this.selected].map((unit) => unit.id),
      inspectedEnemies: [...this.inspectedEnemies].map((unit) => unit.id),
      lastCommand: this.lastCommand,
      shots: { ...this.shots },
      hits: { ...this.hits },
      weaponShots: { ...this.weaponShots },
      weaponHits: { ...this.weaponHits },
      projectiles: this.projectiles.length,
      timeScale: this.timeScale,
      camera: {
        focus: [
          Number(this.cameraFocus.x.toFixed(3)),
          Number(this.cameraFocus.z.toFixed(3))
        ],
        height: Number(this.cameraHeight.toFixed(3)),
        distance: Number(this.cameraDistance.toFixed(3)),
        wheelZoomInLimitPercent: Math.round(
          (1 - this.cameraWheelZoomInLimit) * 100
        ),
        minimumWheelHeight: Number((
          this.config.battle.camera.height * this.cameraWheelZoomInLimit
        ).toFixed(3)),
        minimumWheelDistance: Number((
          this.config.battle.camera.distance * this.cameraWheelZoomInLimit
        ).toFixed(3)),
        googleMaximumWorldView: Number((
          this.googleBattleMap?.getWorldViewLimits().max || 0
        ).toFixed(3)),
        fov: Number(this.camera.fov.toFixed(3)),
        panCount: this.cameraPanStats.count,
        panDistance: Number(this.cameraPanStats.distance.toFixed(1)),
        panInput: this.cameraPanStats.input
      },
      render: {
        drawCalls: this.renderer?.info?.render?.calls || 0,
        triangles: this.renderer?.info?.render?.triangles || 0
      },
      formations: {
        instancedLodBatches: this.instancedLodBatches.length,
        marineLodBatches: this.marineLodBatches.length,
        marineWeaponBatches: this.marineWeaponBatches.length,
        meshyStrategicUnits: this.units.filter((unit) => (
          unit.alive
          && unit.instancedBatch?.meshySource
        )).length,
        fallbackStrategicUnits: this.units.filter((unit) => (
          unit.alive
          && unit.instancedLod
          && !unit.instancedBatch?.meshySource
        )).map((unit) => unit.id),
        strategicMeshyTypes: [
          ...new Set(this.instancedLodBatches
            .filter((batch) => batch.meshySource)
            .map((batch) => batch.units[0]?.type)
            .filter(Boolean))
        ],
        strategicVisibility: this.instancedLodBatches.map((batch) => ({
          type: batch.units[0]?.type || null,
          team: batch.units[0]?.team || null,
          count: batch.units.length,
          displayScale: Number((batch.displayScale || 1).toFixed(2)),
          effectiveSize: Number((
            (batch.units[0]?.definition?.desiredSize || 0)
            * (batch.displayScale || 1)
          ).toFixed(2)),
          sourceMatrixApplied: Boolean(batch.sourceMatrix),
          positionStorage: (
            batch.mesh.geometry.getAttribute("position")?.array
              ?.constructor?.name
            || "unknown"
          ),
          emissiveStrength: Number(
            (batch.emissiveStrength || 0).toFixed(2)
          ),
          hasBaseColorMap: Boolean(batch.mesh.material?.map),
          hasProceduralDetailMap: Boolean(
            batch.mesh.material?.map
            && this.strategicDetailTextures[batch.units[0]?.type]
          ),
          usesMeshyTexture: Boolean(
            batch.mesh.material?.map
            && !this.strategicDetailTextures[batch.units[0]?.type]
          ),
          hasVertexColors: Boolean(
            batch.mesh.geometry.getAttribute("color")
          ),
          hasTexturedDetailModel: Boolean(batch.detailRoot),
          texturedDetailUnit: batch.detailUnit?.id || null,
          visibleInstanceCount: batch.units.filter((unit) => (
            unit.alive && unit !== batch.detailUnit
          )).length,
          selectedInstanceCount: batch.units.filter((unit) => (
            unit.alive && this.selected.has(unit)
          )).length,
          materialBaseColor: (
            batch.mesh.material?.color?.getHexString?.()
            || null
          ),
          materialTransparent: Boolean(batch.mesh.material?.transparent)
        })),
        meshyBomberUnits: this.units.filter((unit) => (
          unit.alive
          && unit.type === "bomber"
          && (unit.meshyModel || unit.instancedBatch?.meshySource)
        )).length,
        bomberUnits: this.units
          .filter((unit) => unit.alive && unit.type === "bomber")
          .map((unit) => {
            const meshy = Boolean(
              unit.meshyModel || unit.instancedBatch?.meshySource
            );
            const localForward = meshy
              ? new THREE.Vector3(-1, 0, 0)
              : new THREE.Vector3(0, 0, 1);
            const visualYaw = unit.group.rotation.y + (
              meshy
                ? unit.definition.modelYaw || 0
                : unit.definition.fallbackYaw || 0
            );
            const visualForward = localForward
              .applyAxisAngle(WORLD_UP, visualYaw)
              .normalize();
            return {
              id: unit.id,
              name: unit.definition.name,
              meshy,
              modelYaw: Number((unit.definition.modelYaw || 0).toFixed(4)),
              damage: unit.definition.damage,
              maxShots: unit.definition.maxShots || null,
              shotsFired: unit.shotsFired,
              remainingShots: Number.isFinite(unit.definition.maxShots)
                ? Math.max(0, unit.definition.maxShots - unit.shotsFired)
                : null,
              visualHeadingDot: Number(
                visualForward.dot(unit.forward).toFixed(3)
              )
            };
          }),
        bunkerTargets: this.units
          .filter((unit) => unit.type === "bunkerEntrance")
          .map((unit) => ({
            id: unit.id,
            alive: unit.alive,
            hp: unit.hp,
            maxHp: unit.maxHp
          })),
        carrierAirWingLaunches: this.weaponShots.carrierAirWing || 0,
        carrierAirWingHits: this.weaponHits.carrierAirWing || 0,
        carrierUnits: this.units
          .filter((unit) => unit.alive && unit.type === "carrier")
          .map((unit) => ({
            id: unit.id,
            weapon: unit.definition.weapon,
            weaponSystem: unit.definition.weaponProfile?.system || "",
            closeWeapon: unit.definition.closeWeapon?.system || "",
            range: unit.definition.range,
            cooldown: unit.definition.cooldown,
            shotsFired: unit.shotsFired
          })),
        fighterModels: this.units
          .filter((unit) => unit.alive && unit.type === "fighter")
          .reduce((sum, unit) => sum + (unit.modelInstances?.length || 1), 0),
        fighterUnits: this.units
          .filter((unit) => unit.alive && unit.type === "fighter")
          .map((unit) => ({
            id: unit.id,
            callsign: unit.callsign,
            hp: Math.round(unit.hp),
            shotsFired: unit.shotsFired,
            order: unit.order?.type || "none",
            position: [
              Number(unit.position.x.toFixed(2)),
              Number(unit.position.z.toFixed(2))
            ],
            target: unit.order?.targetPos
              ? [
                Number(unit.order.targetPos.x.toFixed(2)),
                Number(unit.order.targetPos.z.toFixed(2))
              ]
              : unit.order?.targetUnit?.id || null
          })),
        fighterShooters: [...this.fighterShooters],
        helicopterModels: this.units
          .filter((unit) => unit.alive && unit.type === "helicopter")
          .reduce((sum, unit) => sum + (unit.modelInstances?.length || 1), 0),
        meshyHelicopterUnits: this.units
          .filter((unit) => (
            unit.alive
            && unit.type === "helicopter"
            && unit.meshyModel
          )).length,
        helicopterUnits: this.units
          .filter((unit) => unit.alive && unit.type === "helicopter")
          .map((unit) => ({
            id: unit.id,
            callsign: unit.callsign,
            hp: Math.round(unit.hp),
            shotsFired: unit.shotsFired,
            order: unit.order?.type || "none",
            rotorAngle: Number((unit.rotors?.[0]?.object.rotation.y || 0).toFixed(3)),
            position: [
              Number(unit.position.x.toFixed(2)),
              Number(unit.position.z.toFixed(2))
            ]
          })),
        helicopterRotors: this.units
          .filter((unit) => unit.alive && unit.type === "helicopter")
          .reduce((sum, unit) => sum + (unit.rotors?.length || 0), 0),
        marineUnits: this.units
          .filter((unit) => unit.alive && unit.type === "marine")
          .map((unit) => {
            const rig = unit.marineRig;
            let weaponAlignment = null;
            let gripError = null;
            let weaponDownAlignment = null;
            let weaponForwardAlignment = null;
            let supportHandError = null;
            let stockShoulderError = null;
            let rightWristStraightness = null;
            let leftWristStraightness = null;
            let rifleSocketSpan = null;
            let handGripSpan = null;
            if (
              rig?.rightHand
              && rig?.leftHand
              && rig?.gripAnchor
              && rig?.muzzleAnchor
              && !rig.strategic
            ) {
              unit.group.updateMatrixWorld(true);
              const right = rig.rightHand.getWorldPosition(new THREE.Vector3());
              const left = rig.leftHand.getWorldPosition(new THREE.Vector3());
              const grip = rig.gripAnchor.getWorldPosition(new THREE.Vector3());
              const muzzle = rig.muzzleAnchor.getWorldPosition(new THREE.Vector3());
              rifleSocketSpan = Number(muzzle.distanceTo(grip).toFixed(3));
              handGripSpan = Number(left.distanceTo(right).toFixed(3));
              const handDirection = left.sub(right);
              const weaponDirection = muzzle.sub(grip);
              if (
                handDirection.lengthSq() > 0.000001
                && weaponDirection.lengthSq() > 0.000001
              ) {
                weaponAlignment = Number(
                  handDirection.normalize()
                    .dot(weaponDirection.normalize())
                    .toFixed(3)
                );
                const planarWeaponDirection = weaponDirection.clone().setY(0);
                const planarForward = unit.forward.clone().setY(0);
                if (
                  planarWeaponDirection.lengthSq() > 0.000001
                  && planarForward.lengthSq() > 0.000001
                ) {
                  weaponForwardAlignment = Number(
                    planarWeaponDirection.normalize()
                      .dot(planarForward.normalize())
                      .toFixed(3)
                  );
                }
              }
              gripError = Number(grip.distanceTo(right).toFixed(3));
              const supportPoint = rig.weaponAnchor.localToWorld(
                new THREE.Vector3().fromArray(
                  unit.definition.weaponSupportPoint || [0.18, -0.02, 0]
                )
              );
              supportHandError = Number(
                supportPoint.distanceTo(
                  rig.leftHand.getWorldPosition(new THREE.Vector3())
                ).toFixed(3)
              );
              if (rig.rightShoulder) {
                const stockPoint = rig.weaponAnchor.localToWorld(
                  new THREE.Vector3().fromArray(
                    unit.definition.weaponStockPoint || [-0.5, 0.02, 0]
                  )
                );
                stockShoulderError = Number(
                  stockPoint.distanceTo(
                    rig.rightShoulder.getWorldPosition(new THREE.Vector3())
                  ).toFixed(3)
                );
              }
              if (rig.rightForeArm && rig.rightHand) {
                const rightElbow = rig.rightForeArm.getWorldPosition(
                  new THREE.Vector3()
                );
                const rightHandPosition = rig.rightHand.getWorldPosition(
                  new THREE.Vector3()
                );
                const rightArmDirection = rightHandPosition
                  .clone()
                  .sub(rightElbow)
                  .normalize();
                const rightHandDirection = new THREE.Vector3(0, 1, 0)
                  .applyQuaternion(
                    rig.rightHand.getWorldQuaternion(new THREE.Quaternion())
                  )
                  .normalize();
                rightWristStraightness = Number(
                  rightArmDirection.dot(rightHandDirection).toFixed(3)
                );
              }
              if (rig.leftForeArm && rig.leftHand) {
                const leftElbow = rig.leftForeArm.getWorldPosition(
                  new THREE.Vector3()
                );
                const leftHandPosition = rig.leftHand.getWorldPosition(
                  new THREE.Vector3()
                );
                const leftArmDirection = leftHandPosition
                  .clone()
                  .sub(leftElbow)
                  .normalize();
                const leftHandDirection = new THREE.Vector3(0, 1, 0)
                  .applyQuaternion(
                    rig.leftHand.getWorldQuaternion(new THREE.Quaternion())
                  )
                  .normalize();
                leftWristStraightness = Number(
                  leftArmDirection.dot(leftHandDirection).toFixed(3)
                );
              }
              const weaponQuaternion = rig.weaponAnchor.getWorldQuaternion(
                new THREE.Quaternion()
              );
              weaponDownAlignment = Number(
                (-new THREE.Vector3(0, -1, 0)
                  .applyQuaternion(weaponQuaternion)
                  .normalize()
                  .dot(WORLD_UP))
                  .toFixed(3)
              );
            }
            return {
              id: unit.id,
              order: unit.order?.type || "none",
              animationState: unit.animationState || "ready",
              animationStatesSeen: [...(unit.animationStatesSeen || [])],
              skinned: Boolean(rig),
              meshy: Boolean(unit.meshyModel),
              meshyAnimation: Boolean(
                rig?.meshy
                && !rig?.strategic
              ),
              strategicLod: Boolean(rig?.strategic),
              restPoseSource: rig?.restPoseSource || null,
              weaponBone: rig?.rightHand?.name || null,
              supportHandBone: rig?.leftHand?.name || null,
              weaponAlignment,
              weaponForwardAlignment,
              gripError,
              supportHandError,
              stockShoulderError,
              weaponDownAlignment,
              rightWristStraightness,
              leftWristStraightness,
              rifleSocketSpan,
              handGripSpan,
              referenceAnimationSource: rig?.referenceSource || null,
              referenceAnimationClip: rig?.referenceClipName || null,
              referenceAnimationTime: rig?.referencePose?.time ?? null,
              onLand: this.isWorldLand(unit.position, 0),
              shotsFired: unit.shotsFired
            };
          }),
        enemyGroundUnits: this.units
          .filter((unit) => unit.alive && unit.type === "enemyMarine")
          .map((unit) => {
            const rig = unit.marineRig;
            let weaponForwardAlignment = null;
            let weaponDownAlignment = null;
            if (rig?.weaponAnchor && rig?.gripAnchor && rig?.muzzleAnchor) {
              unit.group.updateMatrixWorld(true);
              const grip = rig.gripAnchor.getWorldPosition(new THREE.Vector3());
              const muzzle = rig.muzzleAnchor.getWorldPosition(new THREE.Vector3());
              const weaponDirection = muzzle.sub(grip).setY(0);
              const forward = unit.forward.clone().setY(0);
              if (
                weaponDirection.lengthSq() > 0.000001
                && forward.lengthSq() > 0.000001
              ) {
                weaponForwardAlignment = Number(
                  weaponDirection.normalize()
                    .dot(forward.normalize())
                    .toFixed(3)
                );
              }
              const weaponQuaternion = rig.weaponAnchor.getWorldQuaternion(
                new THREE.Quaternion()
              );
              weaponDownAlignment = Number(
                (-new THREE.Vector3(0, -1, 0)
                  .applyQuaternion(weaponQuaternion)
                  .normalize()
                  .dot(WORLD_UP))
                  .toFixed(3)
              );
            }
            return {
              id: unit.id,
              order: unit.order?.type || "none",
              animationState: unit.animationState || "ready",
              animationStatesSeen: [...(unit.animationStatesSeen || [])],
              skinned: Boolean(unit.marineRig),
              meshy: Boolean(unit.meshyModel),
              meshyAnimation: Boolean(
                unit.marineRig?.meshy
                && !unit.marineRig?.strategic
              ),
              strategicLod: Boolean(unit.marineRig?.strategic),
              weaponBone: unit.marineRig?.rightHand?.name || null,
              weaponForwardAlignment,
              weaponDownAlignment,
              gripError: rig?.bakedPoseMetrics?.gripError ?? null,
              supportHandError:
                rig?.bakedPoseMetrics?.supportHandError ?? null,
              stockShoulderError:
                rig?.bakedPoseMetrics?.stockShoulderError ?? null,
              strategicAimParentYaw:
                rig?.bakedPoseMetrics?.strategicAimParentYaw ?? null,
              referenceAnimationSource:
                rig?.bakedPoseMetrics?.referenceSource ?? null,
              referenceAnimationClip:
                rig?.bakedPoseMetrics?.referenceClip ?? null,
              onLand: this.isWorldLand(unit.position, 0),
              shotsFired: unit.shotsFired
            };
          }),
        missileLaunchDot: this.missileLaunchDots.length
          ? Math.min(...this.missileLaunchDots)
          : 1,
        missileTargetDot: this.missileTargetLaunchDots.length
          ? Math.min(...this.missileTargetLaunchDots)
          : 1,
        guidedLaunches: this.guidedLaunches,
        guidedHits: this.guidedHits,
        guidedMisses: this.guidedMisses,
        guidedAborts: this.guidedAborts,
        guidedEvades: this.guidedEvades,
        projectileAxisDot: Number(this.projectileAxisMinimumDot.toFixed(3)),
        straightFlightDot: Number(this.straightFlightMinimumDot.toFixed(3)),
        curvedMissiles: this.projectiles.filter((shot) => Boolean(shot.curve)).length,
        guidanceTurns: this.guidanceTurnSamples.length,
        mainRotorAngle: Number((
          this.units.find((unit) => unit.alive && unit.type === "helicopter")
            ?.rotors?.[0]?.object.rotation.y || 0
        ).toFixed(3))
      },
      fx: this.fx?.getStats?.() || {},
      audio: this.audioManager?.getStats?.() || {
        ready: false,
        unlocked: false,
        loadedBuffers: 0,
        activeVoices: 0,
        activeLoops: 0
      },
      orientation: this.units
        .filter((unit) => unit.alive && unit.definition.domain === "sea")
        .map((unit) => ({
          id: unit.id,
          position: [
            Number(unit.position.x.toFixed(3)),
            Number(unit.position.z.toFixed(3))
          ],
          order: unit.order?.type || "none",
          speed: Number(unit.currentSpeed.toFixed(3)),
          yaw: Number(unit.group.rotation.y.toFixed(3)),
          headingDot: unit.velocity.lengthSq() > 0.0001
            ? Number(unit.velocity.clone().normalize().dot(unit.forward).toFixed(3))
            : 1
        }))
    };
  }

  debugAttackAll() {
    this.selectUnits(this.units.filter((unit) => unit.team === "ally" && unit.alive));
    const enemy = this.units.find((unit) => unit.team === "enemy" && unit.alive);
    if (enemy) this.issueAttack(enemy);
  }

  debugFighterAttackAll() {
    this.selectUnits(
      this.units.filter((unit) => unit.team === "ally" && unit.type === "fighter" && unit.alive)
    );
    const enemy = this.units.find((unit) => unit.team === "enemy" && unit.alive);
    if (enemy) this.issueAttack(enemy);
  }

  debugAssault() {
    this.selectUnits(this.units.filter((unit) => unit.team === "ally" && unit.alive));
    const center = this.units
      .filter((unit) => unit.team === "enemy" && unit.alive)
      .reduce((sum, unit, index, array) => sum.add(unit.position).divideScalar(index === array.length - 1 ? array.length : 1), new THREE.Vector3());
    if (Number.isFinite(center.x)) this.issueMove(center, true);
  }
}

async function boot() {
  try {
    const [config, coastline, geo, audioConfig] = await Promise.all([
      fetchJson(DATA_URLS.combat),
      fetchJson(DATA_URLS.coastline),
      fetchJson(DATA_URLS.geo),
      fetchJson(DATA_URLS.audio)
    ]);
    const battle = new RtsCombat(config, coastline, geo, audioConfig);
    window.__HORMUZ_RTS__ = {
      getSnapshot: () => battle.getSnapshot(),
      start: () => battle.startBattle(),
      selectAll: () => battle.selectUnits(battle.units.filter((unit) => unit.team === "ally" && unit.alive)),
      attackAll: () => battle.debugAttackAll(),
      fighterAttackAll: () => battle.debugFighterAttackAll(),
      assault: () => battle.debugAssault(),
      setAutoBattle: (enabled) => battle.setAutoBattleEnabled(enabled),
      unlockAudio: () => battle.audioManager.unlock(),
      playAudio: (eventName) => battle.audioManager.play(eventName, battle.cameraFocus),
      getAudioStats: () => battle.audioManager.getStats(),
      setTimeScale: (value) => { battle.timeScale = clamp(Number(value) || 1, 0.25, 8); },
      setHud: (mode) => battle.setHud(mode),
      battle
    };
    await battle.init();
    const qaScenario = new URLSearchParams(location.search).get("qa");
    if (qaScenario === "strategic-visibility") {
      battle.config.battle.enemyEngageDelaySeconds = 999;
      battle.startBattle();
      battle.paused = true;
      battle.resetCameraOverview();
      battle.dom.shell.dataset.strategicVisibilityQa = "ready";
    } else if (qaScenario === "carrier-texture") {
      battle.config.battle.enemyEngageDelaySeconds = 999;
      battle.startBattle();
      battle.paused = true;
      const carrier = battle.units.find(
        (unit) => unit.team === "ally" && unit.type === "carrier" && unit.alive
      );
      if (carrier) {
        battle.selectUnits([carrier]);
        battle.cameraFollowUnit = null;
        battle.cameraFocus.copy(carrier.position).setY(0);
        battle.cameraHeight = 22;
        battle.cameraDistance = 18;
        battle.updateCameraPosition(true);
        battle.dom.shell.dataset.carrierTextureQa = "ready";
      } else {
        battle.dom.shell.dataset.carrierTextureQa = "missing";
      }
    } else if (qaScenario === "large-battle") {
      battle.config.battle.enemyEngageDelaySeconds = 0;
      battle.startBattle();
      battle.debugAssault();
      const marines = battle.units.filter(
        (unit) => unit.team === "ally" && unit.type === "marine" && unit.alive
      );
      marines.forEach((unit, index) => {
        const target = battle.resolveLandCommandTarget(
          unit,
          unit.position.clone().add(new THREE.Vector3(
            (index % 2 === 0 ? 1 : -1) * 2.2,
            0,
            2.6 + Math.floor(index / 2) * 0.35
          ))
        );
        unit.order = { type: "move", targetPos: target };
      });
      window.setTimeout(() => {
        const groundTarget = battle.units.find(
          (unit) => unit.team === "enemy" && unit.type === "enemyMarine" && unit.alive
        );
        if (groundTarget) {
          marines.forEach((unit) => {
            unit.order = { type: "attack", targetUnit: groundTarget };
          });
        }
        battle.dom.shell.dataset.marineAnimationQa = "combat-walk";
      }, 2600);
      battle.selectUnits(
        battle.units.filter(
          (unit) => unit.team === "ally" && unit.type === "destroyer" && unit.alive
        )
      );
      battle.resetCameraOverview();
      battle.dom.shell.dataset.largeBattleQa = (
        battle.units.filter((unit) => unit.team === "ally").length >= 18
        && battle.units.filter((unit) => unit.team === "enemy").length >= 33
        && battle.units.filter((unit) => unit.team === "civilian").length >= 3
        && marines.length >= 4
      ) ? "passed" : "failed";
    } else if (
      qaScenario === "marine-posture"
      || qaScenario === "enemy-posture"
    ) {
      battle.config.battle.enemyEngageDelaySeconds = 999;
      battle.startBattle();
      const enemyPostureQa = qaScenario === "enemy-posture";
      const qaView = new URLSearchParams(location.search).get("view") || "front";
      const marine = battle.units.find(
        (unit) => unit.team === "ally" && unit.type === "marine" && unit.alive
      );
      const enemyMarine = battle.units.find(
        (unit) => unit.team === "enemy"
          && unit.type === "enemyMarine"
          && unit.alive
      );
      if (marine && enemyMarine) {
        battle.landGroup.visible = false;
        if (battle.ocean) battle.ocean.visible = false;
        battle.scene.fog = null;
        battle.units.forEach((unit) => {
          if (unit === marine || unit === enemyMarine) return;
          unit.group.visible = false;
          unit.label.style.opacity = "0";
          if (unit.type === "enemyMarine") unit.alive = false;
        });
        if (enemyPostureQa) {
          battle.instancedLodBatches.forEach((batch) => {
            batch.mesh.visible = false;
            if (batch.detailRoot) batch.detailRoot.visible = false;
          });
        }
        if (enemyPostureQa && qaView !== "side") {
          marine.position.set(0, marine.placementAltitude, 1.8);
          enemyMarine.position.set(0, enemyMarine.placementAltitude, -1.8);
        } else {
          marine.position.set(-1.8, marine.placementAltitude, 0);
          enemyMarine.position.set(1.8, enemyMarine.placementAltitude, 0);
        }
        marine.position.y = marine.placementAltitude;
        enemyMarine.position.y = enemyMarine.placementAltitude;
        marine.hp = Math.max(marine.hp, 10_000);
        enemyMarine.hp = Math.max(enemyMarine.hp, 10_000);
        const allyForward = enemyMarine.position.clone()
          .sub(marine.position)
          .setY(0)
          .normalize();
        const enemyForward = allyForward.clone().multiplyScalar(-1);
        marine.forward.copy(allyForward);
        enemyMarine.forward.copy(enemyForward);
        marine.group.rotation.y = Math.atan2(allyForward.x, allyForward.z);
        enemyMarine.group.rotation.y = Math.atan2(enemyForward.x, enemyForward.z);
        marine.order = { type: "attack", targetUnit: enemyMarine };
        enemyMarine.order = { type: "attack", targetUnit: marine };
        battle.selected.clear();
        battle.inspectedEnemies.clear();
        battle.cameraFollowUnit = null;
        if (enemyPostureQa) {
          battle.cameraFocus.copy(enemyMarine.position).setY(0.86);
          battle.cameraHeight = 1.18;
          battle.cameraDistance = 2.45;
        } else {
          battle.cameraFocus.set(0, 0, 0);
          battle.cameraHeight = 3.6;
          battle.cameraDistance = 4.4;
        }
        battle.updateCameraPosition(true);
        window.setTimeout(() => {
          if (enemyPostureQa) {
            battle.dom.shell.dataset.enemyPostureQa = "ready";
          } else {
            battle.dom.shell.dataset.marinePostureQa = "ready";
          }
        }, 1600);
      } else {
        if (enemyPostureQa) {
          battle.dom.shell.dataset.enemyPostureQa = "missing";
        } else {
          battle.dom.shell.dataset.marinePostureQa = "missing";
        }
      }
    } else if (qaScenario === "marine-animation") {
      battle.config.battle.enemyEngageDelaySeconds = 999;
      battle.startBattle();
      const marines = battle.units.filter(
        (unit) => unit.team === "ally" && unit.type === "marine" && unit.alive
      );
      const groundEnemies = battle.units.filter(
        (unit) => unit.team === "enemy" && unit.type === "enemyMarine" && unit.alive
      );
      marines.forEach((unit, index) => {
        unit.order = {
          type: "move",
          targetPos: battle.resolveLandCommandTarget(
            unit,
            unit.position.clone().add(new THREE.Vector3(
              (index % 4 - 1.5) * 0.4,
              0,
              5.2 + Math.floor(index / 4) * 0.8
            ))
          )
        };
      });
      battle.selectUnits(marines);
      if (marines[0]) {
        battle.cameraFollowUnit = marines[0];
        battle.cameraFocus.copy(marines[0].position).setY(0);
        battle.cameraHeight = 7;
        battle.cameraDistance = 6;
        battle.updateCameraPosition(true);
      }
      battle.dom.shell.dataset.marineAnimationQa = "low-ready-walk";
      window.setTimeout(() => {
        marines.forEach((unit, index) => {
          let bestTarget = unit.position.clone();
          let bestDistance = 0;
          for (let step = 0; step < 16; step += 1) {
            const angle = (step + index * 0.5) / 16 * Math.PI * 2;
            const candidate = battle.resolveLandCommandTarget(
              unit,
              unit.position.clone().add(new THREE.Vector3(
                Math.cos(angle) * 5.2,
                0,
                Math.sin(angle) * 5.2
              ))
            );
            const distance = planarDistance(unit.position, candidate);
            if (distance > bestDistance) {
              bestTarget = candidate;
              bestDistance = distance;
            }
          }
          unit.order = { type: "attackMove", targetPos: bestTarget };
          unit.qaForceCombatWalkUntil = battle.elapsed + 4.5;
        });
        battle.dom.shell.dataset.marineAnimationQa = "rifle-up-walk";
      }, 4500);
      window.setTimeout(() => {
        const target = groundEnemies.find((unit) => unit.alive);
        if (target) {
          marines.forEach((unit) => {
            unit.order = { type: "attack", targetUnit: target };
          });
        }
        battle.dom.shell.dataset.marineAnimationQa = "aim-fire";
      }, 12_500);
    } else if (qaScenario === "fighter-attack" || qaScenario === "fighter-axis") {
      const fighterOption = battle.config.fleetSelection.options.fighter;
      const helicopterOption = battle.config.fleetSelection.options.helicopter;
      battle.fleetSelection.fighter = fighterOption.maximum;
      battle.fleetSelection.helicopter = helicopterOption.minimum;
      battle.updateFleetBuilder();
      battle.startBattle();
      battle.debugFighterAttackAll();
      if (qaScenario === "fighter-axis") battle.focusSelectedUnits();
    } else if (qaScenario === "helicopter-formation") {
      battle.fleetSelection.destroyer = battle.config.fleetSelection.options.destroyer.minimum;
      battle.fleetSelection.fighter = battle.config.fleetSelection.options.fighter.minimum;
      battle.fleetSelection.helicopter = battle.config.fleetSelection.options.helicopter.maximum;
      battle.updateFleetBuilder();
      battle.startBattle();
      const helicopters = battle.units.filter(
        (unit) => unit.team === "ally" && unit.type === "helicopter" && unit.alive
      );
      const enemy = battle.units.find((unit) => unit.team === "enemy" && unit.alive);
      if (enemy) {
        helicopters.forEach((unit, index) => {
          unit.position.set(
            enemy.position.x - 4.1,
            unit.definition.altitude,
            enemy.position.z + (index - 1) * 2.2
          );
        });
      }
      battle.selectUnits(helicopters);
      if (enemy) battle.issueAttack(enemy);
      battle.focusSelectedUnits();
    } else if (qaScenario === "destroyer-formation") {
      battle.fleetSelection.destroyer = battle.config.fleetSelection.options.destroyer.maximum;
      battle.fleetSelection.fighter = battle.config.fleetSelection.options.fighter.minimum;
      battle.fleetSelection.helicopter = battle.config.fleetSelection.options.helicopter.minimum;
      battle.updateFleetBuilder();
      battle.startBattle();
      battle.selectUnits(
        battle.units.filter((unit) => unit.team === "ally" && unit.type === "destroyer" && unit.alive)
      );
      battle.focusSelectedUnits();
    } else if (qaScenario === "coast-collision") {
      battle.fleetSelection.destroyer = battle.config.fleetSelection.options.destroyer.maximum;
      battle.fleetSelection.fighter = battle.config.fleetSelection.options.fighter.minimum;
      battle.fleetSelection.helicopter = battle.config.fleetSelection.options.helicopter.minimum;
      battle.updateFleetBuilder();
      battle.startBattle();
      const destroyers = battle.units.filter(
        (unit) => unit.team === "ally" && unit.type === "destroyer" && unit.alive
      );
      const landTarget = battle.units.find(
        (unit) => unit.team === "enemy" && unit.definition.domain === "land" && unit.alive
      );
      battle.selectUnits(destroyers);
      if (landTarget) {
        destroyers.forEach((unit, index) => {
          const offset = new THREE.Vector3((index - (destroyers.length - 1) * 0.5) * 1.2, 0, 0);
          unit.order = {
            type: "move",
            targetPos: landTarget.position.clone().add(offset)
          };
        });
        battle.lastCommand = `coast-test:${landTarget.id}`;
      }
      battle.dom.shell.dataset.shoreQa = "running";
      battle.focusSelectedUnits();
    } else if (qaScenario === "terrain-shake") {
      battle.startBattle();
      battle.resetCameraOverview();
      const impactUnit = battle.units.find(
        (unit) => unit.team === "enemy" && unit.alive
      );
      const triggerTerrainShake = () => {
        if (!impactUnit) return;
        battle.addExplosion(
          impactUnit.position,
          false,
          true,
          impactUnit.definition.domain === "sea"
        );
      };
      [700, 1900, 3100].forEach((delay) => {
        window.setTimeout(triggerTerrainShake, delay);
      });
      battle.dom.shell.dataset.terrainShakeQa = "scheduled";
    } else if (qaScenario === "ground-shadow") {
      battle.startBattle();
      const landUnits = battle.units.filter(
        (unit) => unit.definition.domain === "land" && unit.alive
      );
      const primaryLandUnit = landUnits[0];
      if (primaryLandUnit) {
        battle.cameraFollowUnit = null;
        battle.cameraFocus.copy(primaryLandUnit.position).setY(0);
        battle.cameraHeight = 11;
        battle.cameraDistance = 9;
        battle.updateCameraPosition(true);
      }
      const visibleGroundShadows = landUnits.filter(
        (unit) => unit.contactShadow?.visible
      );
      battle.dom.shell.dataset.groundShadowQa = String(visibleGroundShadows.length);
      battle.dom.shell.dataset.screenGroundShadowQa = String(
        landUnits.filter((unit) => unit.groundShadowElement).length
      );
      battle.dom.shell.dataset.groundShadowWorldY = visibleGroundShadows.length
        ? String(
          Number(
            (
              visibleGroundShadows[0].position.y
              + visibleGroundShadows[0].contactShadow.position.y
            ).toFixed(3)
          )
        )
        : "none";
    } else if (qaScenario === "enemy-selection") {
      battle.startBattle();
      const enemies = battle.units.filter((unit) => unit.team === "enemy" && unit.alive);
      const primaryEnemy = enemies[0];
      if (primaryEnemy) {
        battle.cameraFollowUnit = null;
        battle.cameraFocus.copy(primaryEnemy.position).setY(0);
        battle.cameraHeight = 18;
        battle.cameraDistance = 15;
        battle.updateCameraPosition(true);
        const targetPoint = primaryEnemy.position.clone();
        targetPoint.y += primaryEnemy.definition.desiredSize * 0.32;
        targetPoint.project(battle.camera);
        const rect = battle.canvas.getBoundingClientRect();
        battle.dom.shell.dataset.enemySelectionQaTarget = primaryEnemy.id;
        battle.dom.shell.dataset.enemySelectionQaX = String(
          Math.round((targetPoint.x * 0.5 + 0.5) * rect.width)
        );
        battle.dom.shell.dataset.enemySelectionQaY = String(
          Math.round((-targetPoint.y * 0.5 + 0.5) * rect.height)
        );
      }
    } else if (qaScenario === "campaign-success") {
      battle.startBattle();
      battle.destroyedEnemies = battle.config.battle.objectiveEnemyCount;
      battle.endBattle(true);
    } else if (qaScenario === "campaign-failure") {
      battle.startBattle();
      battle.endBattle(false);
    }
  } catch (error) {
    console.error(error);
    const fatal = document.getElementById("fatal-error");
    fatal.hidden = false;
    fatal.textContent = `RTS COMBAT BOOT ERROR\n${error?.message || error}`;
  }
}

boot();
