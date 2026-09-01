import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(
  projectRoot,
  "assets",
  "audio",
  "staging",
  "elevenlabs",
  "mobility-v1",
);
const manifestPath = path.join(
  outputRoot,
  "elevenlabs-mobility-sfx-manifest-v1.json",
);
const apiEndpoint =
  "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128";
const subscriptionEndpoint =
  "https://api.elevenlabs.io/v1/user/subscription";
const modelId = "eleven_text_to_sound_v2";
const promptInfluence = 0.76;
const force = process.argv.includes("--force");

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY_NOT_FOUND");

const targets = [
  {
    id: "fa18_engine_cruise_loop",
    group: "fighter",
    name_ko: "F/A-18E 순항 엔진 루프",
    file: "SFX_FA18_ENGINE_CRUISE_LOOP.mp3",
    duration: 6,
    loop: true,
    usage: "전투기 비행 중 각 기체 위치에서 반복",
    prompt: "Seamless six-second exterior loop of a carrier-based twin-engine military jet cruising at medium altitude over open sea. Dense turbofan roar, steady power, controlled air rush, no Doppler pass, no afterburner surge, no weapons, no voices, no music, no obvious loop seam.",
  },
  {
    id: "fa18_flyby",
    group: "fighter",
    name_ko: "F/A-18E 근접 통과",
    file: "SFX_FA18_FLYBY.mp3",
    duration: 4,
    loop: false,
    usage: "전투기가 카메라 가까이 고속 통과할 때",
    prompt: "One realistic close exterior flyby of a fast carrier fighter over the sea. Powerful twin turbofan approach, sharp Doppler pass from front to rear, forceful receding airframe roar, no weapon launch, no explosion, no voice, no music, one pass only.",
  },
  {
    id: "ddg_engine_underway_loop",
    group: "destroyer",
    name_ko: "구축함 항해 엔진 루프",
    file: "SFX_DDG_ENGINE_UNDERWAY_LOOP.mp3",
    duration: 8,
    loop: true,
    usage: "구축함 항해 중 반복",
    prompt: "Seamless eight-second exterior loop of a modern guided-missile destroyer underway at moderate speed. Deep gas-turbine propulsion hum transmitted through a steel hull, steady wake wash and restrained ocean spray, no horn, no weapons, no voices, no music, no obvious loop seam.",
  },
  {
    id: "fastboat_engine_loop",
    group: "enemy",
    name_ko: "고속정 엔진 루프",
    file: "SFX_FASTBOAT_ENGINE_LOOP.mp3",
    duration: 6,
    loop: true,
    usage: "이란 고속정 기동 중 반복",
    prompt: "Seamless six-second exterior loop of a small military fast-attack craft accelerating over choppy seawater. Multiple high-output marine engines, hard propeller wash, rapid hull slap and spray, steady aggressive speed, no gunfire, no voice, no music, no obvious loop seam.",
  },
  {
    id: "tanker_diesel_engine_loop",
    group: "civilian",
    name_ko: "대형 유조선 디젤 엔진 루프",
    file: "SFX_TANKER_DIESEL_ENGINE_LOOP.mp3",
    duration: 8,
    loop: true,
    usage: "유조선 호송 항해 중 반복",
    prompt: "Seamless eight-second exterior loop of a very large crude carrier moving slowly through open water. Massive low-frequency marine diesel throb, distant machinery vibration, broad wake and gentle hull wash, stable speed, no horn, no voice, no music, no obvious loop seam.",
  },
  {
    id: "open_sea_ambience_loop",
    group: "environment",
    name_ko: "호르무즈 해상 환경 루프",
    file: "SFX_OPEN_SEA_AMBIENCE_LOOP.mp3",
    duration: 12,
    loop: true,
    usage: "전투 전체 해상 환경 바탕음",
    prompt: "Seamless twelve-second open-sea ambience at dusk in a narrow shipping strait. Layered wind over water, small rolling waves, distant low surf and very faint maritime atmosphere, no birds, no horns, no engines in the foreground, no combat, no voices, no music, no obvious loop seam.",
  },
];

