const path = require("node:path");
const sharp = require("../../catAgentGame/node_modules/sharp");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "output", "step0");
const targetPath = path.join(output, "hormuz-ui-cinematic-concept-v1.png");
const currentPath = path.join(output, "mockup-meshy-cinematic-v4-desktop-1600x900.png");
const comparisonPath = path.join(output, "quality-comparison-concept-vs-v4-3200x900.png");

async function build() {
  const target = await sharp(targetPath)
    .resize(1600, 900, { fit: "cover" })
    .png()
    .toBuffer();
  const current = await sharp(currentPath)
    .resize(1600, 900, { fit: "cover" })
    .png()
    .toBuffer();
  const labels = Buffer.from(`
    <svg width="3200" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect x="18" y="18" width="340" height="48" rx="3"
            fill="#03121d" fill-opacity=".88" stroke="#58e8e3"/>
      <text x="38" y="50" fill="#eaffff" font-family="Arial"
            font-size="24" font-weight="700">TARGET CONCEPT</text>
      <rect x="2842" y="18" width="340" height="48" rx="3"
            fill="#03121d" fill-opacity=".88" stroke="#58e8e3"/>
      <text x="2862" y="50" fill="#eaffff" font-family="Arial"
            font-size="24" font-weight="700">CINEMATIC V4</text>
      <line x1="1600" y1="0" x2="1600" y2="900"
            stroke="#65ffff" stroke-width="3"/>
    </svg>
  `);

  await sharp({
    create: {
      width: 3200,
      height: 900,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
    .composite([
      { input: target, left: 0, top: 0 },
      { input: current, left: 1600, top: 0 },
      { input: labels, left: 0, top: 0 }
    ])
    .png()
    .toFile(comparisonPath);

  console.log(comparisonPath);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
