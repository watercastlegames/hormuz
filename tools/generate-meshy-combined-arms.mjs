import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const apiBase = "https://api.meshy.ai/openapi/v1";
const apiKey = process.env.MESHY_API_KEY;
const pollMilliseconds = 5000;
const timeoutMilliseconds = 40 * 60 * 1000;
const resume = process.argv.includes("--resume");

if (!apiKey) {
  throw new Error("MESHY_API_KEY is not available in this process.");
}

const assets = [
  {
    id: "b2-spirit",
    reference: "b2-spirit-reference-v1.png",
    targetPolycount: 5000,
    character: false,
    texturePrompt:
      "Operational B-2A Spirit stealth bomber, charcoal gray radar-absorbing skin, crisp flying-wing silhouette, restrained panel detail, no logo, no text, no markings, no baked shadow, no display stand."
  },
  {
    id: "us-marine-rifleman",
    reference: "us-marine-rifleman-tpose-reference-v1.png",
    targetPolycount: 2400,
    character: true,
    heightMeters: 1.8,
    texturePrompt:
      "Modern United States Marine rifleman in coyote brown and multicam combat equipment, realistic clean game asset, no weapon, no logo, no text, no rank insignia, no baked shadow."
  },
  {
    id: "irgc-ground-combatant",
    reference: "irgc-ground-combatant-tpose-reference-v1.png",
    targetPolycount: 2400,
    character: true,
    heightMeters: 1.76,
    texturePrompt:
      "Modern Iranian IRGC ground combatant in olive drab tactical equipment, realistic clean game asset, no weapon, no logo, no text, no flag, no baked shadow."
  },
  {
    id: "m27-rifle",
    reference: "m27-rifle-reference-v1.png",
    targetPolycount: 800,
    character: false,
    texturePrompt:
      "Modern M27-style infantry automatic rifle, matte black and dark earth finish, clean realistic game asset, no logo, no text, no markings, no display stand, no baked shadow."
  },
  {
    id: "ak-rifle",
    reference: "ak-rifle-reference-v1.png",
    targetPolycount: 800,
    character: false,
    texturePrompt:
      "Modern AK-pattern infantry rifle, matte black metal and dark polymer furniture, clean realistic game asset, no logo, no text, no markings, no display stand, no baked shadow."
  }
];

const referenceRoot = path.join(
  projectRoot,
  "assets",
  "meshy-references",
  "combined-arms-v1"
);
const outputRoot = path.join(
  projectRoot,
  "assets",
  "meshy-source",
  "combined-arms-v1"
);

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function readJsonResponse(response, operation) {
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `${operation} returned ${response.status} with non-JSON body: ${body.slice(0, 500)}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `${operation} failed with ${response.status}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed;
}

async function requestJson(endpoint, options, operation) {
  return readJsonResponse(
    await fetch(`${apiBase}/${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...(options?.headers || {})
      }
    }),
    operation
  );
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readPersistedId(filePath) {
  if (!resume) return null;
  try {
    return (await fs.readFile(filePath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function createOrResumeTask({
  taskType,
  outputDirectory,
  body,
  idFileName
}) {
  const idPath = path.join(outputDirectory, idFileName);
  const persistedId = await readPersistedId(idPath);
  if (persistedId) {
    process.stdout.write(`${taskType} resume ${persistedId}\n`);
    return persistedId;
  }
  const created = await requestJson(
    taskType,
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    `Create ${taskType} task`
  );
  if (!created.result) {
    throw new Error(`${taskType} did not return a task id: ${JSON.stringify(created)}`);
  }
  await fs.writeFile(idPath, `${created.result}\n`, "ascii");
  process.stdout.write(`${taskType} created ${created.result}\n`);
  return created.result;
}

async function waitForTask(taskType, taskId) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const task = await requestJson(
      `${taskType}/${taskId}`,
      { method: "GET" },
      `Retrieve ${taskType} task`
    );
    process.stdout.write(
      `${taskType} ${taskId} ${task.status} ${task.progress ?? 0}% ${task.consumed_credits ?? 0} credits\n`
    );
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELED") {
      throw new Error(
        `${taskType} ${taskId} ${task.status}: ${JSON.stringify(task.task_error ?? {})}`
      );
    }
    await sleep(pollMilliseconds);
  }
  throw new Error(`${taskType} ${taskId} timed out after 40 minutes.`);
}

async function download(url, outputPath) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
  return {
    path: outputPath,
    bytes: bytes.length
  };
}

function collectDownloads(value, prefix = "result", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = `${prefix}_${key}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (typeof child === "string" && /^https?:\/\//.test(child)) {
      found.push({ key: nextPrefix, url: child });
    } else if (child && typeof child === "object") {
      collectDownloads(child, nextPrefix, found);
    }
  }
  return found;
}

function extensionFromUrl(url, fallback = ".bin") {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return extension && extension.length <= 8 ? extension : fallback;
  } catch {
    return fallback;
  }
}

