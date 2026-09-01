/**
 * Meshy 원본 GLB에서 전투 런타임용 감축 LOD를 만든다.
 *
 * Meshy 리메시(유료, 객체당 30크레딧) 대신 로컬 meshoptimizer 단순화를 쓴다.
 * 크레딧이 들지 않고 2048px 텍스처를 그대로 유지한다.
 *
 * 준비:
 *   npm install @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer
 *   (저장소에 node_modules 를 두지 않는다. 임시 폴더에서 설치해 실행하고 결과 GLB만 남긴다)
 *
 * 사용:
 *   node tools/make-battle-lod.mjs
 *
 * 한계:
 *   UV 이음매가 잠금 경계로 작동해 대략 원본의 40~45%가 실질 하한이다.
 *   그보다 더 줄여야 하면 Meshy 리메시로 새 변형을 받아야 한다. 유료이므로 사장님 승인 먼저.
 *   스킨(리깅) 메시는 가중치가 깨질 수 있으므로 이 스크립트로 줄이지 않는다.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs/promises';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(REPO, 'assets', 'models');

/**
 * src 는 항상 감축하지 않은 Meshy 원본(-web-v1.glb)을 쓴다.
 * 이미 줄인 파일을 또 줄이면 형상이 더 빨리 무너진다.
 */
const JOBS = [
  {
    src: 'combat-v1/mcm-usv-meshy6-web-v1.glb',
    out: 'combat-v1/mcm-usv-meshy6-web-battle-lod-v1.glb',
    target: 5000
  }
];

// 목표에 못 미치면 오차 허용치를 올려가며 재시도한다.
const ERROR_STEPS = [0.02, 0.06, 0.12, 0.25, 0.5, 1.0];
const ACCEPT_SLACK = 1.15;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const triOf = (document) => document.getRoot().listMeshes().reduce(
  (sum, mesh) => sum + mesh.listPrimitives().reduce((inner, primitive) => {
    const indices = primitive.getIndices();
    const position = primitive.getAttribute('POSITION');
    const count = indices ? indices.getCount() : (position ? position.getCount() : 0);
    return inner + Math.floor(count / 3);
  }, 0),
  0
);

await MeshoptSimplifier.ready;
const report = [];

for (const job of JOBS) {
  const srcPath = path.join(MODELS, job.src);
  const outPath = path.join(MODELS, job.out);
  let best = null;

  for (const error of ERROR_STEPS) {
    const document = await io.read(srcPath);
    const before = triOf(document);
    const ratio = Math.min(1, job.target / before);
    await document.transform(
      dedup(),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
      prune()
    );
    best = { document, before, after: triOf(document), error };
    if (best.after <= job.target * ACCEPT_SLACK) break;
  }

  await io.write(outPath, best.document);
  const srcSize = (await fs.stat(srcPath)).size;
  const outSize = (await fs.stat(outPath)).size;
  report.push({ out: job.out, before: best.before, after: best.after, error: best.error, srcSize, outSize });
  console.log(`${job.out}\n  tri ${best.before} -> ${best.after}  error=${best.error}  bytes ${srcSize} -> ${outSize}`);
  if (best.after > job.target * ACCEPT_SLACK) {
    console.log('  주의 — 목표에 도달하지 못했다. UV 이음매 한계다. 더 줄이려면 Meshy 리메시 승인이 필요하다.');
  }
}

await fs.writeFile(
  path.join(MODELS, 'battle-lod-report-v1.json'),
  JSON.stringify({
    generator: '@gltf-transform + meshoptimizer simplify',
    note: '전투 런타임 LOD.',
    jobs: report
  }, null, 2),
  'utf-8'
);
console.log(`\n기록: ${path.join(MODELS, 'battle-lod-report-v1.json')}`);
