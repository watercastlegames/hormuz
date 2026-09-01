"""HORMUZ RTS 실제 마우스 명령·카메라 드래그·휠 회귀 검증.

Google 3D 대규모 전장에서 실제 오른쪽 클릭 이동, 적 우클릭 공격,
유조선 자동 항해, 마우스 휠 드래그 카메라 이동과 Google 지도 중심
동기화, 휠 확대와 두 카메라 시야각 일치를 확인하고 JSON 및
1920×1080 화면을 남긴다.

사용:
    python -X utf8 tools/validate-rts-interaction.py --tag v102
"""

import argparse
import json
import math
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def distance_2d(left, right):
    return math.hypot(right[0] - left[0], right[1] - left[1])


def unit_state(page, unit_id):
    return page.evaluate(
        """(unitId) => {
          const battle = window.__HORMUZ_RTS__.battle;
          const unit = battle.units.find((candidate) => candidate.id === unitId);
          return unit ? {
            id: unit.id,
            position: [
              Number(unit.position.x.toFixed(3)),
              Number(unit.position.z.toFixed(3))
            ],
            speed: Number(unit.currentSpeed.toFixed(3)),
            order: unit.order?.type || "none",
            target: unit.order?.targetUnit?.id || (
              unit.order?.targetPos
                ? [
                    Number(unit.order.targetPos.x.toFixed(3)),
                    Number(unit.order.targetPos.z.toFixed(3))
                  ]
                : null
            )
          } : null;
        }""",
        unit_id,
    )