async function downloadResultUrls(task, outputDirectory, stem, preferred = {}) {
  const completed = [];
  const usedUrls = new Set();
  for (const [label, url] of Object.entries(preferred)) {
    if (!url || usedUrls.has(url)) continue;
    usedUrls.add(url);
    const extension = extensionFromUrl(url, label.includes("model") ? ".glb" : ".bin");
    const outputPath = path.join(outputDirectory, `${stem}-${label}${extension}`);
    const result = await download(url, outputPath);
    if (result) completed.push({ label, ...result });
  }
  for (const { key, url } of collectDownloads(task)) {
    if (usedUrls.has(url)) continue;
    usedUrls.add(url);
    const outputPath = path.join(
      outputDirectory,
      `${stem}-${key}${extensionFromUrl(url)}`
    );
    const result = await download(url, outputPath);
    if (result) completed.push({ label: key, ...result });
  }
  return completed;
}

async function generateImageModel(asset) {
  const outputDirectory = path.join(outputRoot, asset.id);
  await fs.mkdir(outputDirectory, { recursive: true });
  const referencePath = path.join(referenceRoot, asset.reference);
  const referenceBytes = await fs.readFile(referencePath);
  const imageUrl = `data:image/png;base64,${referenceBytes.toString("base64")}`;
  const settings = {
    image_url: imageUrl,
    model_type: "smart-topology",
    ai_model: "meshy-t2",
    target_polycount: asset.targetPolycount,
    should_texture: true,
    texture_resolution: "2k",
    enable_pbr: false,
    texture_prompt: asset.texturePrompt,
    target_formats: ["glb"],
    alpha_thumbnail: true,
    ...(asset.character ? { pose_mode: "t-pose" } : {})
  };
  const taskId = await createOrResumeTask({
    taskType: "image-to-3d",
    outputDirectory,
    body: settings,
    idFileName: "image-task-id.txt"
  });
  const task = await waitForTask("image-to-3d", taskId);
  await writeJson(path.join(outputDirectory, "image-task.json"), task);
  const downloads = await downloadResultUrls(
    task,
    outputDirectory,
    `${asset.id}-meshy-t2-v1`,
    {
      model: task.model_urls?.glb,
      preview: task.thumbnail_url,
      alpha_preview: task.alpha_thumbnail_url,
      base_color: task.texture_urls?.[0]?.base_color
    }
  );
  return {
    asset,
    outputDirectory,
    imageTaskId: taskId,
    imageTask: task,
    imageDownloads: downloads
  };
}

async function rigCharacter(generated) {
  const { asset, outputDirectory, imageTaskId } = generated;
  const rigTaskId = await createOrResumeTask({
    taskType: "rigging",
    outputDirectory,
    body: {
      input_task_id: imageTaskId,
      height_meters: asset.heightMeters
    },
    idFileName: "rig-task-id.txt"
  });
  const rigTask = await waitForTask("rigging", rigTaskId);
  await writeJson(path.join(outputDirectory, "rig-task.json"), rigTask);
  const rigDownloads = await downloadResultUrls(
    rigTask,
    outputDirectory,
    `${asset.id}-meshy-rig-v1`,
    {
      rigged_model: rigTask.result?.rigged_character_glb_url,
      walking:
        rigTask.result?.basic_animations?.walking_glb_url
        || rigTask.result?.basic_animations?.walking?.glb_url,
      running:
        rigTask.result?.basic_animations?.running_glb_url
        || rigTask.result?.basic_animations?.running?.glb_url
    }
  );
  const animationTaskId = await createOrResumeTask({
    taskType: "animations",
    outputDirectory,
    body: {
      rig_task_id: rigTaskId,
      action_id: 690
    },
    idFileName: "combat-animation-task-id.txt"
  });
  const animationTask = await waitForTask("animations", animationTaskId);
  await writeJson(
    path.join(outputDirectory, "combat-animation-task.json"),
    animationTask
  );
  const animationDownloads = await downloadResultUrls(
    animationTask,
    outputDirectory,
    `${asset.id}-meshy-combat-animation-v1`,
    {
      combat:
        animationTask.result?.animation_glb_url
        || animationTask.result?.glb_url
        || animationTask.model_urls?.glb
    }
  );
  return {
    ...generated,
    rigTaskId,
    rigTask,
    rigDownloads,
    animationTaskId,
    animationTask,
    animationDownloads
  };
}

await fs.mkdir(outputRoot, { recursive: true });
process.stdout.write(`Meshy combined-arms pipeline: ${resume ? "resume" : "new"}\n`);

const imageResults = await Promise.all(assets.map(generateImageModel));
const finalResults = await Promise.all(imageResults.map(async (result) => (
  result.asset.character ? rigCharacter(result) : result
)));

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  generator: path.relative(projectRoot, import.meta.filename),
  assets: finalResults.map((result) => ({
    id: result.asset.id,
    reference: path.join(referenceRoot, result.asset.reference),
    targetPolycount: result.asset.targetPolycount,
    imageTaskId: result.imageTaskId,
    imageCredits: result.imageTask.consumed_credits ?? 0,
    imageDownloads: result.imageDownloads,
    rigTaskId: result.rigTaskId ?? null,
    rigCredits: result.rigTask?.consumed_credits ?? 0,
    rigDownloads: result.rigDownloads ?? [],
    animationTaskId: result.animationTaskId ?? null,
    animationCredits: result.animationTask?.consumed_credits ?? 0,
    animationDownloads: result.animationDownloads ?? []
  }))
};
manifest.totalCredits = manifest.assets.reduce(
  (sum, asset) => (
    sum + asset.imageCredits + asset.rigCredits + asset.animationCredits
  ),
  0
);
await writeJson(path.join(outputRoot, "meshy-combined-arms-tasks-v1.json"), manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
