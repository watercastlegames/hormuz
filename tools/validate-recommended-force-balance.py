"""HORMUZ 임무별 추천 전력이 과잉 없이 목표를 달성하는지 검증한다.

로컬 서버가 127.0.0.1:8080에서 저장소 루트를 제공하는 상태에서 실행한다.
구출·연안 포대·곡괭이산처럼 고유 판정이 있는 임무는 각 전용 검증기가 맡고,
이 도구는 일반 교전 명령을 공유하는 네 임무의 추천 편성을 빠르게 교전시킨다.
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
EXPECTED_SELECTIONS = {
    "convoy_shield": {
        "destroyer": 1, "fighter": 2, "helicopter": 1,
        "carrier": 0, "usv": 0, "bomber": 0, "marine": 0,
    },
    "mine_corridor": {
        "destroyer": 0, "fighter": 0, "helicopter": 1,
        "carrier": 0, "usv": 2, "bomber": 0, "marine": 0,
    },
    "missile_screen": {
        "destroyer": 1, "fighter": 2, "helicopter": 0,
        "carrier": 0, "usv": 0, "bomber": 0, "marine": 0,
    },
    "large_fleet_battle": {
        "destroyer": 2, "fighter": 3, "helicopter": 2,
        "carrier": 1, "usv": 1, "bomber": 0, "marine": 2,
    },
}

SIMULATION_JS = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  battle.config.battle.enemyEngageDelaySeconds = 0;
  battle.startBattle();
  battle.paused = true;
  battle.debugAssault();
  const delta = 0.05;
  for (let step = 0; step < 12000 && !battle.ended; step += 1) {
    const enemies = battle.units.filter(
      (unit) => unit.alive && unit.team === 'enemy'
    );
    const allies = battle.units.filter(
      (unit) => unit.alive && unit.team === 'ally'
    );
    allies.forEach((unit, index) => {
      if (unit.definition.damage <= 0) return;
      if (
        unit.order?.type === 'attack'
        && unit.order.targetUnit?.alive
      ) return;
      const compatible = enemies.filter((target) => {
        if (unit.definition.domain === 'land') {
          return target.definition.domain === 'land';
        }
        if (unit.definition.domain === 'sea') {
          return target.definition.domain !== 'land';
        }
        return true;
      });
      const target = compatible[index % Math.max(1, compatible.length)];
      if (target) unit.order = {type: 'attack', targetUnit: target};
    });
    battle.elapsed += delta;
    battle.remaining = Math.max(
      0,
      battle.config.battle.durationSeconds - battle.elapsed
    );
    battle.updateUnits(delta, battle.elapsed);
    battle.updateProjectiles(delta);
    battle.checkOutcome();
  }
  const activeTankers = battle.units.filter(
    (unit) => unit.alive && unit.team === 'civilian' && !unit.escaped
  ).length;
  return {
    scenario: battle.scenarioId,
    selection: {...battle.fleetSelection},
    budgetUsed: battle.getFleetBudgetUsed(),
    budgetAuthorized: battle.config.fleetSelection.budget,
    elapsed: Number(battle.elapsed.toFixed(1)),
    ended: battle.ended,
    success: battle.battleSuccess,
    objectiveDestroyed: battle.getObjectiveDestroyedCount(),
    objectiveRequired: battle.config.battle.objectiveEnemyCount,
    alliesAlive: battle.units.filter(
      (unit) => unit.alive && unit.team === 'ally'
    ).length,
    enemiesAlive: battle.units.filter(
      (unit) => unit.alive && unit.team === 'enemy'
    ).length,
    tankersAlive: activeTankers,
    minimumTankersToSave: battle.config.battle.minimumTankersToSave || 0
  };
}"""


def wait_ready(page):
    page.wait_for_function(
        "() => !!(window.__HORMUZ_RTS__ && "
        "window.__HORMUZ_RTS__.getSnapshot().initialized)",
        timeout=60_000,
    )


def run(base, tag, runtime_version):
    OUT.mkdir(parents=True, exist_ok=True)
    records = {}
    failures = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        for scenario, expected in EXPECTED_SELECTIONS.items():
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            console_errors, page_errors, http_errors = [], [], []
            page.on("console", lambda message: (
                console_errors.append(message.text)
                if message.type == "error" else None
            ))
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("response", lambda response: (
                http_errors.append(f"{response.status} {response.url}")
                if response.status >= 400 else None
            ))
            url = (
                f"{base}/rts-combat.html?scenario={scenario}"
                f"&google=0&v={runtime_version}"
            )
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            wait_ready(page)
            result = page.evaluate(SIMULATION_JS)
            verdict = {
                "expectedLeanSelection": result["selection"] == expected,
                "battleEnded": result["ended"] is True,
                "missionSucceeded": result["success"] is True,
                "objectiveCompleted": (
                    result["objectiveDestroyed"] >= result["objectiveRequired"]
                ),
                "protectedEnoughTankers": (
                    result["tankersAlive"] >= result["minimumTankersToSave"]
                ),
                "keepsThirtyPercentReserve": (
                    result["budgetUsed"] <= result["budgetAuthorized"] * 0.7
                ),
                "noRuntimeErrors": (
                    not console_errors and not page_errors and not http_errors
                ),
            }
            passed = all(verdict.values())
            if not passed:
                failures.append(scenario)
            records[scenario] = {
                "url": url,
                "passed": passed,
                "verdict": verdict,
                "result": result,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
            }
            print(
                f"[{'PASS' if passed else 'FAIL'}] {scenario:20s} "
                f"예산={result['budgetUsed']}/{result['budgetAuthorized']} "
                f"시간={result['elapsed']:5.1f}초 "
                f"목표={result['objectiveDestroyed']}/{result['objectiveRequired']} "
                f"아군생존={result['alliesAlive']}"
            )
            page.close()
        browser.close()

    record = OUT / f"hormuz-rts-{tag}-recommended-force-balance-validation.json"
    record.write_text(json.dumps({
        "allPassed": not failures,
        "failed": failures,
        "runtimeVersion": runtime_version,
        "scenarios": records,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n기록: {record}")
    if failures:
        print("실패: " + ", ".join(failures))
        return 1
    print("일반 교전 4종의 최소 여유 추천 편성이 모두 목표를 달성했다.")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v119")
    parser.add_argument("--runtime-version", default="119")
    args = parser.parse_args()
    sys.exit(run(
        args.base.rstrip("/"),
        args.tag,
        args.runtime_version,
    ))


if __name__ == "__main__":
    main()
