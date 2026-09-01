const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { NodeIO, Accessor } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const { MeshoptDecoder, MeshoptEncoder } = require("meshoptimizer");

const repo = path.resolve(__dirname, "..");
const outputDir = path.join(repo, "assets", "models", "battle-ultra-v2");
const tempDir = path.join(repo, "output", "meshy-ultra-v2-temp");

const jobs = [
  {
    id: "destroyer",
    source: "assets/models/ships-v1/arleigh-burke-destroyer-meshy6-web-v1.glb",
    output: "arleigh-burke-destroyer-meshy-ultra-v2.glb",
    ratio: 0.022,
    tint: [0.28, 0.32, 0.34, 1]
  },
  {
    id: "fighter",
    source: "assets/models/combat-v1/fa-18e-super-hornet-meshy6-web-v1.glb",
    output: "fa-18e-super-hornet-meshy-ultra-v2.glb",
    ratio: 0.012,
    tint: [0.38, 0.4, 0.4, 1]
  },
  {
    id: "helicopter",
    source: "assets/models/combat-v1/mh-60r-seahawk-meshy6-web-v1.glb",
    output: "mh-60r-seahawk-meshy-ultra-v2.glb",
    ratio: 0.016,
    tint: [0.22, 0.28, 0.25, 1]
  },
  {
    id: "carrier",
    source: "assets/models/ships-v1/nimitz-carrier-meshy6-web-v1.glb",
    output: "nimitz-carrier-meshy-ultra-v2.glb",
    ratio: 0.03,
    tint: [0.28, 0.32, 0.34, 1]
  },
  {
    id: "usv",
    source: "assets/models/combat-v1/mcm-usv-meshy6-web-v1.glb",
    output: "mcm-usv-meshy-ultra-v2.glb",
    ratio: 0.015,
    tint: [0.24, 0.3, 0.31, 1]
  },
  {
    id: "bomber",
    source: "assets/models/combined-arms-v1/b2-spirit-meshy-t2-web-v1.glb",
    output: "b2-spirit-meshy-ultra-v2.glb",
    ratio: 0.08,
    tint: [0.1, 0.11, 0.12, 1]
  },
  {
    id: "fastBoat",
    source: "assets/models/combat-v1/irgc-fast-attack-craft-meshy6-web-v1.glb",
    output: "irgc-fast-attack-craft-meshy-ultra-v2.glb",
    ratio: 0.012,
    tint: [0.18, 0.16, 0.1, 1]
  },
  {
    id: "tanker",
    source: "assets/models/strategic-v1/vlcc-tanker-meshy6-web-v1.glb",
    output: "vlcc-tanker-meshy-ultra-v2.glb",
    ratio: 0.024,
    tint: [0.44, 0.41, 0.34, 1]
  },
  {
    id: "tel",
    source: "assets/models/strategic-v1/coastal-defense-tel-meshy6-web-v1.glb",
    output: "coastal-defense-tel-meshy-ultra-v2.glb",
    ratio: 0.018,
    tint: [0.2, 0.15, 0.08, 1]
  }
];

async function bakeCleanVertexColors(job, interimPath) {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder
    });
  const document = await io.read(path.join(repo, job.source));
  const texturesToDispose = new Set();

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const normal = primitive.getAttribute("NORMAL");
      const material = primitive.getMaterial();
      const texture = material?.getBaseColorTexture();
      if (!position || !material) continue;

      const positions = position.getArray();
      const normals = normal?.getArray() || null;
      const colors = new Float32Array(position.getCount() * 4);
      let minY = Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < position.getCount(); index += 1) {
        const y = positions[index * 3 + 1];
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const heightRange = Math.max(0.0001, maxY - minY);

      for (let index = 0; index < position.getCount(); index += 1) {
        const height = (positions[index * 3 + 1] - minY) / heightRange;
        const up = normals ? Math.max(0, normals[index * 3 + 1]) : 0;
        const shade = 0.84 + height * 0.06 + up * 0.1;
        colors[index * 4] = Math.min(1, job.tint[0] * shade);
        colors[index * 4 + 1] = Math.min(1, job.tint[1] * shade);
        colors[index * 4 + 2] = Math.min(1, job.tint[2] * shade);
        colors[index * 4 + 3] = 1;
      }

      const color = document.createAccessor()
        .setType(Accessor.Type.VEC4)
        .setArray(colors);
      primitive.setAttribute("COLOR_0", color);
      primitive.setAttribute("TEXCOORD_0", null);
      material.setBaseColorTexture(null);
      material.setBaseColorFactor([1, 1, 1, 1]);
      material.setMetallicFactor(0.05);
      material.setRoughnessFactor(0.78);
      if (texture) texturesToDispose.add(texture);
    }
  }

  for (const texture of texturesToDispose) texture.dispose();
  await io.write(interimPath, document);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const report = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";

  for (const job of jobs) {
    const interimPath = path.join(tempDir, `${job.id}-vertex-color.glb`);
    const outputPath = path.join(outputDir, job.output);
    await bakeCleanVertexColors(job, interimPath);
    execFileSync(npx, [
      "--yes",
      "gltfpack",
      "-i", interimPath,
      "-o", outputPath,
      "-c",
      "-si", String(job.ratio),
      "-se", "0.15",
      "-sp",
      "-vpf",
      "-vc", "8"
    ], { stdio: "inherit", shell: process.platform === "win32" });
    report.push({
      id: job.id,
      source: job.source,
      output: `assets/models/battle-ultra-v2/${job.output}`,
      targetRatio: job.ratio,
      colorSource: "Clean unit-type PBR palette with height and upward-normal shading",
      uvRemoved: true,
      sourceTextureRemoved: true,
      bytes: fs.statSync(outputPath).size
    });
  }

  fs.writeFileSync(
    path.join(outputDir, "meshy-ultra-lod-report-v2.json"),
    JSON.stringify({
      generator: "Meshy source GLB -> clean PBR vertex palette -> UV removal -> gltfpack simplification",
      purpose: "Clean strategic LOD color without damaged texture-atlas UVs or baked atlas noise",
      jobs: report
    }, null, 2)
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("Meshy ultra LOD v2 complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
