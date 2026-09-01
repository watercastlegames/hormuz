import * as THREE from "./vendor/three.module.js";

const MAX_WAKE_SEGMENTS = 32;
const WAKE_LIFETIME = 5.4;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function createRadialTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.18, "rgba(255,255,255,.95)");
  gradient.addColorStop(0.52, "rgba(255,255,255,.34)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createParticleLayer(root, capacity, blending) {
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);
  const particles = Array.from({ length: capacity }, () => ({
    life: 0,
    maxLife: 0,
    velocity: new THREE.Vector3(),
    gravity: 0,
    drag: 0,
    growth: 0,
    spin: 0
  }));
  for (let index = 0; index < capacity; index++) positions[index * 3 + 1] = -1000;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending,
    uniforms: {
      pixelRatio: { value: Math.min(devicePixelRatio || 1, 2) }
    },
    vertexShader: `
      attribute float aSize;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float pixelRatio;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = clamp(aSize * pixelRatio * (390.0 / max(1.0, -viewPosition.z)), 1.0, 96.0);
        vColor = color;
        vAlpha = aAlpha;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 centered = gl_PointCoord - vec2(.5);
        float radius = length(centered);
        float body = 1.0 - smoothstep(.16, .5, radius);
        float core = 1.0 - smoothstep(0.0, .18, radius);
        gl_FragColor = vec4(vColor * (1.0 + core * .45), vAlpha * body);
      }
    `
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 8;
  root.add(points);
  return { capacity, positions, colors, sizes, alphas, particles, geometry, points, cursor: 0 };
}

function createWakeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `
  });
}

export class CombatFx {
  constructor(root) {
    this.root = root;
    this.radialTexture = createRadialTexture();
    this.hotParticles = createParticleLayer(root, 560, THREE.AdditiveBlending);
    this.smokeParticles = createParticleLayer(root, 240, THREE.NormalBlending);
    this.flashes = [];
    this.wakes = new Set();
    this.wakeMaterial = createWakeMaterial();
  }

  spawnParticle(layer, options) {
    let slot = -1;
    for (let offset = 0; offset < layer.capacity; offset++) {
      const index = (layer.cursor + offset) % layer.capacity;
      if (layer.particles[index].life <= 0) {
        slot = index;
        break;
      }
    }
    if (slot < 0) slot = layer.cursor;
    layer.cursor = (slot + 1) % layer.capacity;

    const particle = layer.particles[slot];
    particle.life = options.life;
    particle.maxLife = options.life;
    particle.velocity.copy(options.velocity);
    particle.gravity = options.gravity || 0;
    particle.drag = options.drag || 0;
    particle.growth = options.growth || 0;
    const color = new THREE.Color(options.color);
    layer.positions[slot * 3] = options.position.x;
    layer.positions[slot * 3 + 1] = options.position.y;
    layer.positions[slot * 3 + 2] = options.position.z;
    layer.colors[slot * 3] = color.r;
    layer.colors[slot * 3 + 1] = color.g;
    layer.colors[slot * 3 + 2] = color.b;
    layer.sizes[slot] = options.size;
    layer.alphas[slot] = options.alpha ?? 1;
  }

  flash(position, color, size = 1, life = 0.2) {
    const layers = [
      { scale: 1, alpha: 1, growth: size * 5.4 },
      { scale: 0.56, alpha: 0.92, growth: size * 3.1 },
      { scale: 0.22, alpha: 1, growth: size * 1.4 }
    ];
    layers.forEach((layer, index) => {
      this.spawnParticle(this.hotParticles, {
        position,
        velocity: new THREE.Vector3(0, index * 0.025, 0),
        color: index === 2 ? 0xffffff : color,
        size: size * layer.scale,
        alpha: layer.alpha,
        life: life * (1 + index * 0.08),
        growth: layer.growth,
        drag: 8
      });
    });
  }

  muzzle(position, color, weapon) {
    const size = weapon === "missile" ? 0.72 : weapon === "rocket" ? 0.48 : 0.34;
    this.flash(position, color, size, weapon === "missile" ? 0.18 : 0.1);
    const count = weapon === "missile" ? 7 : 3;
    for (let index = 0; index < count; index++) {
      this.spawnParticle(this.hotParticles, {
        position,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 1.2,
          0.3 + Math.random() * 1.2,
          (Math.random() - 0.5) * 1.2
        ),
        color,
        size: 0.13 + Math.random() * 0.11,
        life: 0.18 + Math.random() * 0.18,
        gravity: -1.4,
        drag: 2.5
      });
    }
  }

  missileSmoke(position, enemy = false) {
    if (Math.random() > 0.72) {
      this.spawnParticle(this.smokeParticles, {
        position,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.16,
          0.18 + Math.random() * 0.2,
          (Math.random() - 0.5) * 0.16
        ),
        color: enemy ? 0x5b4a42 : 0x44565a,
        size: 0.48 + Math.random() * 0.24,
        alpha: 0.34,
        life: 1.25 + Math.random() * 0.6,
        drag: 0.5,
        growth: 0.48
      });
    }
  }

  impact(position, options = {}) {
    const large = Boolean(options.large);
    const water = Boolean(options.water);
    const friendlyFire = Boolean(options.friendlyFire);
    const hotColor = friendlyFire ? 0xbffaff : 0xffa24f;
    this.flash(position, hotColor, large ? 2.8 : 1.35, large ? 0.34 : 0.2);

    const sparkCount = large ? 30 : 14;
    for (let index = 0; index < sparkCount; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (large ? 2.6 : 1.5) * (0.45 + Math.random());
      this.spawnParticle(this.hotParticles, {
        position,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          0.8 + Math.random() * (large ? 3.2 : 1.8),
          Math.sin(angle) * speed
        ),
        color: index % 3 === 0 ? 0xfff4c2 : hotColor,
        size: 0.14 + Math.random() * 0.18,
        life: 0.4 + Math.random() * (large ? 0.8 : 0.45),
        gravity: -4.2,
        drag: 0.65
      });
    }

    const smokeCount = large ? 9 : 4;
    for (let index = 0; index < smokeCount; index++) {
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * (large ? 0.7 : 0.3),
        Math.random() * 0.3,
        (Math.random() - 0.5) * (large ? 0.7 : 0.3)
      );
      this.spawnParticle(this.smokeParticles, {
        position: position.clone().add(offset),
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.4,
          0.8 + Math.random() * 1.1,
          (Math.random() - 0.5) * 0.4
        ),
        color: index % 3 === 0 ? 0x58483c : 0x263238,
        size: (large ? 1.45 : 0.75) * (0.72 + Math.random() * 0.55),
        alpha: 0.42,
        life: 1.9 + Math.random() * (large ? 1.5 : 0.8),
        gravity: 0.08,
        drag: 0.55,
        growth: large ? 0.9 : 0.48
      });
    }

    if (water) {
      const splashCount = large ? 34 : 18;
      for (let index = 0; index < splashCount; index++) {
        const angle = Math.random() * Math.PI * 2;
        const radial = 0.35 + Math.random() * (large ? 2.4 : 1.25);
        this.spawnParticle(this.hotParticles, {
          position: position.clone().setY(0.1),
          velocity: new THREE.Vector3(
            Math.cos(angle) * radial,
            1.6 + Math.random() * (large ? 4.8 : 2.8),
            Math.sin(angle) * radial
          ),
          color: index % 4 === 0 ? 0xffffff : 0x9eeef3,
          size: 0.13 + Math.random() * 0.22,
          alpha: 0.82,
          life: 0.55 + Math.random() * 0.75,
          gravity: -5.8,
          drag: 0.34
        });
      }
    }
  }

  bunkerPenetratorImpact(position) {
    this.flash(position, 0xffd39a, 4.8, 0.48);

    for (let index = 0; index < 72; index++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.4 + Math.random() * 5.4;
      const lowShockwave = index < 28;
      this.spawnParticle(this.hotParticles, {
        position: position.clone().setY(Math.max(0.16, position.y)),
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          lowShockwave ? 0.25 + Math.random() * 0.55 : 1.8 + Math.random() * 5.8,
          Math.sin(angle) * speed
        ),
        color: index % 4 === 0 ? 0xfff3c4 : 0xd5a06d,
        size: 0.18 + Math.random() * 0.34,
        alpha: 0.94,
        life: 0.7 + Math.random() * 1.25,
        gravity: lowShockwave ? -0.8 : -5.2,
        drag: lowShockwave ? 1.35 : 0.58,
        growth: lowShockwave ? 0.65 : 0.18
      });
    }

    for (let index = 0; index < 34; index++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 1.15;
      const column = index < 16;
      this.spawnParticle(this.smokeParticles, {
        position: position.clone().add(new THREE.Vector3(
          Math.cos(angle) * radius,
          Math.random() * 0.45,
          Math.sin(angle) * radius
        )),
        velocity: new THREE.Vector3(
          Math.cos(angle) * (column ? 0.45 : 1.65) * Math.random(),
          (column ? 2.4 : 1.1) + Math.random() * (column ? 4.6 : 2.4),
          Math.sin(angle) * (column ? 0.45 : 1.65) * Math.random()
        ),
        color: index % 5 === 0 ? 0x5f5143 : index % 2 === 0 ? 0x9a8064 : 0x75604c,
        size: 1.25 + Math.random() * 1.65,
        alpha: 0.58,
        life: 3.4 + Math.random() * 2.3,
        gravity: 0.04,
        drag: column ? 0.38 : 0.62,
        growth: 1.05 + Math.random() * 0.72
      });
    }
  }

  createWake(color) {
    const vertexCount = MAX_WAKE_SEGMENTS * 12;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometry.setAttribute(
      "aAlpha",
      new THREE.BufferAttribute(new Float32Array(vertexCount), 1).setUsage(THREE.DynamicDrawUsage)
    );
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geometry, this.wakeMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.root.add(mesh);
    const wake = {
      mesh,
      geometry,
      color: new THREE.Color(color),
      samples: [],
      sampleCooldown: 0,
      stopped: false
    };
    this.wakes.add(wake);
    return wake;
  }

  sampleWake(wake, position, forward, speed, maxSpeed, beam, sternOffset, delta) {
    if (!wake || wake.stopped) return;
    wake.sampleCooldown -= delta;
    if (speed < maxSpeed * 0.07) return;
    if (wake.sampleCooldown > 0 && wake.samples.length) return;
    wake.sampleCooldown = 0.09;
    const normalizedForward = forward.clone().setY(0).normalize();
    const stern = position.clone()
      .addScaledVector(normalizedForward, -sternOffset)
      .setY(0.055);
    const previous = wake.samples[wake.samples.length - 1];
    if (previous && previous.position.distanceToSquared(stern) < 0.018) return;
    wake.samples.push({
      position: stern,
      right: new THREE.Vector3(normalizedForward.z, 0, -normalizedForward.x),
      age: 0,
      beam,
      intensity: clamp(speed / Math.max(maxSpeed, 0.001), 0.12, 1)
    });
    if (wake.samples.length > MAX_WAKE_SEGMENTS + 1) wake.samples.shift();
  }

  stopWake(wake) {
    if (wake) wake.stopped = true;
  }

  updateWakeGeometry(wake) {
    const positions = wake.geometry.attributes.position.array;
    const colors = wake.geometry.attributes.color.array;
    const alphas = wake.geometry.attributes.aAlpha.array;
    let cursor = 0;
    const setVertex = (point, alpha) => {
      positions[cursor * 3] = point.x;
      positions[cursor * 3 + 1] = point.y;
      positions[cursor * 3 + 2] = point.z;
      colors[cursor * 3] = wake.color.r;
      colors[cursor * 3 + 1] = wake.color.g;
      colors[cursor * 3 + 2] = wake.color.b;
      alphas[cursor] = alpha;
      cursor++;
    };
    const addQuad = (aLeft, aRight, bLeft, bRight, alphaA, alphaB) => {
      setVertex(aLeft, alphaA);
      setVertex(bLeft, alphaB);
      setVertex(bRight, alphaB);
      setVertex(aLeft, alphaA);
      setVertex(bRight, alphaB);
      setVertex(aRight, alphaA);
    };

    const samples = wake.samples;
    for (let index = 0; index < samples.length - 1 && cursor < MAX_WAKE_SEGMENTS * 12; index++) {
      const a = samples[index];
      const b = samples[index + 1];
      const fadeA = Math.pow(clamp(1 - a.age / WAKE_LIFETIME, 0, 1), 1.65) * a.intensity;
      const fadeB = Math.pow(clamp(1 - b.age / WAKE_LIFETIME, 0, 1), 1.65) * b.intensity;
      const spreadA = a.beam * (0.27 + a.age * 0.035);
      const spreadB = b.beam * (0.27 + b.age * 0.035);
      const widthA = a.beam * (0.055 + a.age * 0.018);
      const widthB = b.beam * (0.055 + b.age * 0.018);
      for (const side of [-1, 1]) {
        const aCenter = a.position.clone().addScaledVector(a.right, side * spreadA);
        const bCenter = b.position.clone().addScaledVector(b.right, side * spreadB);
        addQuad(
          aCenter.clone().addScaledVector(a.right, -widthA),
          aCenter.clone().addScaledVector(a.right, widthA),
          bCenter.clone().addScaledVector(b.right, -widthB),
          bCenter.clone().addScaledVector(b.right, widthB),
          fadeA * 0.48,
          fadeB * 0.48
        );
      }
    }
    wake.geometry.setDrawRange(0, cursor);
    wake.geometry.attributes.position.needsUpdate = true;
    wake.geometry.attributes.color.needsUpdate = true;
    wake.geometry.attributes.aAlpha.needsUpdate = true;
  }

  updateParticleLayer(layer, delta) {
    for (let index = 0; index < layer.capacity; index++) {
      const particle = layer.particles[index];
      if (particle.life <= 0) continue;
      particle.life -= delta;
      if (particle.life <= 0) {
        layer.alphas[index] = 0;
        layer.positions[index * 3 + 1] = -1000;
        continue;
      }
      const dragFactor = Math.exp(-particle.drag * delta);
      particle.velocity.multiplyScalar(dragFactor);
      particle.velocity.y += particle.gravity * delta;
      layer.positions[index * 3] += particle.velocity.x * delta;
      layer.positions[index * 3 + 1] += particle.velocity.y * delta;
      layer.positions[index * 3 + 2] += particle.velocity.z * delta;
      layer.sizes[index] += particle.growth * delta;
      const normalized = particle.life / particle.maxLife;
      layer.alphas[index] = Math.min(1, normalized * 2.4) * Math.pow(normalized, 0.58);
    }
    layer.geometry.attributes.position.needsUpdate = true;
    layer.geometry.attributes.color.needsUpdate = true;
    layer.geometry.attributes.aAlpha.needsUpdate = true;
    layer.geometry.attributes.aSize.needsUpdate = true;
  }

  update(delta) {
    this.updateParticleLayer(this.hotParticles, delta);
    this.updateParticleLayer(this.smokeParticles, delta);

    for (const wake of this.wakes) {
      wake.samples.forEach((sample) => { sample.age += delta; });
      wake.samples = wake.samples.filter((sample) => sample.age < WAKE_LIFETIME);
      this.updateWakeGeometry(wake);
    }
  }

  getStats() {
    return {
      hotParticles: this.hotParticles.particles.filter((particle) => particle.life > 0).length,
      smokeParticles: this.smokeParticles.particles.filter((particle) => particle.life > 0).length,
      flashes: this.flashes.length,
      wakes: this.wakes.size,
      wakeSamples: [...this.wakes].reduce((sum, wake) => sum + wake.samples.length, 0)
    };
  }
}