const baseHeaders = { "xi-api-key": apiKey };
const getSubscription = async () => {
  try {
    const response = await fetch(subscriptionEndpoint, { headers: baseHeaders });
    if (!response.ok) throw new Error(`HTTP_${response.status}: ${await response.text()}`);
    const data = await response.json();
    return {
      tier: data.tier,
      character_count: data.character_count,
      character_limit: data.character_limit,
      remaining: Math.max(0, data.character_limit - data.character_count),
      next_reset_unix: data.next_character_count_reset_unix,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
const exists = async (filePath) =>
  access(filePath).then(() => true).catch(() => false);
const sha256 = async (filePath) =>
  createHash("sha256").update(await readFile(filePath)).digest("hex");
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const expectedCreditsUpperBound = targets.reduce(
  (sum, target) => sum + Math.ceil(target.duration * 11),
  0,
);
const subscriptionBefore = await getSubscription();
if (
  Number.isFinite(subscriptionBefore.remaining)
  && subscriptionBefore.remaining < expectedCreditsUpperBound
) {
  throw new Error(
    `INSUFFICIENT_ELEVENLABS_CREDITS: remaining=${subscriptionBefore.remaining}, expected=${expectedCreditsUpperBound}`,
  );
}

await mkdir(outputRoot, { recursive: true });
const records = [];
for (const target of targets) {
  const targetPath = path.join(outputRoot, target.file);
  const tempPath = `${targetPath}.tmp`;
  let status = "generated";
  let characterCost = null;
  let requestId = null;
  let errorMessage = null;

  if ((await exists(targetPath)) && !force) {
    status = "existing";
  } else {
    await rm(tempPath, { force: true });
    if (force) await rm(targetPath, { force: true });
    try {
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          text: target.prompt,
          duration_seconds: target.duration,
          prompt_influence: promptInfluence,
          loop: target.loop,
          model_id: modelId,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `HTTP_${response.status}: ${(await response.text()).slice(0, 800)}`,
        );
      }
      await writeFile(tempPath, Buffer.from(await response.arrayBuffer()));
      await rename(tempPath, targetPath);
      characterCost = response.headers.get("character-cost");
      requestId = response.headers.get("request-id");
      const info = await stat(targetPath);
      console.log(`OK ${target.file} (${Math.round((info.size / 1024) * 10) / 10} KB)`);
    } catch (error) {
      await rm(tempPath, { force: true });
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`FAIL ${target.file}: ${errorMessage}`);
    }
  }

  const fileExists = await exists(targetPath);
  const info = fileExists ? await stat(targetPath) : null;
  records.push({
    id: target.id,
    group: target.group,
    name_ko: target.name_ko,
    file: target.file,
    relative_path: fileExists
      ? `assets/audio/staging/elevenlabs/mobility-v1/${target.file}`
      : null,
    bytes: info?.size ?? null,
    sha256: fileExists ? await sha256(targetPath) : null,
    duration_seconds: target.duration,
    loop: target.loop,
    usage: target.usage,
    prompt: target.prompt,
    prompt_influence: promptInfluence,
    model_id: modelId,
    output_format: "mp3_44100_128",
    character_cost: characterCost,
    request_id: requestId,
    status,
    error: errorMessage,
  });
  await delay(250);
}

const subscriptionAfter = await getSubscription();
const count = (status) =>
  records.filter((record) => record.status === status).length;
const manifest = {
  version: 1,
  project: "HORMUZ mobility and environment SFX",
  provider: "ElevenLabs",
  generated_at: new Date().toISOString(),
  api_endpoint: apiEndpoint,
  model_id: modelId,
  output_format: "mp3_44100_128",
  prompt_influence: promptInfluence,
  directive: "User requested all currently applicable audio to be integrated.",
  license_gate:
    "Generated on a free-tier account. Confirm current commercial-use and attribution terms before public release.",
  expected_credits_upper_bound: expectedCreditsUpperBound,
  subscription_before: subscriptionBefore,
  subscription_after: subscriptionAfter,
  counts: {
    requested: records.length,
    generated: count("generated"),
    existing: count("existing"),
    failed: count("failed"),
  },
  records,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`MANIFEST=${manifestPath}`);
console.log(`COUNTS=${JSON.stringify(manifest.counts)}`);
console.log(`SUBSCRIPTION_AFTER=${JSON.stringify(subscriptionAfter)}`);
