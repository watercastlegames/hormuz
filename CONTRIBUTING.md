# Contributing / 기여하기

Thanks for helping improve HORMUZ. Keep changes small, testable, and bilingual.

## Project rules

- Keep the runtime framework-free: Vanilla JavaScript (ES2020) and bundled three.js.
- Do not add `package.json` or a permanent `node_modules` directory.
- Add visible text to both `assets/data/strings.ko.json` and `strings.en.json`.
- Never commit API keys, tokens, server credentials, private endpoints, or generated secrets.
- Do not add high-poly Meshy source files to runtime paths.
- Preserve the fictional-simulation disclaimer and avoid real operational guidance.

## Build

```text
npx --yes esbuild assets/js/main.js --bundle --format=iife --target=es2020 --outfile=assets/js/game.bundle.js
npx --yes esbuild assets/js/rts-combat.js --bundle --format=iife --target=es2020 --outfile=assets/js/rts-combat.bundle.js
```

## Verification

Serve the repository over HTTP, then run the relevant scripts in `tools/`.

```text
python -m http.server 8080
python -X utf8 tools/validate-rts-scenarios.py --tag local
python -X utf8 tools/validate-mission-routing.py --tag local
python -X utf8 tools/validate-i18n.py --tag local
python -X utf8 tools/validate-campaign-fullrun.py
```

For click tests, send a real pointer click and confirm the topmost element at the target
coordinate. Synthetic `element.click()` does not prove that an on-screen control is usable.
