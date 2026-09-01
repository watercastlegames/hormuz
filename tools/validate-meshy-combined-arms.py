"""Meshy 결합병과 런타임·애니메이션·전략 LOD 전용 검증.

B-2 2기, Meshy 보병 20명, 보병 소총 2개 인스턴스 묶음, 아군 보병의
총 내린 걷기·총 든 걷기·조준 사격 상태, 대규모 전투의 모든 원거리
전략 유닛이 기본 도형이 아닌 Meshy 저폴리곤 3D LOD인지 실제 브라우저에서 확인한다.
별도 고정 전장 화면에서 압축 Meshy 좌표를 훼손하지 않는 인스턴스 행렬과
유조선·이란 전력의 화면 표시 배율, 선택 전후 텍스처 지속성도 검증한다.

사용:
    python -X utf8 tools/validate-meshy-combined-arms.py --tag v87
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


def run(base: str, tag: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    console_errors, page_errors, http_errors = [], [], []
    url = (
        f"{base}/rts-combat.html"
        f"?scenario=large_fleet_battle&google=1&qa=marine-animation&v={tag}"
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
            "() => !!(window.__HORMUZ_RTS__"
            " && window.__HORMUZ_RTS__.getSnapshot().initialized)",
            timeout=60_000,
        )
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.googleBattleMapStatus === 'ready'",
            timeout=60_000,
        )
        page.wait_for_function(
            """() => {
              const shell = document.getElementById('rts-game');
              const rows = (shell.dataset.marineAnimationStatesSeen || '').split('|');
              return rows.length === 4 && rows.every((row) =>
                row.includes('low-ready-walk') && row.includes('rifle-up-walk')
              );
            }""",
            timeout=75_000,
        )
        page.wait_for_timeout(1200)
        metrics = page.evaluate(
            """() => {
              const shell = document.getElementById('rts-game');
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              const battle = window.__HORMUZ_RTS__.battle;
              return {
                provider: snapshot.map.provider,
                initialAllies: Number(shell.dataset.initialAllyUnits),
                initialEnemies: Number(shell.dataset.initialEnemyUnits),
                initialCivilians: Number(shell.dataset.initialCivilianUnits),
                alliedTypes: (shell.dataset.alliedTypes || '').split('|').filter(Boolean),
                meshyMarines: Number(shell.dataset.meshyMarineUnits),
                animatedMeshyMarines: Number(shell.dataset.meshyMarineAnimations),
                strategicMeshyMarines: Number(shell.dataset.meshyMarineLodUnits),
                marineLodBatches: Number(shell.dataset.marineLodBatches),
                marineWeaponBatches: Number(shell.dataset.marineWeaponBatches),
                meshyBombers: Number(shell.dataset.meshyBomberUnits),
                bomberUnits: snapshot.formations.bomberUnits,
                marineUnits: snapshot.formations.marineUnits,
                animationStatesSeen: shell.dataset.marineAnimationStatesSeen,
                landUnitsOffLand: Number(shell.dataset.landUnitsOffLand),
                seaUnitsOnLand: Number(shell.dataset.seaUnitsOnLand),
                landUnitsOutsideInterior: (
                  snapshot.navigation.landUnitsOutsideInterior || []
                ),
                drawCalls: battle.renderer.info.render.calls,
                triangles: battle.renderer.info.render.triangles,
                fleet: snapshot.fleet,
                formations: snapshot.formations
              };
            }"""
        )
        screenshot = (
            OUT
            / f"hormuz-rts-{tag}-meshy-combined-arms-1920x1080.jpg"
        )
        page.screenshot(path=str(screenshot), type="jpeg", quality=88)
        visibility_url = (
            f"{base}/rts-combat.html"
            f"?scenario=large_fleet_battle&google=1"
            f"&qa=strategic-visibility&v={tag}"
        )
        page.goto(visibility_url, wait_until="load", timeout=60_000)
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.strategicVisibilityQa === 'ready'",
            timeout=60_000,
        )
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.googleBattleMapStatus === 'ready'",
            timeout=60_000,
        )
        page.wait_for_timeout(1200)
        visibility_metrics = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              return {
                provider: snapshot.map.provider,
                strategicVisibility: snapshot.formations.strategicVisibility,
                fallbackStrategicUnits:
                  snapshot.formations.fallbackStrategicUnits,
                meshyStrategicUnits:
                  snapshot.formations.meshyStrategicUnits,
                render: snapshot.render
              };
            }"""
        )
        visibility_screenshot = (
            OUT
            / f"hormuz-rts-{tag}-strategic-visibility-1920x1080.jpg"
        )
        page.screenshot(
            path=str(visibility_screenshot),
            type="jpeg",
            quality=90,
        )
        selected_visibility = page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const destroyer = battle.units.find((unit) =>
                unit.alive && unit.team === 'ally' && unit.type === 'destroyer'
              );
              if (destroyer) battle.selectUnits([destroyer]);
              battle.updateInstancedLodBatches();
              return window.__HORMUZ_RTS__.getSnapshot()
                .formations.strategicVisibility;
            }"""
        )
        page.wait_for_timeout(300)
        selected_screenshot = (
            OUT
            / f"hormuz-rts-{tag}-strategic-texture-selected-1920x1080.jpg"
        )
        page.screenshot(
            path=str(selected_screenshot),
            type="jpeg",
            quality=90,
        )
        browser.close()

    state_rows = [
        row for row in metrics["animationStatesSeen"].split("|") if row
    ]
    checks = {
        "alliedWeaponTypesAtLeastSeven": len(metrics["alliedTypes"]) >= 7,
        "google3dBattleMapReady": metrics["provider"] == "google-3d",
        "largeBattleBudgetAtLeast2700": (
            metrics["fleet"]["budgetAuthorized"] >= 2700
        ),
        "sevenFleetOptionsAvailable": (
            len(metrics["fleet"]["availableTypes"]) >= 7
        ),
        "groundForceOptionSelected": (
            metrics["fleet"]["selection"].get("marine", 0) >= 4
        ),
        "expandedAirAndSeaOptionsSelected": all(
            metrics["fleet"]["selection"].get(unit_type, 0) > 0
            for unit_type in ("carrier", "usv", "bomber")
        ),
        "largeBattleAllies18": metrics["initialAllies"] == 18,
        "largeBattleEnemies33": metrics["initialEnemies"] == 33,
        "largeBattleCivilians3": metrics["initialCivilians"] == 3,
        "allTenMarinesUseMeshy": metrics["meshyMarines"] == 10,
        "fourAlliedMarinesFullyAnimated": (
            metrics["animatedMeshyMarines"] == 4
        ),
        "sixEnemyMarinesUseStrategicMeshyLod": (
            metrics["strategicMeshyMarines"] == 6
        ),
        "enemyMarineSpatialLodTwoBatches": (
            metrics["marineLodBatches"] == 2
        ),
        "twoRifleInstanceBatches": metrics["marineWeaponBatches"] == 2,
        "oneMeshyBomber": metrics["meshyBombers"] == 1,
        "bomberModelFacesFlightDirection": (
            len(metrics["bomberUnits"]) == 1
            and metrics["bomberUnits"][0]["meshy"]
            and metrics["bomberUnits"][0]["name"]
            == "B-2A 스피릿 스텔스 폭격기"
            and metrics["bomberUnits"][0]["visualHeadingDot"] >= 0.995
        ),
        "alliedRiflesLockedToShouldersHandsAndTargets": (
            len(metrics["marineUnits"]) == 4
            and all(
                row["weaponBone"] == "RightHand"
                and row["supportHandBone"] == "LeftHand"
                and row["weaponForwardAlignment"] is not None
                and row["weaponForwardAlignment"] >= 0.985
                and row["gripError"] is not None
                and row["gripError"] <= 0.025
                and row["supportHandError"] is not None
                and row["supportHandError"] <= 0.045
                and row["stockShoulderError"] is not None
                and row["stockShoulderError"] <= 0.12
                and row["weaponDownAlignment"] is not None
                and row["weaponDownAlignment"] >= 0.97
                for row in metrics["marineUnits"]
            )
        ),
        "allStrategicUnitsUseMeshyLod": (
            not metrics["formations"]["fallbackStrategicUnits"]
            and metrics["formations"]["meshyStrategicUnits"] == 41
        ),
        "eightStrategicMeshyTypes": set(
            metrics["formations"]["strategicMeshyTypes"]
        ) == {
            "destroyer", "fighter", "carrier", "usv", "bomber",
            "tanker", "fastBoat", "tel",
        },
        "compressedMeshyGeometryUsesSourceMatrix": (
            len(visibility_metrics["strategicVisibility"]) == 8
            and all(
                row["sourceMatrixApplied"]
                for row in visibility_metrics["strategicVisibility"]
            )
        ),
        "strategicDisplayScaleReadableAndNonOverlapping": (
            len(visibility_metrics["strategicVisibility"]) == 8
            and all(
                1.0 <= row["displayScale"] <= 1.2
                for row in visibility_metrics["strategicVisibility"]
            )
        ),
        "googleStrategicModelsUseStableSurfaceMaterial": (
            len(visibility_metrics["strategicVisibility"]) == 8
            and all(
                row["hasBaseColorMap"]
                and row["materialBaseColor"] == "ffffff"
                and row["emissiveStrength"] == 0
                and not row["materialTransparent"]
                for row in visibility_metrics["strategicVisibility"]
            )
        ),
        "fiveRemeshedTypesUseMeshyBaseAndNormalTexture": (
            {
                row["type"]
                for row in visibility_metrics["strategicVisibility"]
                if row["usesMeshyTexture"]
            } >= {"destroyer", "fighter", "usv", "bomber", "tanker"}
            and all(
                row["usesMeshyTexture"]
                and not row["hasProceduralDetailMap"]
                and not row["hasTexturedDetailModel"]
                and row["visibleInstanceCount"] == row["count"]
                for row in visibility_metrics["strategicVisibility"]
                if row["type"]
                in {"destroyer", "fighter", "usv", "bomber", "tanker"}
            )
        ),
        "carrierKeepsUvSafeTexturedDetail": (
            {
                row["type"]
                for row in visibility_metrics["strategicVisibility"]
                if row["hasTexturedDetailModel"]
            } == {"carrier"}
            and all(
                row["texturedDetailUnit"]
                for row in visibility_metrics["strategicVisibility"]
                if row["type"] == "carrier"
            )
        ),
        "selectionDoesNotSwapOrHideRemeshedTexture": (
            len(selected_visibility) == 8
            and all(
                row["usesMeshyTexture"]
                and not row["hasTexturedDetailModel"]
                and row["visibleInstanceCount"] == row["count"]
                for row in selected_visibility
                if row["type"]
                in {"destroyer", "fighter", "usv", "bomber", "tanker"}
            )
            and any(
                row["type"] == "destroyer"
                and row["selectedInstanceCount"] == 1
                for row in selected_visibility
            )
        ),
        "strategicVisibilityGoogle3dReady": (
            visibility_metrics["provider"] == "google-3d"
            and not visibility_metrics["fallbackStrategicUnits"]
            and visibility_metrics["meshyStrategicUnits"] == 41
        ),
        "allThreeHelicoptersUseMeshyModel": (
            metrics["formations"]["meshyHelicopterUnits"] == 3
        ),
        "noAlliedMarineStartsInTpose": all(
            row.get("restPoseSource") in {
                "combat-freeze", "walk-freeze",
            }
            for row in metrics["formations"]["marineUnits"]
        ),
        "alliedMarinesSawLowReadyAndRifleUp": (
            len(state_rows) == 4
            and all(
                "low-ready-walk" in row and "rifle-up-walk" in row
                for row in state_rows
            )
        ),
        "landPlacementValid": metrics["landUnitsOffLand"] == 0,
        "landFormationInsideCoast": not metrics["landUnitsOutsideInterior"],
        "seaPlacementValid": metrics["seaUnitsOnLand"] == 0,
        "triangleBudget": metrics["triangles"] <= TRIANGLE_BUDGET,
        "drawCallBudget": metrics["drawCalls"] <= DRAW_CALL_BUDGET,
        "noConsoleError": not console_errors and not page_errors,
        "noHttpError": not http_errors,
    }
    passed = all(checks.values())
    record = OUT / f"hormuz-rts-{tag}-meshy-combined-arms-validation.json"
    record.write_text(
        json.dumps(
            {
                "url": url,
                "passed": passed,
                "checks": checks,
                "metrics": metrics,
                "visibilityMetrics": visibility_metrics,
                "selectedVisibilityMetrics": selected_visibility,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
                "screenshot": str(screenshot),
                "visibilityScreenshot": str(visibility_screenshot),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    for name, ok in checks.items():
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(
        f"tri={metrics['triangles']:,}/{TRIANGLE_BUDGET:,} "
        f"calls={metrics['drawCalls']}/{DRAW_CALL_BUDGET}"
    )
    print(f"selectedScreenshot={selected_screenshot}")
    print(f"기록: {record}")
    print(f"화면: {screenshot}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Meshy 결합병과 런타임·애니메이션 검증"
    )
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
