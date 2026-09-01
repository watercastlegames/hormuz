"""HORMUZ 곡괭이산 B-2·GBU-57 제한 타격 기능 검증.

로컬 서버가 127.0.0.1:8080에서 저장소 루트를 제공하는 상태에서 실행한다.
편성 제한, 실제 발사체 충돌, 2발 탄약 제한, 목표 전용 승리 판정을 함께 확인한다.
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def wait_ready(page):
    for _ in range(100):
        try:
            if page.evaluate(
                "() => Boolean(window.__HORMUZ_RTS__?.getSnapshot().initialized)"
            ):
                return True
        except Exception:
            pass
        page.wait_for_timeout(400)
    return False


def run(base, tag, skip_google=False):
    OUT.mkdir(parents=True, exist_ok=True)
    briefing_shot = OUT / f"hormuz-rts-{tag}-pickaxe-briefing-1920x1080.jpg"
    battlefield_shot = OUT / f"hormuz-rts-{tag}-pickaxe-battlefield-1920x1080.jpg"
    google_shot = OUT / f"hormuz-rts-{tag}-pickaxe-google3d-1920x1080.jpg"
    result_shot = OUT / f"hormuz-rts-{tag}-pickaxe-success-1920x1080.jpg"
    result_json = OUT / f"hormuz-rts-{tag}-pickaxe-strike.json"
    url = f"{base}/rts-combat.html?scenario=pickaxe_mountain&google=0&v=119"

    console_errors = []
    page_errors = []
    http_errors = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on("console", lambda message: (
            console_errors.append(message.text) if message.type == "error" else None
        ))
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: (
            http_errors.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        ready = wait_ready(page)

        if not ready:
            browser.close()
            record = {
                "url": url,
                "passed": False,
                "error": "RTS runtime did not initialize",
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
            }
            result_json.write_text(
                json.dumps(record, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return (
                record,
                result_json,
                briefing_shot,
                battlefield_shot,
                google_shot,
                result_shot,
            )

        initial = page.evaluate("""() => {
          const api = window.__HORMUZ_RTS__;
          const battle = api.battle;
          const factNotice = document.getElementById('fact-notice')?.textContent || '';
          battle.updateFleetSelection('bomber', -99);
          battle.startBattle();
          const blockedAtZero = !battle.started;
          const zeroMessage = document.getElementById('fleet-message')?.textContent || '';
          battle.updateFleetSelection('bomber', 1);
          battle.updateFleetBuilder();
          return {
            snapshot: api.getSnapshot(),
            blockedAtZero,
            zeroMessage,
            factNotice,
            briefingImage: document.getElementById('brief-image')?.getAttribute('src') || '',
            onlyB2Available: (
              api.getSnapshot().fleet.availableTypes.length === 1
              && api.getSnapshot().fleet.availableTypes[0] === 'bomber'
            ),
            bomberDefinition: {
              name: battle.config.unitTypes.bomber.name,
              weapon: battle.config.unitTypes.bomber.weapon,
              maxShots: battle.config.unitTypes.bomber.maxShots,
              damage: battle.config.unitTypes.bomber.damage
            },
            objectiveTargetType: battle.config.battle.objectiveTargetType,
            objectiveCount: battle.config.battle.objectiveEnemyCount
          };
        }""")
        page.screenshot(path=str(briefing_shot), type="jpeg", quality=90)

        setup = page.evaluate("""() => {
          const api = window.__HORMUZ_RTS__;
          const battle = api.battle;
          battle.startBattle();
          battle.paused = true;
          battle.config.battle.enemyEngageDelaySeconds = 999;
          const bomber = battle.units.find(
            (unit) => unit.team === 'ally' && unit.type === 'bomber' && unit.alive
          );
          const bunkers = battle.units.filter(
            (unit) => unit.team === 'enemy' && unit.type === 'bunkerEntrance'
          );
          battle.selectUnits(bomber ? [bomber] : []);
          battle.cameraFollowUnit = null;
          if (bunkers.length) {
            battle.cameraFocus.copy(bunkers[0].position).setY(0);
            battle.cameraHeight = 26;
            battle.cameraDistance = 23;
            battle.updateCameraPosition(true);
          }
          return {
            started: battle.started,
            bomberCount: battle.units.filter(
              (unit) => unit.team === 'ally' && unit.type === 'bomber'
            ).length,
            bunkerCount: bunkers.length
          };
        }""")
        page.wait_for_timeout(800)
        page.screenshot(path=str(battlefield_shot), type="jpeg", quality=90)

        combat = page.evaluate("""() => {
          const api = window.__HORMUZ_RTS__;
          const battle = api.battle;
          const bomber = battle.units.find(
            (unit) => unit.team === 'ally' && unit.type === 'bomber' && unit.alive
          );
          const bunkers = battle.units.filter(
            (unit) => unit.team === 'enemy' && unit.type === 'bunkerEntrance'
          );
          const defenses = battle.units.filter(
            (unit) => unit.team === 'enemy' && unit.type === 'tel'
          );
          if (bomber && bunkers.length === 2) {
            bunkers.forEach((target, index) => {
              bomber.position.copy(target.position);
              bomber.position.x += index === 0 ? -7.4 : 7.4;
              bomber.position.y += bomber.definition.altitude;
              bomber.position.z -= 6.8;
              bomber.group.position.copy(bomber.position);
              bomber.nextShotAt = 0;
              battle.elapsed += 10;
              battle.tryFire(bomber, target, battle.elapsed);
              for (let step = 0; step < 180 && battle.projectiles.length; step += 1) {
                battle.updateProjectiles(0.04);
              }
            });
          }

          const shotsAfterTargets = bomber?.shotsFired ?? -1;
          const deniedThirdShot = bomber && defenses[0]
            ? battle.tryFire(bomber, defenses[0], battle.elapsed + 10) === false
            : false;
          battle.checkOutcome();
          window.clearTimeout(battle.resultRevealTimer);
          battle.revealBattleResult();
          battle.resetCameraOverview();

          return {
            started: battle.started,
            bomberCount: battle.units.filter(
              (unit) => unit.team === 'ally' && unit.type === 'bomber'
            ).length,
            bomberMeshy: Boolean(bomber?.meshyModel || bomber?.instancedBatch?.meshySource),
            bomberShots: shotsAfterTargets,
            deniedThirdShot,
            bunkerCount: bunkers.length,
            bunkerAlive: bunkers.filter((unit) => unit.alive).length,
            bunkerObjectiveFlags: bunkers.map((unit) => unit.objectiveTarget),
            defenseCount: defenses.length,
            defensesAlive: defenses.filter((unit) => unit.alive).length,
            landUnitsValid: battle.units
              .filter((unit) => unit.definition.domain === 'land')
              .every((unit) => unit.geographic.onLand),
            objectiveDestroyed: battle.getObjectiveDestroyedCount(),
            destroyedEnemies: battle.destroyedEnemies,
            bunkerBombShots: battle.weaponShots.bunkerBomb || 0,
            bunkerBombHits: battle.weaponHits.bunkerBomb || 0,
            ended: battle.ended,
            success: battle.battleSuccess,
            resultVisible: !battle.dom.result.hidden,
            resultText: battle.dom.resultText.textContent,
            resultImage: battle.dom.resultImage.getAttribute('src') || '',
            ammoMessage: battle.dom.hint.textContent
          };
        }""")
        page.wait_for_timeout(700)
        page.screenshot(path=str(result_shot), type="jpeg", quality=90)

        google_url = f"{base}/rts-combat.html?scenario=pickaxe_mountain&google=1&v=119"
        google_ready = False
        google_status = "skipped"
        google_state = {}
        if not skip_google:
            google_page = browser.new_page(viewport={"width": 1920, "height": 1080})
            google_page.goto(google_url, wait_until="domcontentloaded", timeout=60_000)
            google_ready = wait_ready(google_page)
            google_status = "uninitialized"
            if google_ready:
                for _ in range(80):
                    google_status = google_page.evaluate(
                        "() => document.getElementById('rts-game')?.dataset.googleBattleMapStatus || ''"
                    )
                    if google_status in {"ready", "fallback"}:
                        break
                    google_page.wait_for_timeout(500)
            google_state = google_page.evaluate("""() => {
              const battle = window.__HORMUZ_RTS__?.battle;
              if (!battle) return {};
              battle.startBattle();
              battle.paused = true;
              const bunkers = battle.units.filter(
                (unit) => unit.team === 'enemy' && unit.type === 'bunkerEntrance'
              );
              if (bunkers.length) {
                battle.cameraFollowUnit = null;
                battle.cameraFocus.copy(bunkers[0].position).setY(0);
                battle.cameraHeight = 26;
                battle.cameraDistance = 23;
                battle.updateCameraPosition(true);
              }
              return window.__HORMUZ_RTS__.getSnapshot();
            }""") if google_ready else {}
            google_page.wait_for_timeout(1800)
            google_page.screenshot(path=str(google_shot), type="jpeg", quality=90)
            google_page.close()
        browser.close()

    verdict = {
        "initialized": ready,
        "zeroB2Blocked": (
            initial["blockedAtZero"]
            and "B-2" in initial["zeroMessage"]
            and "GBU-57" in initial["zeroMessage"]
        ),
        "onlyB2Available": initial["onlyB2Available"],
        "correctWeaponDefinition": (
            initial["bomberDefinition"]["weapon"] == "bunkerBomb"
            and initial["bomberDefinition"]["maxShots"] == 2
            and "B-2" in initial["bomberDefinition"]["name"]
        ),
        "factBoundaryVisible": (
            "IAEA" in initial["factNotice"]
            and "별도 지하시설" in initial["factNotice"]
        ),
        "dedicatedBriefingVisual": (
            initial["briefingImage"]
            == "assets/images/briefings/pickaxe-mountain-b2-briefing-v1.webp"
        ),
        "twoObjectiveTargets": (
            initial["objectiveTargetType"] == "bunkerEntrance"
            and initial["objectiveCount"] == 2
            and combat["bunkerCount"] == 2
            and all(combat["bunkerObjectiveFlags"])
        ),
        "actualTwoBombImpacts": (
            combat["bomberShots"] == 2
            and combat["bunkerBombShots"] == 2
            and combat["bunkerBombHits"] == 2
            and combat["bunkerAlive"] == 0
        ),
        "thirdShotDenied": combat["deniedThirdShot"],
        "optionalDefensesExcluded": (
            combat["defenseCount"] == 3
            and combat["defensesAlive"] == 3
            and combat["destroyedEnemies"] == 2
        ),
        "objectiveVictory": (
            combat["objectiveDestroyed"] == 2
            and combat["ended"]
            and combat["success"]
            and combat["resultVisible"]
            and "확인되지 않았습니다" in combat["resultText"]
            and combat["resultImage"]
            == "assets/images/briefings/pickaxe-mountain-access-sealed-v1.webp"
        ),
        "landPlacementValid": combat["landUnitsValid"],
        "meshyB2Loaded": combat["bomberMeshy"],
        "google3dTerrainReadyOrSkipped": (
            skip_google
            or (
                google_ready
                and google_status == "ready"
                and google_state.get("map", {}).get("provider") == "google-3d"
            )
        ),
        "noRuntimeErrors": not console_errors and not page_errors and not http_errors,
    }
    record = {
        "url": url,
        "passed": all(verdict.values()),
        "verdict": verdict,
        "initial": initial,
        "combat": combat,
        "google3d": {
            "url": google_url,
            "skipped": skip_google,
            "ready": google_ready,
            "status": google_status,
            "state": google_state,
        },
        "screenshots": [
            str(briefing_shot),
            str(battlefield_shot),
            str(google_shot),
            str(result_shot),
        ],
        "setup": setup,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "httpErrors": http_errors,
    }
    result_json.write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return (
        record,
        result_json,
        briefing_shot,
        battlefield_shot,
        google_shot,
        result_shot,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v119")
    parser.add_argument("--skip-google", action="store_true")
    args = parser.parse_args()

    (
        record,
        result_json,
        briefing_shot,
        battlefield_shot,
        google_shot,
        result_shot,
    ) = run(args.base, args.tag, args.skip_google)
    print(f"[{'PASS' if record['passed'] else 'FAIL'}] pickaxe_mountain")
    print(json.dumps(record.get("verdict", {}), ensure_ascii=False, indent=2))
    print(result_json)
    if briefing_shot.exists():
        print(briefing_shot)
    if battlefield_shot.exists():
        print(battlefield_shot)
    if google_shot.exists():
        print(google_shot)
    if result_shot.exists():
        print(result_shot)
    return 0 if record["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