def run(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    console_errors, page_errors, http_errors = [], [], []
    url = (
        f"{base}/rts-combat.html"
        f"?scenario=large_fleet_battle&google=1"
        f"&qa=strategic-visibility&v={tag}"
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        page = browser.new_page(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=1,
        )
        page.on(
            "console",
            lambda message: (
                console_errors.append(message.text)
                if message.type == "error"
                else None
            ),
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: (
                http_errors.append(f"{response.status} {response.url}")
                if response.status >= 400
                else None
            ),
        )
        page.goto(url, wait_until="load", timeout=60_000)
        page.wait_for_function(
            "() => window.__HORMUZ_RTS__?.getSnapshot().initialized === true",
            timeout=60_000,
        )
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.googleBattleMapStatus === 'ready'",
            timeout=60_000,
        )
        page.wait_for_timeout(1200)

        initial = page.evaluate("() => window.__HORMUZ_RTS__.getSnapshot()")
        destroyer_id = initial["selected"][0]
        tanker_id = page.evaluate(
            """() => window.__HORMUZ_RTS__.battle.units.find(
              (unit) => unit.team === 'civilian' && unit.type === 'tanker'
            ).id"""
        )
        destroyer_before = unit_state(page, destroyer_id)
        tanker_before = unit_state(page, tanker_id)

        page.locator("#rts-canvas").click(
            position={"x": 1120, "y": 650},
            button="right",
        )
        page.wait_for_timeout(6_000)
        destroyer_after = unit_state(page, destroyer_id)
        tanker_after = unit_state(page, tanker_id)
        after_move = page.evaluate("() => window.__HORMUZ_RTS__.getSnapshot()")

        fighter_id = page.evaluate(
            """() => window.__HORMUZ_RTS__.battle.units.find(
              (unit) => unit.team === 'ally' && unit.type === 'fighter'
            ).id"""
        )
        page.evaluate(
            """(unitId) => {
              const battle = window.__HORMUZ_RTS__.battle;
              battle.selectUnits([
                battle.units.find((unit) => unit.id === unitId)
              ]);
            }""",
            fighter_id,
        )
        fighter_before = unit_state(page, fighter_id)
        enemy_screen = page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const enemy = battle.units.find(
                (unit) => unit.team === 'enemy' && unit.alive
              );
              const projected = enemy.position.clone();
              projected.y += enemy.definition.desiredSize * 0.32;
              projected.project(battle.camera);
              const rect = battle.canvas.getBoundingClientRect();
              return {
                id: enemy.id,
                x: Math.round((projected.x * 0.5 + 0.5) * rect.width),
                y: Math.round((-projected.y * 0.5 + 0.5) * rect.height)
              };
            }"""
        )
        page.locator("#rts-canvas").click(
            position={"x": enemy_screen["x"], "y": enemy_screen["y"]},
            button="right",
        )
        page.wait_for_timeout(4_000)
        fighter_after = unit_state(page, fighter_id)

        helicopter_id = page.evaluate(
            """() => window.__HORMUZ_RTS__.battle.units.find(
              (unit) => unit.team === 'ally' && unit.type === 'helicopter'
            ).id"""
        )
        page.evaluate(
            """(unitId) => {
              const battle = window.__HORMUZ_RTS__.battle;
              battle.selectUnits([
                battle.units.find((unit) => unit.id === unitId)
              ]);
            }""",
            helicopter_id,
        )
        helicopter_before = unit_state(page, helicopter_id)
        page.locator("#rts-canvas").click(
            position={"x": 930, "y": 520},
            button="right",
        )
        page.wait_for_timeout(3_500)
        helicopter_after = unit_state(page, helicopter_id)

        camera_before = page.evaluate(
            "() => window.__HORMUZ_RTS__.getSnapshot().camera"
        )
        google_before = page.locator("#rts-game").get_attribute(
            "data-google-battle-center"
        )
        page.mouse.move(1280, 720)
        page.mouse.down(button="middle")
        page.mouse.move(1040, 570, steps=12)
        page.mouse.up(button="middle")
        page.wait_for_timeout(1_200)
        camera_after = page.evaluate(
            "() => window.__HORMUZ_RTS__.getSnapshot().camera"
        )
        google_after = page.locator("#rts-game").get_attribute(
            "data-google-battle-center"
        )
        google_fov_after_pan = float(
            page.locator("#rts-game").get_attribute("data-google-battle-fov")
            or 0
        )
        google_range_before_wheel = float(
            page.locator("#rts-game").get_attribute("data-google-battle-range")
            or 0
        )
        camera_before_wheel = camera_after
        page.mouse.move(1160, 640)
        page.mouse.wheel(0, 420)
        page.wait_for_timeout(600)
        camera_after_wheel = page.evaluate(
            "() => window.__HORMUZ_RTS__.getSnapshot().camera"
        )
        google_range_after_wheel = float(
            page.locator("#rts-game").get_attribute("data-google-battle-range")
            or 0
        )
        google_fov_after_wheel = float(
            page.locator("#rts-game").get_attribute("data-google-battle-fov")
            or 0
        )

        shell = page.locator("#rts-game")
        interaction = {
            "url": url,
            "initialPaused": initial["paused"],
            "staticQaResumed": shell.get_attribute("data-static-qa-resumed"),
            "destroyer": {
                "before": destroyer_before,
                "after": destroyer_after,
                "distance": round(
                    distance_2d(
                        destroyer_before["position"],
                        destroyer_after["position"],
                    ),
                    3,
                ),
            },
            "tanker": {
                "before": tanker_before,
                "after": tanker_after,
                "distance": round(
                    distance_2d(
                        tanker_before["position"],
                        tanker_after["position"],
                    ),
                    3,
                ),
            },
            "fighter": {
                "before": fighter_before,
                "after": fighter_after,
                "distance": round(
                    distance_2d(
                        fighter_before["position"],
                        fighter_after["position"],
                    ),
                    3,
                ),
                "enemy": enemy_screen["id"],
            },
            "helicopter": {
                "before": helicopter_before,
                "after": helicopter_after,
                "distance": round(
                    distance_2d(
                        helicopter_before["position"],
                        helicopter_after["position"],
                    ),
                    3,
                ),
            },
            "camera": {
                "before": camera_before,
                "after": camera_after,
                "distance": round(
                    distance_2d(
                        camera_before["focus"],
                        camera_after["focus"],
                    ),
                    3,
                ),
                "googleBefore": google_before,
                "googleAfter": google_after,
                "googleFovAfterPan": google_fov_after_pan,
                "input": shell.get_attribute("data-camera-pan-input"),
            },
            "wheel": {
                "cameraBefore": camera_before_wheel,
                "cameraAfter": camera_after_wheel,
                "googleRangeBefore": google_range_before_wheel,
                "googleRangeAfter": google_range_after_wheel,
                "googleFovAfter": google_fov_after_wheel,
            },
            "selectionSummary": page.locator(
                "#selection-summary"
            ).inner_text(),
            "render": after_move["render"],
            "navigation": after_move["navigation"],
            "errors": {
                "console": console_errors,
                "page": page_errors,
                "http": http_errors,
            },
        }
        interaction["checks"] = {
            "qaCommandResumesBattle": (
                interaction["initialPaused"]
                and interaction["staticQaResumed"] == "true"
            ),
            "destroyerMoveOrderAccepted": (
                destroyer_after["order"] in {"move", "attackMove"}
            ),
            "destroyerVisiblyMoved": (
                interaction["destroyer"]["distance"] >= 0.35
            ),
            "tankerAutoRouteMoved": interaction["tanker"]["distance"] >= 0.05,
            "fighterAttackOrderAccepted": (
                fighter_after["order"] == "attack"
                and fighter_after["target"] == enemy_screen["id"]
            ),
            "fighterMovedIndependently": (
                interaction["fighter"]["distance"] >= 0.25
            ),
            "helicopterMoveOrderAccepted": (
                helicopter_after["order"] in {"move", "attackMove"}
            ),
            "helicopterMovedIndependently": (
                interaction["helicopter"]["distance"] >= 0.2
            ),
            "middleMouseCameraPan": (
                interaction["camera"]["distance"] >= 1
                and interaction["camera"]["input"] == "middle-drag"
            ),
            "googleCenterSynced": (
                bool(google_before)
                and bool(google_after)
                and google_before != google_after
            ),
            "googleAndThreeFovMatched": (
                abs(
                    interaction["camera"]["after"]["fov"]
                    - interaction["camera"]["googleFovAfterPan"]
                ) <= 0.01
                and abs(
                    interaction["wheel"]["cameraAfter"]["fov"]
                    - interaction["wheel"]["googleFovAfter"]
                ) <= 0.01
            ),
            "wheelZoomSynced": (
                interaction["wheel"]["cameraAfter"]["height"]
                > interaction["wheel"]["cameraBefore"]["height"]
                and interaction["wheel"]["cameraAfter"]["distance"]
                > interaction["wheel"]["cameraBefore"]["distance"]
                and interaction["wheel"]["googleRangeAfter"]
                > interaction["wheel"]["googleRangeBefore"]
            ),
            "noSeaUnitsOnLand": not after_move["navigation"]["seaUnitsOnLand"],
            "noConsoleErrors": not console_errors,
            "noPageErrors": not page_errors,
            "noHttpErrors": not http_errors,
        }
        screenshot = OUT / f"hormuz-rts-{tag}-interaction-1920x1080.jpg"
        page.screenshot(path=str(screenshot), type="jpeg", quality=90)
        browser.close()

    report = OUT / f"hormuz-rts-{tag}-interaction-validation.json"
    report.write_text(
        json.dumps(interaction, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    failed = [
        name for name, passed in interaction["checks"].items() if not passed
    ]
    print(json.dumps(interaction, ensure_ascii=False, indent=2))
    if failed:
        print("FAILED:", ", ".join(failed), file=sys.stderr)
        return 1
    print(f"PASS: {report}")
    print(f"SCREENSHOT: {screenshot}")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="current")
    args = parser.parse_args()
    raise SystemExit(run(args.base.rstrip("/"), args.tag))


if __name__ == "__main__":
    main()
