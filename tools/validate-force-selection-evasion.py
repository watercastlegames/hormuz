"""HORMUZ 아군 적정 편성·미사일 회피·유조선 구출·유닛 관통 방지 검증.

로컬 서버가 127.0.0.1:8080에서 저장소 루트를 제공하는 상태에서 실행한다.
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
SCENARIOS = {
    "convoy_shield": {
        "destroyer": 1, "fighter": 2, "helicopter": 1,
        "carrier": 0, "usv": 0, "bomber": 0, "marine": 0,
    },
    "tanker_rescue": {
        "destroyer": 1, "fighter": 1, "helicopter": 1,
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
    "coastal_battery": {
        "destroyer": 0, "fighter": 2, "helicopter": 0,
        "carrier": 0, "usv": 0, "bomber": 1, "marine": 2,
    },
    "pickaxe_mountain": {
        "destroyer": 0, "fighter": 0, "helicopter": 0,
        "carrier": 0, "usv": 0, "bomber": 1, "marine": 0,
    },
    "large_fleet_battle": {
        "destroyer": 2, "fighter": 3, "helicopter": 2,
        "carrier": 1, "usv": 1, "bomber": 0, "marine": 2,
    },
}
PREVIOUS_RECOMMENDED_COSTS = {
    "convoy_shield": 1410,
    "tanker_rescue": 425,
    "mine_corridor": 385,
    "missile_screen": 1365,
    "coastal_battery": 770,
    "pickaxe_mountain": 320,
    "large_fleet_battle": 2460,
}
EASY_LABELS = [
    "구축함", "전투기", "헬기", "항공모함",
    "무인수상정", "스텔스 폭격기", "지상병력",
]


def wait_ready(page):
    for _ in range(80):
        try:
            if page.evaluate(
                "() => !!(window.__HORMUZ_RTS__ && "
                "window.__HORMUZ_RTS__.getSnapshot().initialized)"
            ):
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False


def run(base, tag, only_evasion=False):
    OUT.mkdir(parents=True, exist_ok=True)
    records = {}
    failures = []
    screenshot = OUT / f"hormuz-rts-{tag}-force-selection-1920x1080.jpg"
    rescue_screenshot = OUT / f"hormuz-rts-{tag}-tanker-rescue-1920x1080.jpg"
    collision_screenshot = OUT / f"hormuz-rts-{tag}-unit-collision-1920x1080.jpg"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        for scenario, expected in ([] if only_evasion else SCENARIOS.items()):
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            console_errors, page_errors, http_errors = [], [], []
            page.on("console", lambda message: (
                console_errors.append(message.text) if message.type == "error" else None
            ))
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("response", lambda response: (
                http_errors.append(f"{response.status} {response.url}")
                if response.status >= 400 else None
            ))
            url = f"{base}/rts-combat.html?scenario={scenario}&google=0&v=119"
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            ready = wait_ready(page)
            state = page.evaluate("""() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const cards = [...document.querySelectorAll('.fleet-options article')];
              return {
                selection: {...battle.fleetSelection},
                labels: cards.map((card) => card.querySelector('span')?.textContent || ''),
                hiddenCards: cards.filter((card) => card.hidden).length,
                statuses: cards.map((card) => card.querySelector('.fleet-status')?.textContent || ''),
                minimumFont: Math.min(...cards.map((card) => (
                  parseFloat(getComputedStyle(card.querySelector('span')).fontSize) || 0
                ))),
                message: document.getElementById('fleet-message')?.textContent || '',
                budgetUsed: battle.getFleetBudgetUsed(),
                budgetAuthorized: battle.config.fleetSelection.budget
              };
            }""") if ready else {}
            previous_cost = PREVIOUS_RECOMMENDED_COSTS[scenario]
            current_cost = state.get("budgetUsed", 0)
            authorized_budget = state.get("budgetAuthorized", 0)
            state["previousRecommendedCost"] = previous_cost
            state["savedFromPrevious"] = previous_cost - current_cost
            state["savedPercent"] = round(
                (previous_cost - current_cost) / previous_cost * 100, 1
            )
            state["budgetUsePercent"] = round(
                current_cost / authorized_budget * 100, 1
            ) if authorized_budget else 0
            zero_check = {}
            if ready:
                if scenario == "convoy_shield":
                    page.screenshot(path=str(screenshot), type="jpeg", quality=86)
                positive_type = next(
                    unit_type for unit_type, count in expected.items()
                    if count > 0 and unit_type != "marine"
                )
                zero_check = page.evaluate("""(unitType) => {
                  const battle = window.__HORMUZ_RTS__.battle;
                  while (battle.fleetSelection[unitType] > 0) {
                    battle.updateFleetSelection(unitType, -1);
                  }
                  const card = document.querySelector(`[data-fleet-type="${unitType}"]`);
                  return {
                    type: unitType,
                    count: battle.fleetSelection[unitType],
                    status: card.querySelector('.fleet-status')?.textContent || '',
                    plusEnabled: !card.querySelector('[data-fleet-step="1"]').disabled
                  };
                }""", positive_type)
            verdict = {
                "initialized": ready,
                "expectedDefaults": state.get("selection") == expected,
                "allSevenCardsVisible": (
                    state.get("labels") == EASY_LABELS and state.get("hiddenCards") == 0
                ),
                "minimumFont14": state.get("minimumFont", 0) >= 14,
                "zeroAllowed": (
                    zero_check.get("count") == 0
                    and zero_check.get("status") == "선택 안 함"
                    and zero_check.get("plusEnabled") is True
                ),
                "plainKoreanGuidance": (
                    "최소 여유 전력만 추천" in state.get("message", "")
                    or (
                        scenario == "pickaxe_mountain"
                        and "B-2" in state.get("message", "")
                        and "GBU-57" in state.get("message", "")
                    )
                ),
                "keepsThirtyPercentReserve": (
                    state.get("budgetUsePercent", 100) <= 70
                ),
                "notAbovePreviousCost": current_cost <= previous_cost,
                "noRuntimeErrors": not console_errors and not page_errors and not http_errors,
            }
            passed = all(verdict.values())
            if not passed:
                failures.append(f"fleet:{scenario}")
            records[scenario] = {
                "url": url,
                "passed": passed,
                "verdict": verdict,
                "state": state,
                "zeroCheck": zero_check,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
            }
            print(
                f"[{'PASS' if passed else 'FAIL'}] {scenario:20s} "
                f"기본={state.get('selection')} "
                f"예산={current_cost}/{authorized_budget} "
                f"이전대비=-{state.get('savedPercent')}% "
                f"0대={zero_check.get('count')}"
            )
            page.close()

        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        console_errors, page_errors, http_errors = [], [], []
        page.on("console", lambda message: (
            console_errors.append(message.text) if message.type == "error" else None
        ))
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: (
            http_errors.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        evade_url = f"{base}/rts-combat.html?scenario=missile_screen&google=0&v=119"
        page.goto(evade_url, wait_until="domcontentloaded", timeout=60_000)
        evade_ready = wait_ready(page)
        setup = {}
        if evade_ready:
            page.evaluate("() => window.__HORMUZ_RTS__.start()")
            page.wait_for_timeout(500)
            setup = page.evaluate("""() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const attacker = battle.units.find(
                (unit) => unit.team === 'enemy' && unit.type === 'airThreat' && unit.alive
              );
              const target = battle.units.find(
                (unit) => unit.team === 'ally' && unit.type === 'fighter' && unit.alive
              );
              const targetY = target.definition.altitude || target.position.y;
              target.position.set(0, targetY, 4);
              target.group.rotation.y = Math.PI / 2;
              target.forward.set(1, 0, 0);
              target.currentSpeed = target.definition.speed;
              target.order = {
                type: 'move',
                targetPos: target.position.clone().setX(34)
              };
              attacker.position.set(0, targetY, -38);
              attacker.group.rotation.y = 0;
              attacker.forward.set(0, 0, 1);
              attacker.currentSpeed = 0;
              attacker.order = {type: 'hold'};
              const initialHp = target.hp;
              battle.spawnProjectile(attacker, target, {
                weapon: 'missile',
                projectileSpeed: 22,
                damage: Math.max(24, target.definition.maxHp * 0.4)
              });
              for (let step = 0; step < 140 && battle.projectiles.length; step += 1) {
                if (step === 18) {
                  target.group.rotation.y = -Math.PI / 2;
                  target.forward.set(-1, 0, 0);
                }
                target.position.addScaledVector(
                  target.forward,
                  target.definition.speed * 0.05
                );
                battle.updateProjectiles(0.05);
              }
              return {
                initialHp,
                finalHp: target.hp,
                targetId: target.id,
                attackerId: attacker.id,
                guidedEvades: battle.guidedEvades,
                guidedMisses: battle.guidedMisses,
                activeProjectiles: battle.projectiles.length,
                targetPosition: target.position.toArray(),
                projectile: battle.projectiles[0] ? {
                  age: battle.projectiles[0].age,
                  life: battle.projectiles[0].life,
                  lockLost: battle.projectiles[0].lockLost,
                  closestTargetDistance: battle.projectiles[0].closestTargetDistance
                } : null,
                warning: document.getElementById('command-hint')?.textContent || ''
              };
            }""")
        evade_state = setup if evade_ready else {}
        evade_verdict = {
            "initialized": evade_ready,
            "lockBrokenByManeuver": evade_state.get("guidedEvades", 0) >= 1,
            "targetUndamaged": (
                evade_state.get("initialHp") is not None
                and evade_state.get("finalHp") == evade_state.get("initialHp")
            ),
            "incomingWarningShown": "미사일" in evade_state.get("warning", ""),
            "noRuntimeErrors": not console_errors and not page_errors and not http_errors,
        }
        evade_passed = all(evade_verdict.values())
        if not evade_passed:
            failures.append("missile:evasion")
        records["missileEvasion"] = {
            "url": evade_url,
            "passed": evade_passed,
            "verdict": evade_verdict,
            "state": evade_state,
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "httpErrors": http_errors,
        }
        print(
            f"[{'PASS' if evade_passed else 'FAIL'}] missile_evasion "
            f"회피={evade_state.get('guidedEvades')} "
            f"HP={evade_state.get('initialHp')}→{evade_state.get('finalHp')}"
        )
        page.close()

        rescue_page = browser.new_page(viewport={"width": 1920, "height": 1080})
        rescue_console, rescue_page_errors, rescue_http = [], [], []
        rescue_page.on("console", lambda message: (
            rescue_console.append(message.text) if message.type == "error" else None
        ))
        rescue_page.on("pageerror", lambda error: rescue_page_errors.append(str(error)))
        rescue_page.on("response", lambda response: (
            rescue_http.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        rescue_url = f"{base}/rts-combat.html?scenario=tanker_rescue&google=0&v=119"
        rescue_page.goto(rescue_url, wait_until="domcontentloaded", timeout=60_000)
        rescue_ready = wait_ready(rescue_page)
        rescue_state = {}
        if rescue_ready:
            rescue_state = rescue_page.evaluate("""() => {
              const api = window.__HORMUZ_RTS__;
              const battle = api.battle;
              while (battle.fleetSelection.helicopter > 0) {
                battle.updateFleetSelection('helicopter', -1);
              }
              const missingRule = {
                startDisabled: battle.dom.start.disabled,
                message: battle.dom.fleetMessage.textContent || ''
              };
              while (
                battle.fleetSelection.helicopter
                < battle.config.fleetSelection.options.helicopter.default
              ) {
                battle.updateFleetSelection('helicopter', 1);
              }
              battle.startBattle();
              const target = battle.units.find((unit) => unit.rescueTarget);
              const helicopter = battle.units.find(
                (unit) => unit.team === 'ally' && unit.type === 'helicopter' && unit.alive
              );
              const enemies = battle.units.filter(
                (unit) => unit.team === 'enemy' && unit.alive
              );
              enemies.forEach((unit) => {
                unit.alive = false;
                unit.hp = 0;
                unit.group.visible = false;
              });
              battle.destroyedEnemies = battle.config.battle.objectiveEnemyCount;
              battle.updateRescueMission(0);
              const stageAfterIntercept = battle.rescueStage;
              helicopter.position.copy(target.position);
              helicopter.position.y = helicopter.definition.altitude;
              for (let step = 0; step < 24; step += 1) {
                battle.updateRescueMission(0.25);
              }
              const stageAfterBoarding = battle.rescueStage;
              target.routeT = 1;
              target.escaped = true;
              battle.checkOutcome();
              window.clearTimeout(battle.resultRevealTimer);
              battle.dom.result.hidden = true;
              return {
                missingRule,
                initialEnemies: enemies.length,
                stageAfterIntercept,
                stageAfterBoarding,
                progress: battle.rescueProgress,
                targetRescued: target.rescued,
                targetEscaped: target.escaped,
                markerVisible: Boolean(battle.rescueMarker?.group?.visible),
                resultPending: battle.resultPending,
                ended: battle.ended,
                success: battle.battleSuccess,
                snapshot: api.getSnapshot().rescue
              };
            }""")
            rescue_page.wait_for_timeout(350)
            rescue_page.screenshot(
                path=str(rescue_screenshot), type="jpeg", quality=86
            )
        rescue_verdict = {
            "initialized": rescue_ready,
            "helicopterRequired": (
                rescue_state.get("missingRule", {}).get("startDisabled") is True
                and "헬기" in rescue_state.get("missingRule", {}).get("message", "")
            ),
            "sixSeparateFastCraft": rescue_state.get("initialEnemies") == 6,
            "interceptToApproach": rescue_state.get("stageAfterIntercept") == "approach",
            "boardingToEgress": (
                rescue_state.get("stageAfterBoarding") == "egress"
                and rescue_state.get("targetRescued") is True
            ),
            "safeWithdrawalWins": (
                rescue_state.get("targetEscaped") is True
                and rescue_state.get("ended") is True
                and rescue_state.get("success") is True
            ),
            "rescueMarkerVisible": rescue_state.get("markerVisible") is True,
            "noRuntimeErrors": (
                not rescue_console and not rescue_page_errors and not rescue_http
            ),
        }
        rescue_passed = all(rescue_verdict.values())
        if not rescue_passed:
            failures.append("tanker:rescue")
        records["tankerRescue"] = {
            "url": rescue_url,
            "passed": rescue_passed,
            "verdict": rescue_verdict,
            "state": rescue_state,
            "consoleErrors": rescue_console,
            "pageErrors": rescue_page_errors,
            "httpErrors": rescue_http,
            "screenshot": str(rescue_screenshot),
        }
        print(
            f"[{'PASS' if rescue_passed else 'FAIL'}] tanker_rescue "
            f"{rescue_state.get('stageAfterIntercept')}→"
            f"{rescue_state.get('stageAfterBoarding')} "
            f"성공={rescue_state.get('success')}"
        )
        rescue_page.close()

        collision_page = browser.new_page(viewport={"width": 1920, "height": 1080})
        collision_console, collision_page_errors, collision_http = [], [], []
        collision_page.on("console", lambda message: (
            collision_console.append(message.text) if message.type == "error" else None
        ))
        collision_page.on("pageerror", lambda error: collision_page_errors.append(str(error)))
        collision_page.on("response", lambda response: (
            collision_http.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        collision_url = (
            f"{base}/rts-combat.html"
            f"?scenario=tanker_rescue&google=0&v=119&collisionqa=1"
        )
        collision_page.goto(collision_url, wait_until="domcontentloaded", timeout=60_000)
        collision_ready = wait_ready(collision_page)
        collision_state = {}
        if collision_ready:
            collision_state = collision_page.evaluate("""() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const distanceBetween = (first, second) => Math.hypot(
                first.x - second.x,
                first.z - second.z
              );
              battle.startBattle();
              battle.paused = true;
              const tanker = battle.units.find((unit) => unit.rescueTarget);
              const destroyer = battle.units.find((unit) => (
                unit.team === 'ally' && unit.type === 'destroyer'
              ));
              battle.units.forEach((unit) => {
                if (unit === tanker || unit === destroyer) return;
                unit.alive = false;
                unit.group.visible = false;
              });
              const axes = [
                tanker.position.clone().set(1, 0, 0),
                tanker.position.clone().set(0, 0, 1),
                tanker.position.clone().set(0.707, 0, 0.707),
                tanker.position.clone().set(0.707, 0, -0.707)
              ];
              const clearance = battle.getSeaClearance(destroyer);
              const axis = axes.find((candidate) => {
                const start = tanker.position.clone().addScaledVector(candidate, -13);
                const goal = tanker.position.clone().addScaledVector(candidate, 13);
                return (
                  !battle.isWorldLand(start, clearance)
                  && !battle.isWorldLand(goal, clearance)
                );
              }) || axes[0];
              const tankerStart = tanker.position.clone();
              const start = tanker.position.clone().addScaledVector(axis, -13);
              const goal = tanker.position.clone().addScaledVector(axis, 13);
              start.y = destroyer.definition.altitude;
              goal.y = destroyer.definition.altitude;
              destroyer.position.copy(start);
              destroyer.lastWaterPosition.copy(start);
              destroyer.currentSpeed = 0;
              destroyer.group.rotation.y = Math.atan2(axis.x, axis.z);
              destroyer.forward.copy(axis);
              destroyer.velocity.set(0, 0, 0);
              destroyer.order = { type: 'move', targetPos: goal };
              const requiredSeparation = battle.getUnitMinimumSeparation(
                destroyer,
                tanker
              );
              let observedMinimum = Infinity;
              let crossedToFarSide = false;
              for (let step = 0; step < 1800; step += 1) {
                battle.elapsed += 1 / 60;
                battle.updateUnits(1 / 60, battle.elapsed);
                const distance = distanceBetween(destroyer.position, tanker.position);
                observedMinimum = Math.min(observedMinimum, distance);
                const projection = (
                  (destroyer.position.x - tanker.position.x) * axis.x
                  + (destroyer.position.z - tanker.position.z) * axis.z
                );
                if (projection > requiredSeparation) crossedToFarSide = true;
              }
              battle.cameraFocus.lerpVectors(
                destroyer.position,
                tanker.position,
                0.5
              );
              battle.cameraHeight = 22;
              battle.cameraDistance = 18;
              battle.updateCamera(0);
              return {
                requiredSeparation,
                observedMinimum,
                minimumRatio: observedMinimum / requiredSeparation,
                crossedToFarSide,
                goalDistance: distanceBetween(destroyer.position, goal),
                capturedTankerMoved: distanceBetween(tanker.position, tankerStart),
                collision: battle.getUnitCollisionSnapshot(),
                navigation: { ...battle.navigationStats },
                destroyerPosition: [
                  destroyer.position.x,
                  destroyer.position.z
                ],
                tankerPosition: [
                  tanker.position.x,
                  tanker.position.z
                ]
              };
            }""")
            collision_page.wait_for_timeout(350)
            collision_page.screenshot(
                path=str(collision_screenshot), type="jpeg", quality=86
            )
        collision_verdict = {
            "initialized": collision_ready,
            "neverEnteredTankerHull": (
                collision_state.get("minimumRatio", 0) >= 0.979
            ),
            "navigatedAroundTanker": (
                collision_state.get("crossedToFarSide") is True
            ),
            "capturedTankerStayedFixed": (
                collision_state.get("capturedTankerMoved", 1) <= 0.01
            ),
            "noFinalOverlap": (
                collision_state.get("collision", {}).get("activeOverlaps") == 0
            ),
            "collisionSystemActivated": (
                collision_state.get("navigation", {}).get(
                    "unitCollisionBlocks", 0
                )
                + collision_state.get("navigation", {}).get(
                    "unitCollisionResolutions", 0
                )
                > 0
            ),
            "noRuntimeErrors": (
                not collision_console
                and not collision_page_errors
                and not collision_http
            ),
        }
        collision_passed = all(collision_verdict.values())
        if not collision_passed:
            failures.append("unit:collision")
        records["unitCollision"] = {
            "url": collision_url,
            "passed": collision_passed,
            "verdict": collision_verdict,
            "state": collision_state,
            "consoleErrors": collision_console,
            "pageErrors": collision_page_errors,
            "httpErrors": collision_http,
            "screenshot": str(collision_screenshot),
        }
        print(
            f"[{'PASS' if collision_passed else 'FAIL'}] unit_collision "
            f"최소간격={collision_state.get('minimumRatio', 0):.3f} "
            f"우회={collision_state.get('crossedToFarSide')}"
        )
        collision_page.close()
        browser.close()

    record = OUT / f"hormuz-rts-{tag}-force-selection-evasion-validation.json"
    record.write_text(json.dumps({
        "allPassed": not failures,
        "failed": failures,
        "easyLabels": EASY_LABELS,
        "scenarios": records,
        "screenshot": str(screenshot),
        "rescueScreenshot": str(rescue_screenshot),
        "collisionScreenshot": str(collision_screenshot),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n기록: {record}")
    print(f"화면: {screenshot}")
    if failures:
        print("실패: " + ", ".join(failures))
        return 1
    print("아군 편성·0대 제외·미사일 회피·유조선 구출·유닛 관통 방지 전부 통과.")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v118")
    parser.add_argument("--only-evasion", action="store_true")
    args = parser.parse_args()
    sys.exit(run(args.base.rstrip("/"), args.tag, args.only_evasion))


if __name__ == "__main__":
    main()
