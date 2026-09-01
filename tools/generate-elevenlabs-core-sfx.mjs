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
  "core-v1",
);
const manifestPath = path.join(
  outputRoot,
  "elevenlabs-core-sfx-manifest-v1.json",
);
const apiEndpoint =
  "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128";
const subscriptionEndpoint =
  "https://api.elevenlabs.io/v1/user/subscription";
const modelId = "eleven_text_to_sound_v2";
const promptInfluence = 0.75;

const args = process.argv.slice(2);
const readArgument = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const only = readArgument("--only");
const variantOption = readArgument("--variant", "ALL").toUpperCase();
const force = args.includes("--force");
if (!["A", "B", "ALL"].includes(variantOption)) {
  throw new Error(`INVALID_VARIANT: ${variantOption}`);
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY_NOT_FOUND");

const targets = [
  {
    id: "mk45_fire_close",
    group: "destroyer",
    name_ko: "Mk 45 함포 근거리 발사",
    duration: 2.2,
    loop: false,
    usage: "알레이버크급 구축함 함포 발사",
    prompts: {
      A: "Single close-range firing of a modern naval five-inch deck gun on an open warship deck. Enormous sharp muzzle blast, heavy low-frequency pressure wave, metallic breech recoil and short ocean-air tail. One shot only. No voices, no music, no machine gun, no explosion impact.",
      B: "One isolated Mk 45-style naval gun discharge heard from the ship deck. Violent cannon crack, deep concussive thump, dense steel recoil mechanism and brief open-sea reflection. Cinematic but realistic field recording. One shot only, dry enough for a game mix, no voices or music.",
    },
  },
  {
    id: "fa18_harpoon_launch",
    group: "fighter",
    name_ko: "F/A-18E 대함 미사일 발사",
    duration: 2.2,
    loop: false,
    usage: "전투기 파일런 분리와 대함 미사일 점화",
    prompts: {
      A: "Air-launched anti-ship missile release from a fast carrier fighter. Brief mechanical pylon clunk, half-second clean drop, then hard rocket-motor ignition and rapidly receding jet roar. Exterior perspective, realistic, one launch only, no voices, no music, no impact.",
      B: "Single heavy missile leaving a fighter aircraft wing station: metallic rack release, air rush, delayed rocket ignition, forceful exhaust blast moving forward into the distance. Real military aviation sound design, clear three-stage sequence, no voice, no music, no explosion hit.",
    },
  },
  {
    id: "mh60_gau21_burst",
    group: "helicopter",
    name_ko: "MH-60R GAU-21 중기관총 점사",
    duration: 1.6,
    loop: false,
    usage: "헬기 근거리 고속정 공격",
    prompts: {
      A: "Short controlled burst from a door-mounted .50 caliber heavy machine gun on a military helicopter, six to eight distinct powerful shots, deep mechanical report, sharp supersonic cracks, subtle airframe vibration. No rotor sound, no voices, no music, no impacts.",
      B: "One compact GAU-21-style 12.7mm helicopter gun burst, heavy rhythmic punches with strong low-end and metallic feed action, clearly separated rounds, close exterior microphone. No rotor, no shell impacts, no voice, no music.",
    },
  },
  {
    id: "mh60_m240d_burst",
    group: "helicopter",
    name_ko: "MH-60R M240D 기관총 점사",
    duration: 1.4,
    loop: false,
    usage: "헬기 경량 기관총 사격",
    prompts: {
      A: "Short burst from an M240D 7.62mm helicopter door gun, eight fast crisp shots, lighter and faster than a .50 caliber gun, dry metallic action and belt feed. No rotor sound, no voices, no music, no impacts.",
      B: "One brief 7.62 NATO medium machine gun burst from an aircraft mount, rapid sharp reports with compact mechanical clatter and restrained low end, clearly different from a heavy machine gun. No helicopter rotor, no voice, no music.",
    },
  },
  {
    id: "mh60_guided_weapon_launch",
    group: "helicopter",
    name_ko: "MH-60R 유도무기 발사",
    duration: 1.8,
    loop: false,
    usage: "APKWS II 또는 Hellfire 발사",
    prompts: {
      A: "Single guided rocket launched from a naval helicopter weapon rail. Sharp electrical ignition snap, compact rocket blast, hot exhaust hiss and fast forward whoosh. Exterior perspective, one launch only, no rotor, no voice, no music, no impact.",
      B: "One helicopter-fired Hellfire-style missile launch: brief rail release, aggressive rocket motor ignition, dense exhaust pressure and rapidly receding flight sound. Realistic military field recording, isolated launch, no voice, no music, no explosion impact.",
    },
  },
  {
    id: "mh60_rotor_loop",
    group: "helicopter",
    name_ko: "MH-60R 로터 비행 루프",
    duration: 4,
    loop: true,
    usage: "헬기 접근·선회·정지 비행",
    prompts: {
      A: "Seamless four-second loop of a modern naval helicopter main rotor in steady low-altitude flight over open water. Heavy four-blade rotor thump, smooth turbine bed, stable speed, exterior medium distance. No weapons, no voice, no music, no pitch change.",
      B: "Seamless military helicopter hover loop over the sea, powerful rhythmic rotor blade slap with restrained turbine whine and subtle ocean air, consistent RPM and no obvious loop seam. No gunfire, no voices, no music.",
    },
  },
  {
    id: "naval_explosion_large",
    group: "impact",
    name_ko: "대형 선체 폭발",
    duration: 2.8,
    loop: false,
    usage: "함선 격파 또는 대형 유도무기 명중",
    prompts: {
      A: "Single large anti-ship missile explosion against a steel vessel at sea. Immediate dense detonation, deep pressure wave, tearing metal, secondary debris and short open-water tail. Powerful but realistic, one impact only, no voices, no music.",
      B: "Heavy naval hull explosion heard at medium distance: hard initial blast, massive low-frequency body, steel rupture, scattered debris and restrained ocean reflection. One cinematic realistic event, no repeated blasts, no voice, no music.",
    },
  },
  {
    id: "water_impact_heavy",
    group: "impact",
    name_ko: "대형 수면 착탄",
    duration: 2,
    loop: false,
    usage: "함포 또는 미사일이 바다에 빗나감",
    prompts: {
      A: "Heavy naval shell striking open seawater nearby. Sharp supersonic arrival, dense water detonation, towering splash and falling spray. No metal hit, no ship damage, no voices, no music, one impact only.",
      B: "One large projectile impact into the sea, forceful underwater thump followed by a tall water plume, broad splash and short rain of droplets. Exterior ocean perspective, realistic, no ship collision, no voice, no music.",
    },
  },
];

const selectedTargets = targets.filter(
  (target) => !only || target.id.includes(only),
);
if (selectedTargets.length === 0) {
  throw new Error(`NO_TARGETS_MATCHED: ${only}`);
}
const variantNames =
  variantOption === "ALL" ? ["A", "B"] : [variantOption];
const expectedCreditsUpperBound = selectedTargets.reduce(
  (sum, target) =>
    sum + Math.ceil(target.duration * 11) * variantNames.length,
  0,
);

const baseHeaders = { "xi-api-key": apiKey };
const getSubscription = async () => {
  try {
    const response = await fetch(subscriptionEndpoint, {
      headers: baseHeaders,
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}: ${await response.text()}`);
    }
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

const subscriptionBefore = await getSubscription();
if (
  Number.isFinite(subscriptionBefore.remaining) &&
  subscriptionBefore.remaining < expectedCreditsUpperBound
) {
  throw new Error(
    `INSUFFICIENT_ELEVENLABS_CREDITS: remaining=${subscriptionBefore.remaining}, expected=${expectedCreditsUpperBound}`,
  );
}

await mkdir(outputRoot, { recursive: true });
const records = [];

for (const target of selectedTargets) {
  for (const variant of variantNames) {
    const stem = `SFX_${target.id.toUpperCase()}_${variant}`;
    const fileName = `${stem}.mp3`;
    const targetPath = path.join(outputRoot, fileName);
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
            text: target.prompts[variant],
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
        console.log(
          `OK ${fileName} (${Math.round((info.size / 1024) * 10) / 10} KB)`,
        );
      } catch (error) {
        await rm(tempPath, { force: true });
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`FAIL ${fileName}: ${errorMessage}`);
      }
    }

    const fileExists = await exists(targetPath);
    const info = fileExists ? await stat(targetPath) : null;
    records.push({
      id: target.id,
      group: target.group,
      name_ko: target.name_ko,
      variant,
      file: fileName,
      relative_path: fileExists
        ? `assets/audio/staging/elevenlabs/core-v1/${fileName}`
        : null,
      bytes: info?.size ?? null,
      sha256: fileExists ? await sha256(targetPath) : null,
      duration_seconds: target.duration,
      loop: target.loop,
      usage: target.usage,
      prompt: target.prompts[variant],
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
}

const subscriptionAfter = await getSubscription();
const count = (status) =>
  records.filter((record) => record.status === status).length;
const manifest = {
  version: 1,
  project: "HORMUZ core combat SFX audition",
  provider: "ElevenLabs",
  generated_at: new Date().toISOString(),
  api_endpoint: apiEndpoint,
  model_id: modelId,
  output_format: "mp3_44100_128",
  prompt_influence: promptInfluence,
  license_gate:
    "Generated on a free-tier account. Keep in staging until current commercial-use and attribution terms are confirmed.",
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

