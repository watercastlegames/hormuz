"""HORMUZ 최고 난이도 적응형 전투 구성·성능 검증.

7개 RTS 전장을 난이도 5, 반복 3회, 전투기 대응 편성 조건으로 열어
혼성 증원·체력/화력 강화·전장 변형·배치 무결성·성능 예산을 확인한다.
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
SCENARIOS = [
    "convoy_shield",
    "tanker_rescue",
    "mine_corridor",
    "missile_screen",
    "coastal_battery",
    "pickaxe_mountain",
    "large_fleet_battle",
]
EXPECTED_REINFORCEMENTS = {
    "convoy_shield": 3,
    "tanker_rescue": 2,
    "mine_corridor": 2,
    "missile_screen": 3,
    "coastal_battery": 1,
    "pickaxe_mountain": 2,
    "large_fleet_battle": 4,
}


SNAPSHOT_JS = """() => {
  const api = window.__HORMUZ_RTS__;
  const battle = api.battle;
  const snapshot = api.getSnapshot();
  const enemies = battle.units.filter((unit) => unit.team === 'enemy');
  return {
    runtime: document.getElementById('rts-game')?.dataset.runtimeVersion || '',
    adaptive: snapshot.adaptiveDifficulty,
    enemyTypes: [...new Set(enemies.map((unit) => unit.type))].sort(),
    enemyForceCount: enemies.reduce((sum, unit) => sum + (unit.forceCount || 1), 0),
    enemyPositions: enemies.map((unit) => ({
      id: unit.id,
      type: unit.type,
      x: Number(unit.group.position.x.toFixed(3)),
      z: Number(unit.group.position.z.toFixed(3))
    })),
    seaUnitsOnLand: snapshot.navigation?.seaUnitsOnLand || [],
    landUnitsOffLand: (snapshot.map?.landUnits || []).filter((unit) => !unit.onLand),
    triangles: battle.renderer.info.render.triangles,
    drawCalls: battle.renderer.info.render.calls
  };
}"""


def load_snapshot(page, base: str, scenario: str, variant: int):
    url = (
        f"{base}/rts-combat.html?scenario={scenario}&google=0&lang=ko&speed=4"
        f"&day=24&difficulty=5&variant={variant}&repeat=3&wins=3&losses=0"
        "&streak=3&esc=5&stance=HARDLINE&counter=fighter&seed=132124"
    )
    page.goto(url, wait_until="load", timeout=60_000)
    page.wait_for_function(
        "() => !!(window.__HORMUZ_RTS__ && window.__HORMUZ_RTS__.getSnapshot().initialized)",
        timeout=60_000,
    )
    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__.battle.units.length > 0",
        timeout=30_000,
    )
    page.wait_for_timeout(800)
    return page.evaluate(SNAPSHOT_JS)


def run(base: str, tag: str) -> bool:
    OUT.mkdir(parents=True, exist_ok=True)
    results = {}
    failures = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        for scenario in SCENARIOS:
            page = browser.new_page(viewport={"width": 1600, "height": 900})
            console_errors, page_errors, http_errors = [], [], []
            page.on("console", lambda message: console_errors.append(message.text)
                    if message.type == "error" else None)
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("response", lambda response: http_errors.append(
                f"{response.status} {response.url}"
            ) if response.status >= 400 else None)
            try:
                snapshot = load_snapshot(page, base, scenario, 2)
                adaptive = snapshot.get("adaptive") or {}
                verdict = {
                    "runtime126": snapshot.get("runtime") == "138",
                    "difficulty5": adaptive.get("difficulty") == 5,
                    "variant2": adaptive.get("variant") == 2,
                    "hp134": adaptive.get("hpPercent") == 134,
                    "damage125": adaptive.get("damagePercent") == 125,
                    "reinforcements": adaptive.get("reinforcements")
                    == EXPECTED_REINFORCEMENTS[scenario],
                    "mixedEnemyTypes": len(snapshot.get("enemyTypes") or []) >= 2,
                    "difficultyVisible": "5/5" in (adaptive.get("badge") or ""),
                    "reinforcementVisible": "적 증원" in (adaptive.get("threat") or ""),
                    "counterVisible": "대응 전력" in (adaptive.get("threat") or ""),
                    "noSeaUnitOnLand": not snapshot.get("seaUnitsOnLand"),
                    "allLandUnitsOnLand": not snapshot.get("landUnitsOffLand"),
                    "triangleBudget": (snapshot.get("triangles") or 0) <= TRIANGLE_BUDGET,
                    "drawCallBudget": (snapshot.get("drawCalls") or 0) <= DRAW_CALL_BUDGET,
                    "noBrowserErrors": not console_errors and not page_errors and not http_errors,
                }
            except Exception as error:
                snapshot = {"exception": str(error)}
                verdict = {"initialized": False}

            passed = all(verdict.values())
            if not passed:
                failures.append(scenario)
            results[scenario] = {
                "snapshot": snapshot,
                "verdict": verdict,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
                "passed": passed,
            }
            print(
                f"[{ 'PASS' if passed else 'FAIL' }] {scenario:20s} "
                f"증원={snapshot.get('adaptive', {}).get('reinforcements', '-')} "
                f"적종류={len(snapshot.get('enemyTypes') or [])} "
                f"삼각형={snapshot.get('triangles', 0):,} "
                f"드로콜={snapshot.get('drawCalls', 0)}"
            )
            page.close()

        # 같은 전장도 변형 번호에 따라 실제 적 배치가 달라지는지 별도로 확인한다.
        variant_page = browser.new_page(viewport={"width": 1280, "height": 720})
        variant_zero = load_snapshot(variant_page, base, "convoy_shield", 0)
        variant_page.close()
        browser.close()

    variant_two = results["convoy_shield"]["snapshot"]
    positions_zero = [(item["type"], item["x"], item["z"])
                      for item in variant_zero.get("enemyPositions", [])]
    positions_two = [(item["type"], item["x"], item["z"])
                     for item in variant_two.get("enemyPositions", [])]
    variant_layout_changes = positions_zero != positions_two
    if not variant_layout_changes:
        failures.append("variant_layout")

    record = {
        "configuration": {
            "difficulty": 5,
            "repeatCount": 3,
            "counterType": "fighter",
            "expectedHpPercent": 134,
            "expectedDamagePercent": 125,
        },
        "variantLayoutChanges": variant_layout_changes,
        "results": results,
        "failures": failures,
        "allPassed": not failures,
    }
    output = OUT / f"hormuz-{tag}-adaptive-combat-validation.json"
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"전장 변형 배치 차이: {'PASS' if variant_layout_changes else 'FAIL'}")
    print(f"결과: {'PASS' if not failures else 'FAIL'}")
    print(output)
    return not failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v132-v124")
    args = parser.parse_args()
    return 0 if run(args.base.rstrip("/"), args.tag) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
