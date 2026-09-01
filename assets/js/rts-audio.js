import * as THREE from "./vendor/three.module.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class RtsAudioManager {
  constructor(camera, scene, config) {
    this.camera = camera;
    this.scene = scene;
    this.config = config || { masterVolume: 0.7, events: {} };
    this.listener = new THREE.AudioListener();
    this.camera.add(this.listener);
    this.loader = new THREE.AudioLoader();
    this.buffers = new Map();
    this.sequence = new Map();
    this.lastPlayedAt = new Map();
    this.active = new Map();
    this.loops = new Map();
    this.ready = false;
    this.unlocked = false;
    this.stats = {
      requested: 0,
      played: 0,
      skippedCooldown: 0,
      missingBuffer: 0,
      loadFailures: 0,
      activeLoops: 0
    };
  }

  get context() {
    return this.listener.context;
  }

  async preload() {
    const files = new Set(
      Object.values(this.config.events || {})
        .flatMap((event) => event.files || [])
    );
    await Promise.all([...files].map(async (file) => {
      try {
        this.buffers.set(file, await this.loader.loadAsync(file));
      } catch {
        this.stats.loadFailures += 1;
      }
    }));
    this.ready = this.buffers.size > 0;
    return this.ready;
  }

  async unlock() {
    try {
      if (this.context.state === "suspended") await this.context.resume();
      this.unlocked = this.context.state === "running";
    } catch {
      this.unlocked = false;
    }
    return this.unlocked;
  }

  pickFile(eventName, definition) {
    const files = (definition.files || []).filter((file) => this.buffers.has(file));
    if (!files.length) return null;
    const index = this.sequence.get(eventName) || 0;
    this.sequence.set(eventName, index + 1);
    return files[index % files.length];
  }

  makeHost(source) {
    if (source?.isObject3D) return { host: source, temporary: false };
    const host = new THREE.Object3D();
    if (source?.isVector3) host.position.copy(source);
    this.scene.add(host);
    return { host, temporary: true };
  }

  cleanupVoice(eventName, voice) {
    const voices = this.active.get(eventName) || [];
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    voice.host.remove(voice.audio);
    voice.audio.disconnect();
    if (voice.temporary) this.scene.remove(voice.host);
  }

  play(eventName, source) {
    this.stats.requested += 1;
    const definition = this.config.events?.[eventName];
    if (!definition || !this.ready || !this.unlocked) return false;
    const now = performance.now() / 1000;
    const cooldown = Math.max(0, definition.cooldownSeconds || 0);
    if (now - (this.lastPlayedAt.get(eventName) || -Infinity) < cooldown) {
      this.stats.skippedCooldown += 1;
      return false;
    }
    const file = this.pickFile(eventName, definition);
    const buffer = file ? this.buffers.get(file) : null;
    if (!buffer) {
      this.stats.missingBuffer += 1;
      return false;
    }

    const voices = this.active.get(eventName) || [];
    const maxVoices = Math.max(1, definition.maxVoices || 4);
    while (voices.length >= maxVoices) {
      const oldest = voices.shift();
      if (oldest.audio.isPlaying) oldest.audio.stop();
      this.cleanupVoice(eventName, oldest);
    }

    const spatial = definition.spatial !== false;
    const { host, temporary } = spatial
      ? this.makeHost(source)
      : { host: this.camera, temporary: false };
    const audio = spatial
      ? new THREE.PositionalAudio(this.listener)
      : new THREE.Audio(this.listener);
    audio.setBuffer(buffer);
    audio.setVolume(clamp(
      (this.config.masterVolume ?? 0.7) * (definition.volume ?? 1),
      0,
      1
    ));
    if (spatial) {
      audio.setRefDistance(definition.refDistance || 25);
      audio.setMaxDistance(definition.maxDistance || 180);
      audio.setRolloffFactor(definition.rolloffFactor ?? 0.8);
      audio.setDistanceModel("inverse");
    }
    const voice = { audio, host, temporary, file };
    audio.onEnded = () => {
      audio.isPlaying = false;
      this.cleanupVoice(eventName, voice);
    };
    host.add(audio);
    voices.push(voice);
    this.active.set(eventName, voices);
    this.lastPlayedAt.set(eventName, now);
    audio.play();
    this.stats.played += 1;
    return true;
  }

  startLoop(eventName, source, loopId) {
    if (this.loops.has(loopId)) return true;
    const definition = this.config.events?.[eventName];
    if (!definition || !this.ready || !this.unlocked) return false;
    const file = this.pickFile(eventName, definition);
    const buffer = file ? this.buffers.get(file) : null;
    if (!buffer) {
      this.stats.missingBuffer += 1;
      return false;
    }
    const spatial = definition.spatial !== false;
    const { host, temporary } = spatial
      ? this.makeHost(source)
      : { host: this.camera, temporary: false };
    const audio = spatial
      ? new THREE.PositionalAudio(this.listener)
      : new THREE.Audio(this.listener);
    audio.setBuffer(buffer);
    audio.setLoop(true);
    audio.setVolume(clamp(
      (this.config.masterVolume ?? 0.7) * (definition.volume ?? 1),
      0,
      1
    ));
    if (spatial) {
      audio.setRefDistance(definition.refDistance || 12);
      audio.setMaxDistance(definition.maxDistance || 120);
      audio.setRolloffFactor(definition.rolloffFactor ?? 1);
      audio.setDistanceModel("inverse");
    }
    host.add(audio);
    audio.play();
    this.loops.set(loopId, { eventName, audio, host, temporary, file });
    this.stats.activeLoops = this.loops.size;
    return true;
  }

  stopLoop(loopId) {
    const loop = this.loops.get(loopId);
    if (!loop) return;
    if (loop.audio.isPlaying) loop.audio.stop();
    loop.host.remove(loop.audio);
    loop.audio.disconnect();
    if (loop.temporary) this.scene.remove(loop.host);
    this.loops.delete(loopId);
    this.stats.activeLoops = this.loops.size;
  }

  stopAll() {
    this.stopAllLoops();
    for (const [eventName, voices] of this.active) {
      for (const voice of [...voices]) {
        if (voice.audio.isPlaying) voice.audio.stop();
        this.cleanupVoice(eventName, voice);
      }
    }
  }

  stopAllLoops() {
    for (const loopId of [...this.loops.keys()]) this.stopLoop(loopId);
  }

  getStats() {
    return {
      ...this.stats,
      ready: this.ready,
      unlocked: this.unlocked,
      loadedBuffers: this.buffers.size,
      activeVoices: [...this.active.values()].reduce((sum, voices) => sum + voices.length, 0)
    };
  }
}
