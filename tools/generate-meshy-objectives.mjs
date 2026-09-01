/**
 * 전투 목표물 2종을 Meshy 로 만든다.
 *
 * 전수조사에서 모델이 아예 없던 것은 둘뿐이었다 — 해상 기뢰와 곡괭이산 지하
 * 진입부. 지금은 절차형 도형으로 그려져서 기뢰가 빨간 표식처럼 보인다.
 * 둘 다 움직이지 않는 물체라 리깅·애니메이션이 필요 없다.
 *
 * 승인 범위는 60크레딧이다. 그래서 매 단계마다 소모량을 확인하고 넘으면 멈춘다.
 * 참조 이미지가 없어 text-to-3d 를 쓴다(기존 유닛은 image-to-3d 로 만들었다).
 *
 * 사용:
 *   node tools/generate-meshy-objectives.mjs
 *   node tools/generate-meshy-objectives.mjs --resume
 */
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
/* 경로가 기능마다 다르다. 잔액은 v1, text-to-3d 는 v2 에만 있다. */
const apiRoot = "https://api.meshy.ai/openapi";
const versionFor = (endpoint) => (endpoint.startsWith("text-to-3d") ? "v2" : "v1");
const apiKey = process.env.MESHY_API_KEY;
const pollMilliseconds = 5000;
const timeoutMilliseconds = 40 * 60 * 1000;
const resume = process.argv.includes("--resume");
const creditCeiling = 60;

if (!apiKey) throw new Error("MESHY_API_KEY 가 없습니다.");

const assets = [
  {
    id: "naval-mine",
    targetPolycount: 1200,
    prompt:
      "A moored naval contact mine, dark spherical steel body with several "
      + "protruding Hertz horn detonators, heavy weathered black and rust paint, "
      + "short mooring shackle at the bottom, single object, no water, no base, "
      + "no text, no logo",
    negativePrompt: "text, logo, watermark, display stand, water, ground plane, character",
    texturePrompt:
      "Weathered dark steel naval mine, matte black paint with rust streaks and "
      + "salt residue, clean realistic game asset, no text, no logo, no baked shadow."
  },
  {
    id: "bunker-entrance",
    targetPolycount: 1600,
    prompt:
      "A reinforced underground facility tunnel entrance built into a rocky "
      + "hillside, thick concrete portal frame, heavy blast door recessed inside, "
      + "surrounding excavated rock face, single object, no text, no logo",
    negativePrompt: "text, logo, watermark, display stand, vehicle, character, sky",
    texturePrompt:
      "Gray reinforced concrete portal and dry desert rock face, matte weathered "
      + "surface, clean realistic game asset, no text, no logo, no baked shadow."
  }
];

const outputRoot = path.join(projectRoot, "assets", "meshy-source", "objectives-v1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let spentCredits = 0;

function guardCredits(next) {
  if (spentCredits + next > creditCeiling) {
    throw new Error(
      `승인 범위 ${creditCeiling}크레딧을 넘습니다. 지금까지 ${spentCredits}, 추가 ${next}.`
    );
  }
}

async function requestJson(endpoint, options, operation) {
  const response = await fetch(`${apiRoot}/${versionFor(endpoint)}/${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers || {})
    }
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${operation}: ${response.status} 비정상 응답 ${body.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${operation}: ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function createOrResume({ taskType, outputDirectory, body, idFileName }) {
  const idPath = path.join(outputDirectory, idFileName);
  if (resume) {
    try {
      const kept = (await fs.readFile(idPath, "utf8")).trim();
      if (kept) {
        process.stdout.write(`${taskType} 이어받기 ${kept}\n`);
        return kept;
      }
    } catch { /* 이어받을 것이 없으면 새로 만든다 */ }
  }
  const created = await requestJson(taskType, {
    method: "POST", body: JSON.stringify(body)
  }, `${taskType} 생성`);
  if (!created.result) throw new Error(`${taskType} 작업 번호 없음: ${JSON.stringify(created)}`);
  await fs.writeFile(idPath, `${created.result}\n`, "ascii");
  process.stdout.write(`${taskType} 생성됨 ${created.result}\n`);
  return created.result;
}

async function waitForTask(taskType, taskId) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastLogged = -1;
  while (Date.now() < deadline) {
    const task = await requestJson(`${taskType}/${taskId}`, { method: "GET" },
      `${taskType} 조회`);
    const progress = task.progress ?? 0;
    if (progress !== lastLogged) {
      process.stdout.write(
        `  ${taskType} ${task.status} ${progress}% · ${task.consumed_credits ?? 0}크레딧\n`
      );
      lastLogged = progress;
    }
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELED") {
      throw new Error(`${taskType} ${task.status}: ${JSON.stringify(task.task_error ?? {})}`);
    }
    await sleep(pollMilliseconds);
  }
  throw new Error(`${taskType} ${taskId} 시간 초과`);
}

async function download(url, outputPath) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`내려받기 실패 ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
  process.stdout.write(`  저장 ${path.basename(outputPath)} ${(bytes.length / 1024).toFixed(0)}KB\n`);
  return { outputPath, bytes: bytes.length };
}

async function generate(asset) {
  const outputDirectory = path.join(outputRoot, asset.id);
  await fs.mkdir(outputDirectory, { recursive: true });
  process.stdout.write(`\n== ${asset.id} ==\n`);

  guardCredits(5);
  const previewId = await createOrResume({
    taskType: "text-to-3d",
    outputDirectory,
    idFileName: "preview-task-id.txt",
    body: {
      mode: "preview",
      prompt: asset.prompt,
      negative_prompt: asset.negativePrompt,
      art_style: "realistic",
      ai_model: "meshy-5",
      target_polycount: asset.targetPolycount,
      topology: "triangle",
      symmetry_mode: "auto"
    }
  });
  const preview = await waitForTask("text-to-3d", previewId);
  spentCredits += preview.consumed_credits ?? 0;

  guardCredits(10);
  const refineId = await createOrResume({
    taskType: "text-to-3d",
    outputDirectory,
    idFileName: "refine-task-id.txt",
    body: {
      mode: "refine",
      preview_task_id: previewId,
      enable_pbr: false,
      texture_prompt: asset.texturePrompt
    }
  });
  const refined = await waitForTask("text-to-3d", refineId);
  spentCredits += refined.consumed_credits ?? 0;

  await fs.writeFile(
    path.join(outputDirectory, "task.json"),
    `${JSON.stringify({ preview, refined }, null, 2)}\n`
  );
  await download(refined.model_urls?.glb,
    path.join(outputDirectory, `${asset.id}-meshy-v1.glb`));
  await download(refined.thumbnail_url,
    path.join(outputDirectory, `${asset.id}-preview-v1.png`));
  process.stdout.write(`  누적 ${spentCredits}크레딧 / 승인 ${creditCeiling}\n`);
  return { id: asset.id, previewId, refineId, credits: spentCredits };
}

const balance = await requestJson("balance", { method: "GET" }, "잔액 조회");
process.stdout.write(`잔액 ${balance.balance}크레딧 · 승인 범위 ${creditCeiling}\n`);

const results = [];
for (const asset of assets) results.push(await generate(asset));
await fs.writeFile(
  path.join(outputRoot, "meshy-objectives-tasks-v1.json"),
  `${JSON.stringify({ creditCeiling, spentCredits, results }, null, 2)}\n`
);
process.stdout.write(`\n완료. 총 ${spentCredits}크레딧 사용.\n`);
