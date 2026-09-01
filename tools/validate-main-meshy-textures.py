"""본편 상황실의 Meshy 텍스처·Google 3D 전술 결합 배경을 검증한다.

사용:
    python -X utf8 tools/validate-main-meshy-textures.py --tag v34
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
TRIANGLE_BUDGET = 120_000
DRAW_CALL_BUDGET = 90
TARGET_MODELS = {
    "destroyer": "assets/models/meshy-remesh-v6/arleigh-burke-destroyer-remesh-3k-web-v106.glb",
    "tanker": "assets/models/meshy-remesh-v6/vlcc-tanker-remesh-3p5k-web-v106.glb",
    "fighter": "assets/models/meshy-remesh-v6/fa-18e-super-hornet-remesh-2k-web-v106.glb",
    "usv": "assets/models/meshy-remesh-v6/mcm-usv-remesh-3k-web-v106.glb",
}
def run(base: str, tag: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    console_errors, page_errors, http_errors = [], [], []
    model_responses = {}
    local_url = (
        f"{base}/index.html"
        f"?autostart=1&startMode=new&debug=fast&scenecheck=1&google=0&perf=1&v={tag}"
    )
    google_url = (
        f"{base}/index.html"
        f"?autostart=1&startMode=new&debug=fast&scenecheck=1&google=1&v={tag}"
    )

    def attach_events(page):
        page.on(
            "console",
            lambda message: (
                console_errors.append(message.text)
                if message.type == "error"
                else None
            ),
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def collect_response(response):
            if response.status >= 400:
                http_errors.append(f"{response.status} {response.url}")
            for key, path in TARGET_MODELS.items():
                if path in response.url:
                    model_responses[key] = response.status

        page.on("response", collect_response)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        local = browser.new_page(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
        )
        attach_events(local)
        local.goto(local_url, wait_until="domcontentloaded", timeout=60_000)
        local.wait_for_function(
            "() => !!(window.__HORMUZ__?.world && window.__HORMUZ__.world.renderer)",
            timeout=60_000,
        )
        local.wait_for_function(
            "() => ['destroyer','tanker','fighter','usv']"
            ".every((key) => !!window.__HORMUZ__.world.models[key])",
            timeout=60_000,
        )
        local.wait_for_timeout(1200)
        local_metrics = local.evaluate(
            """() => {
              const world = window.__HORMUZ__.world;
              const modelStats = {};
              for (const key of ['destroyer', 'tanker', 'fighter', 'usv']) {
                const rows = [];
                world.models[key].traverse((child) => {
                  if (!child.isMesh || !child.material) return;
                  const materials = Array.isArray(child.material)
                    ? child.material : [child.material];
                  for (const material of materials) {
                    rows.push({
                      hasBaseColorMap: Boolean(material.map),
                      hasNormalMap: Boolean(material.normalMap),
                      color: material.color?.getHexString?.() || null,
                      emissiveIntensity: Number(
                        (material.emissiveIntensity || 0).toFixed(3)
                      )
                    });
                  }
                });
                modelStats[key] = rows;
              }
              return {
                modelKeys: Object.keys(world.models).sort(),
                modelStats,
                triangles: world.renderer.info.render.triangles,
                drawCalls: world.renderer.info.render.calls,
                dynamicTankers: world.dynamic.filter(
                  (unit) => unit.key === 'tanker'
                ).length,
                visibleTankers: world.dynamic.filter(
                  (unit) => unit.key === 'tanker' && unit.object.visible
                ).length,
                transitValue: Number(world.canvas.dataset.transitValue),
                transitShipScale: Number(
                  world.canvas.dataset.transitShipScale
                ),
                transitRouteClearanceKm: Number(
                  world.canvas.dataset.transitRouteClearanceKm
                ),
                trafficCounts: (() => {
                  const counts = {};
                  for (const value of [0, 30, 50, 75, 100]) {
                    world.setTransitTraffic(value);
                    counts[value] = world.dynamic.filter(
                      (unit) => unit.key === 'tanker' && unit.object.visible
                    ).length;
                  }
                  world.setTransitTraffic(30);
                  return counts;
                })(),
                tssStyles: (() => {
                  const rows = [];
                  world.tssGroup.traverse((object) => {
                    const materials = Array.isArray(object.material)
                      ? object.material : [object.material];
                    for (const material of materials) {
                      if (!material) continue;
                      rows.push({
                        type: material.type,
                        opacity: Number(material.opacity.toFixed(2)),
                        transparent: material.transparent,
                        depthWrite: material.depthWrite,
                        renderOrder: object.renderOrder
                      });
                    }
                  });
                  return rows;
                })()
              };
            }"""
        )
        local.evaluate(
            """() => {
              document.querySelector('#title-screen')?.classList.add('hidden');
              document.querySelector('#replay-screen')?.classList.add('hidden');
              document.querySelector('#loading-screen')?.classList.add('hidden');
              const world = window.__HORMUZ__.world;
              const layout = {
                destroyer: [-13, 0.45, -1],
                tanker: [-3, 0.45, 1],
                usv: [8, 0.45, 0],
                fighter: [13, 6.2, -2]
              };
              for (const [key, position] of Object.entries(layout)) {
                const clone = world.models[key].clone(true);
                clone.position.set(...position);
                clone.name = `main-meshy-v34-showcase-${key}`;
                world.unitGroup.add(clone);
              }
              world.autoCamera = false;
              world.target.set(0, 1.2, 0);
              world.camera.position.set(0, 28, 40);
              world.cameraGoal.copy(world.camera.position);
            }"""
        )
        local.wait_for_timeout(900)
        local_screenshot = (
            OUT / f"hormuz-main-{tag}-meshy-texture-showcase-1920x1080.jpg"
        )
        local.screenshot(path=str(local_screenshot), type="jpeg", quality=90)
        # SwiftShader에서 로컬 Three.js 장면을 계속 렌더링하면 두 번째 탭의
        # Google 3D 준비 이벤트가 지연된다. 화면·수치를 확보한 뒤 닫는다.
        local.close()

        google = browser.new_page(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
        )
        attach_events(google)
        google.goto(google_url, wait_until="domcontentloaded", timeout=60_000)
        google.wait_for_function(
            "() => document.querySelector('#game')"
            "?.dataset.googleMapStatus === 'loading'"
            " && document.querySelector('#game')"
            "?.classList.contains('boot-loading')",
            timeout=60_000,
        )
        google_loading_metrics = google.evaluate(
            """() => {
              const root = document.querySelector('#game');
              const canvas = document.querySelector('#world-canvas');
              const loading = document.querySelector('#loading-screen');
              const progress = document.querySelector('.loading-progress');
              const canvasStyle = getComputedStyle(canvas);
              const loadingStyle = getComputedStyle(loading);
              const progressStyle = getComputedStyle(progress);
              return {
                pending: root.classList.contains('google-map-pending'),
                bootLoading: root.classList.contains('boot-loading'),
                provider: root.dataset.mapProvider,
                canvasOpacity: Number(canvasStyle.opacity),
                canvasVisibility: canvasStyle.visibility,
                loadingVisible: loadingStyle.display !== 'none'
                  && loadingStyle.visibility !== 'hidden',
                loadingOpacity: Number(loadingStyle.opacity),
                loadingBackground: loadingStyle.backgroundColor,
                loadingZIndex: Number(loadingStyle.zIndex),
                progressVisible: progressStyle.display !== 'none'
                  && progressStyle.visibility !== 'hidden'
              };
            }"""
        )
        google_loading_screenshot = (
            OUT / f"hormuz-main-{tag}-google-loading-gate-1920x1080.jpg"
        )
        google.screenshot(
            path=str(google_loading_screenshot),
            type="jpeg",
            quality=90,
        )
        google.wait_for_function(
            "() => document.querySelector('#game')"
            "?.dataset.googleMapStatus === 'ready'",
            timeout=90_000,
        )
        google.wait_for_function(
            "() => document.querySelector('#game')"
            "?.dataset.mapProvider === 'google-3d'",
            timeout=90_000,
        )
        google.evaluate(
            """() => {
              document.querySelector('#title-screen')?.classList.add('hidden');
              document.querySelector('#replay-screen')?.classList.add('hidden');
              document.querySelector('#loading-screen')?.classList.add('hidden');
              window.__HORMUZ__.director.fast = false;
              window.__HORMUZ__.director.ui.auto = false;
              void window.__HORMUZ__.director.start();
            }"""
        )
        google.wait_for_timeout(1200)
        confirm_briefing = google.locator("#confirm-briefing")
        if confirm_briefing.count():
            confirm_briefing.click(force=True)
            try:
                google.wait_for_selector("#decision-panel.open", timeout=12_000)
            except Exception:
                # 지도·전술 오버레이 검증은 결정 패널의 캠페인 진행 단계와
                # 독립적이다. 자동진행 경합으로 패널이 먼저 닫혀도 계속 측정한다.
                pass
        # `ready`는 API 초기화 완료 신호다. 위성 타일과 Three.js 전술
        # 자산이 실제 프레임에 합성될 시간을 추가로 준다.
        google.wait_for_timeout(8000)
        google_metrics = google.evaluate(
            """() => ({
              provider: document.querySelector('#game')?.dataset.mapProvider,
              mapStatus: document.querySelector('#game')?.dataset.googleMapStatus,
              tacticalOverlay: document.querySelector('#game')
                ?.dataset.googleTacticalOverlay,
              shipStatus: document.querySelector('#game')?.dataset.googleShipStatus,
              runtimeVersion: document.querySelector('#game')?.dataset.runtimeVersion,
              mapCenter: document.querySelector('#game')?.dataset.googleMapCenter,
              mapRange: Number(
                document.querySelector('#game')?.dataset.googleMapRange
              ) || 0,
              mapHeading: Number(
                document.querySelector('#game')?.dataset.googleMapHeading
              ) || 0,
              syncMode: document.querySelector('#game')
                ?.dataset.googleMapSyncMode,
              syncThrottleMs: Number(
                document.querySelector('#game')?.dataset.googleMapSyncThrottleMs
              ) || 0,
              syncCount: Number(
                document.querySelector('#game')?.dataset.googleMapSyncCount
              ) || 0,
              syncAverageMs: Number(
                document.querySelector('#game')?.dataset.googleMapSyncAverageMs
              ) || 0,
              canvasOverlay: document.querySelector('#world-canvas')
                ?.dataset.googleTacticalOverlay,
              contextAlpha: window.__HORMUZ__.world.renderer.getContext()
                .getContextAttributes()?.alpha,
              localTerrainTotal: window.__HORMUZ__.world.localTerrainObjects.length,
              localTerrainVisible: window.__HORMUZ__.world.localTerrainObjects
                .filter((object) => object.visible).length,
              unitGroupVisible: window.__HORMUZ__.world.unitGroup.visible,
              tssGroupVisible: window.__HORMUZ__.world.tssGroup.visible,
              dynamicTankers: window.__HORMUZ__.world.dynamic.filter(
                (unit) => unit.key === 'tanker'
              ).length,
              visibleTankers: window.__HORMUZ__.world.dynamic.filter(
                (unit) => unit.key === 'tanker' && unit.object.visible
              ).length,
              transitValue: Number(
                document.querySelector('#world-canvas')?.dataset.transitValue
              ),
              transitShipScale: Number(
                document.querySelector('#world-canvas')
                  ?.dataset.transitShipScale
              ),
              transitRouteClearanceKm: Number(
                document.querySelector('#world-canvas')
                  ?.dataset.transitRouteClearanceKm
              ),
              pending: document.querySelector('#game')
                ?.classList.contains('google-map-pending'),
              carrierDeployment: (() => {
                const world = window.__HORMUZ__.world;
                const carrier = world.unitGroup.children.find(
                  (child) => child.userData.modelKey === 'carrier'
                );
                if (!carrier) return null;
                const pointInRing = (point, ring) => {
                  let inside = false;
                  for (
                    let index = 0, previous = ring.length - 1;
                    index < ring.length;
                    previous = index++
                  ) {
                    const [xi, yi] = ring[index];
                    const [xj, yj] = ring[previous];
                    const intersects = ((yi > point[1]) !== (yj > point[1]))
                      && point[0] < (
                        ((xj - xi) * (point[1] - yi))
                        / ((yj - yi) || 0.0000001) + xi
                      );
                    if (intersects) inside = !inside;
                  }
                  return inside;
                };
                const isLand = (point) => world.coastline.polygons.some(
                  (polygon) => pointInRing(point, polygon.outer)
                    && !(polygon.holes || []).some(
                      (hole) => pointInRing(point, hole)
                    )
                );
                carrier.updateMatrixWorld(true);
                const footprint = [];
                let landSamples = 0;
                carrier.traverse((child) => {
                  const position = child.geometry?.attributes?.position;
                  if (!child.isMesh || !position) return;
                  const elements = child.matrixWorld.elements;
                  const step = Math.max(1, Math.ceil(position.count / 800));
                  for (let index = 0; index < position.count; index += step) {
                    const x = position.getX(index);
                    const y = position.getY(index);
                    const z = position.getZ(index);
                    const projected = {
                      x: elements[0] * x + elements[4] * y
                        + elements[8] * z + elements[12],
                      z: elements[2] * x + elements[6] * y
                        + elements[10] * z + elements[14]
                    };
                    const geoPoint = world.unproject(projected);
                    footprint.push([geoPoint.lng, geoPoint.lat]);
                    if (isLand([geoPoint.lng, geoPoint.lat])) landSamples += 1;
                  }
                });
                return {
                  anchor: carrier.userData.geoAnchor,
                  rotationY: Number(carrier.rotation.y.toFixed(3)),
                  footprintSamples: footprint.length,
                  landSamples,
                  longitudeRange: [
                    Math.min(...footprint.map((point) => point[0])),
                    Math.max(...footprint.map((point) => point[0]))
                  ],
                  latitudeRange: [
                    Math.min(...footprint.map((point) => point[1])),
                    Math.max(...footprint.map((point) => point[1]))
                  ]
                };
              })(),
              mapModeButtonPresent: Boolean(
                document.querySelector('#google-map-mode')
              ),
              worldCamera: window.__HORMUZ__.world.camera.position.toArray()
            })"""
        )
        google_screenshot = (
            OUT / f"hormuz-main-{tag}-google-tactical-overlay-1920x1080.jpg"
        )
        google.screenshot(path=str(google_screenshot), type="jpeg", quality=90)
        google.mouse.move(880, 420)
        google.mouse.down()
        google.mouse.move(1120, 470, steps=8)
        google.mouse.up()
        google.wait_for_timeout(1400)
        google_camera_after_drag = google.evaluate(
            """() => ({
              mapCenter: document.querySelector('#game')?.dataset.googleMapCenter,
              mapHeading: Number(
                document.querySelector('#game')?.dataset.googleMapHeading
              ) || 0,
              syncCount: Number(
                document.querySelector('#game')?.dataset.googleMapSyncCount
              ) || 0,
              syncIntervalMs: Number(
                document.querySelector('#game')?.dataset.googleMapSyncIntervalMs
              ) || 0,
              syncAverageMs: Number(
                document.querySelector('#game')?.dataset.googleMapSyncAverageMs
              ) || 0,
              worldCamera: window.__HORMUZ__.world.camera.position.toArray()
            })"""
        )
        browser.close()

    checks = {
        "fourRemeshedModelsLoaded": all(
            key in local_metrics["modelKeys"] for key in TARGET_MODELS
        ),
        "fourRemeshedModelRequests200": all(
            model_responses.get(key) == 200 for key in TARGET_MODELS
        ),
        "baseColorAndNormalTexturesPreserved": all(
            rows
            and all(row["hasBaseColorMap"] and row["hasNormalMap"] for row in rows)
            for rows in local_metrics["modelStats"].values()
        ),
        "texturesNotWashedByTintOrEmissive": all(
            rows
            and all(
                row["color"] == "ffffff"
                and row["emissiveIntensity"] == 0
                for row in rows
            )
            for rows in local_metrics["modelStats"].values()
        ),
        "trafficShipsTrackCurrentTransit": (
            local_metrics["dynamicTankers"] == 6
            and local_metrics["visibleTankers"] == 2
            and local_metrics["transitValue"] == 30
            and local_metrics["trafficCounts"] == {
                "0": 0,
                "30": 2,
                "50": 3,
                "75": 5,
                "100": 6,
            }
        ),
        "trafficShipScaleHalved": (
            local_metrics["transitShipScale"] == 0.26
        ),
        "transitRouteClearsKhasabCoast": (
            local_metrics["transitRouteClearanceKm"] >= 17
            and google_metrics["transitRouteClearanceKm"] >= 17
        ),
        "navigationMarksStayBehindShips": (
            len(local_metrics["tssStyles"]) == 4
            and max(
                row["opacity"] for row in local_metrics["tssStyles"]
            ) <= 0.24
            and all(
                row["transparent"] is True
                and row["depthWrite"] is False
                and row["renderOrder"] == -10
                for row in local_metrics["tssStyles"]
            )
        ),
        "mainSceneTriangleBudget": (
            local_metrics["triangles"] <= TRIANGLE_BUDGET
        ),
        "mainSceneDrawCallBudget": (
            local_metrics["drawCalls"] <= DRAW_CALL_BUDGET
        ),
        "google3dMainMapReady": (
            google_metrics["provider"] == "google-3d"
            and google_metrics["mapStatus"] == "ready"
            and google_metrics["tacticalOverlay"] == "ready"
            and google_metrics["shipStatus"] == "three-overlay"
            and google_metrics["pending"] is False
        ),
        "cleanBlackBootLoadingGate": (
            google_loading_metrics["pending"] is True
            and google_loading_metrics["bootLoading"] is True
            and google_loading_metrics["provider"] == "google-loading"
            and google_loading_metrics["canvasOpacity"] == 0
            and google_loading_metrics["canvasVisibility"] == "hidden"
            and google_loading_metrics["loadingVisible"] is True
            and google_loading_metrics["loadingOpacity"] == 1
            and google_loading_metrics["loadingBackground"] == "rgb(0, 0, 0)"
            and google_loading_metrics["loadingZIndex"] >= 300
            and google_loading_metrics["progressVisible"] is True
        ),
        "google3dUsesTransparentThreeOverlay": (
            google_metrics["canvasOverlay"] == "true"
            and google_metrics["contextAlpha"] is True
        ),
        "localTerrainHiddenUnderGoogle": (
            google_metrics["localTerrainTotal"] >= 6
            and google_metrics["localTerrainVisible"] == 0
        ),
        "tacticalAssetsRemainVisible": (
            google_metrics["unitGroupVisible"] is True
            and google_metrics["tssGroupVisible"] is True
            and google_metrics["dynamicTankers"] == 6
            and google_metrics["visibleTankers"] == 2
            and google_metrics["transitValue"] == 30
            and google_metrics["transitShipScale"] == 0.26
        ),
        "googleCameraInitializedForRegionalView": (
            google_metrics["runtimeVersion"] == "127"
            and google_metrics["mapRange"] >= 500_000
            and bool(google_metrics["mapCenter"])
        ),
        "carrierPlacedEntirelyInSafeWater": (
            google_metrics["carrierDeployment"] is not None
            and google_metrics["carrierDeployment"]["anchor"] == {
                "lng": 53.65,
                "lat": 26.25,
            }
            and google_metrics["carrierDeployment"]["footprintSamples"] >= 100
            and google_metrics["carrierDeployment"]["landSamples"] == 0
        ),
        "googleMapModeButtonRemoved": (
            google_metrics["mapModeButtonPresent"] is False
        ),
        "googleCameraUsesFrameSync": (
            google_metrics["syncMode"] == "frame"
            and google_metrics["syncThrottleMs"] == 16
            and (
                google_camera_after_drag["syncCount"]
                - google_metrics["syncCount"]
            ) >= 8
        ),
        "dragMovesGoogleAndTacticalCameraTogether": (
            google_camera_after_drag["worldCamera"]
            != google_metrics["worldCamera"]
            and (
                google_camera_after_drag["mapHeading"]
                != google_metrics["mapHeading"]
                or google_camera_after_drag["mapCenter"]
                != google_metrics["mapCenter"]
            )
        ),
        "noConsoleOrPageErrors": not console_errors and not page_errors,
        "noHttpErrors": not http_errors,
    }
    passed = all(checks.values())
    record = OUT / f"hormuz-main-{tag}-meshy-texture-validation.json"
    record.write_text(
        json.dumps(
            {
                "passed": passed,
                "localUrl": local_url,
                "googleUrl": google_url,
                "checks": checks,
                "targetModels": TARGET_MODELS,
                "modelResponses": model_responses,
                "localMetrics": local_metrics,
                "googleLoadingMetrics": google_loading_metrics,
                "googleMetrics": google_metrics,
                "googleCameraAfterDrag": google_camera_after_drag,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
                "screenshots": {
                    "localShowcase": str(local_screenshot),
                    "googleLoadingGate": str(google_loading_screenshot),
                    "google3d": str(google_screenshot),
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    for name, ok in checks.items():
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(
        f"tri={local_metrics['triangles']:,}/{TRIANGLE_BUDGET:,} "
        f"calls={local_metrics['drawCalls']}/{DRAW_CALL_BUDGET}"
    )
    print(f"기록: {record}")
    print(f"로컬 화면: {local_screenshot}")
    print(f"Google 화면: {google_screenshot}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="본편 Meshy 텍스처·Google 3D 전술 결합 배경 검증"
    )
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
