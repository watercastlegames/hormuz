"""B-2 시각 전방축과 해병 소총 양손 결착을 실제 런타임에서 검증한다."""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def run(base: str, tag: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    errors = {"console": [], "page": [], "http": []}
    url = (
        f"{base}/rts-combat.html"
        f"?scenario=large_fleet_battle&google=0&qa=marine-animation&v={tag}"
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on(
            "console",
            lambda message: (
                errors["console"].append(message.text)
                if message.type == "error"
                else None
            ),
        )
        page.on("pageerror", lambda error: errors["page"].append(str(error)))
        page.on(
            "response",
            lambda response: (
                errors["http"].append(f"{response.status} {response.url}")
                if response.status >= 400
                else None
            ),
        )
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => !!(window.__HORMUZ_RTS__"
            " && window.__HORMUZ_RTS__.getSnapshot().initialized)",
            timeout=60_000,
        )
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.marineAnimationQa === 'aim-fire'",
            timeout=45_000,
        )
        page.wait_for_timeout(900)
        metrics = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              const bomberCard = document.querySelector(
                '[data-fleet-type="bomber"] span'
              );
              return {
                bomberLabel: bomberCard?.textContent?.trim() || '',
                bomberUnits: snapshot.formations.bomberUnits,
                marineUnits: snapshot.formations.marineUnits,
                render: snapshot.render
              };
            }"""
        )
        screenshot = (
            OUT
            / f"hormuz-rts-{tag}-stealth-bomber-marine-alignment-1920x1080.png"
        )
        page.screenshot(path=str(screenshot), type="png")

        bomber_url = (
            f"{base}/rts-combat.html"
            f"?scenario=pickaxe_mountain&google=0&v={tag}"
        )
        page.goto(bomber_url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => !!(window.__HORMUZ_RTS__"
            " && window.__HORMUZ_RTS__.getSnapshot().initialized)",
            timeout=60_000,
        )
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              battle.config.battle.enemyEngageDelaySeconds = 999;
              battle.startBattle();
              battle.timeScale = 3.5;
              const bomber = battle.units.find(
                (unit) => unit.alive && unit.type === 'bomber'
              );
              const first = battle.units.find(
                (unit) => unit.alive && unit.type === 'bunkerEntrance'
              );
              if (!bomber || !first) return;
              battle.selectUnits([bomber]);
              battle.issueAttack(first);
            }"""
        )
        page.wait_for_function(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              const bomber = snapshot.formations.bomberUnits[0];
              return bomber?.shotsFired >= 1
                && snapshot.formations.bunkerTargets.filter(
                  (target) => !target.alive
                ).length >= 1;
            }""",
            timeout=45_000,
        )
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const bomber = battle.units.find(
                (unit) => unit.alive && unit.type === 'bomber'
              );
              const second = battle.units.find(
                (unit) => unit.alive && unit.type === 'bunkerEntrance'
              );
              if (bomber && second) {
                battle.timeScale = 3.5;
                bomber.position.set(
                  second.position.x,
                  bomber.definition.altitude,
                  second.position.z - 10
                );
                bomber.forward.set(0, 0, 1);
                bomber.group.rotation.y = 0;
                bomber.currentSpeed = 0;
                battle.issueAttack(second);
              }
            }"""
        )
        page.wait_for_function(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              const bomber = snapshot.formations.bomberUnits[0];
              return bomber?.shotsFired >= 2
                && snapshot.formations.bunkerTargets.every(
                  (target) => !target.alive
                );
            }""",
            timeout=45_000,
        )
        payload_metrics = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              const battle = window.__HORMUZ_RTS__.battle;
              const bomberUnit = battle.units.find(
                (unit) => unit.alive && unit.type === 'bomber'
              );
              return {
                bomber: snapshot.formations.bomberUnits[0],
                targets: snapshot.formations.bunkerTargets,
                fx: snapshot.fx,
                resultPending: snapshot.result?.pending || false,
                debug: bomberUnit ? {
                  elapsed: battle.elapsed,
                  order: bomberUnit.order?.type || null,
                  orderTarget: bomberUnit.order?.targetUnit?.id || null,
                  nextShotAt: bomberUnit.nextShotAt,
                  position: bomberUnit.position.toArray(),
                  forward: bomberUnit.forward.toArray()
                } : null
              };
            }"""
        )
        payload_screenshot = (
            OUT
            / f"hormuz-rts-{tag}-b2-two-gbu57-impact-1920x1080.png"
        )
        page.screenshot(path=str(payload_screenshot), type="png")

        page.goto(
            f"{bomber_url}&axis=1",
            wait_until="domcontentloaded",
            timeout=60_000,
        )
        page.wait_for_function(
            "() => !!(window.__HORMUZ_RTS__"
            " && window.__HORMUZ_RTS__.getSnapshot().initialized)",
            timeout=60_000,
        )
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              battle.config.battle.enemyEngageDelaySeconds = 999;
              battle.startBattle();
              const bomber = battle.units.find(
                (unit) => unit.alive && unit.type === 'bomber'
              );
              if (!bomber) return;
              battle.selectUnits([bomber]);
              const target = bomber.position.clone();
              target.z += 14;
              battle.issueMove(target, false);
              bomber.forward.set(0, 0, 1);
              bomber.group.rotation.y = 0;
              battle.cameraFollowUnit = null;
              battle.started = false;
              battle.camera.position.set(
                bomber.position.x + 7,
                bomber.position.y + 13,
                bomber.position.z - 11
              );
              battle.camera.lookAt(
                bomber.position.x,
                bomber.position.y,
                bomber.position.z + 3
              );
            }"""
        )
        page.wait_for_timeout(700)
        bomber_screenshot = (
            OUT
            / f"hormuz-rts-{tag}-stealth-bomber-flight-axis-1920x1080.png"
        )
        page.screenshot(path=str(bomber_screenshot), type="png")
        browser.close()

    bomber_units = metrics["bomberUnits"]
    marine_units = metrics["marineUnits"]
    checks = {
        "plainKoreanStealthBomberLabel": (
            metrics["bomberLabel"] == "스텔스 폭격기"
        ),
        "oneMeshyStealthBomber": (
            len(bomber_units) == 1
            and bomber_units[0]["meshy"]
            and bomber_units[0]["name"]
            == "B-2A 스피릿 스텔스 폭격기"
        ),
        "bomberVisualNoseMatchesFlightDirection": (
            len(bomber_units) == 1
            and abs(bomber_units[0]["modelYaw"] - 1.5708) <= 0.0002
            and bomber_units[0]["visualHeadingDot"] >= 0.995
        ),
        "fourAlliedMarinesInCombatPose": (
            len(marine_units) == 4
            and all(
                row["order"] == "attack"
                and row["animationState"] in {"rifle-up-walk", "aim-fire"}
                for row in marine_units
            )
        ),
        "riflesAttachedToRightHandAndSupportedByLeft": (
            len(marine_units) == 4
            and all(
                row["weaponBone"] == "RightHand"
                and row["supportHandBone"] == "LeftHand"
                for row in marine_units
            )
        ),
        "riflesLockedToShouldersHandsAndTargets": (
            len(marine_units) == 4
            and all(
                row["weaponForwardAlignment"] is not None
                and row["weaponForwardAlignment"] >= 0.985
                for row in marine_units
            )
        ),
        "rifleGripsLockedToRightHands": (
            len(marine_units) == 4
            and all(
                row["gripError"] is not None
                and row["gripError"] <= 0.025
                for row in marine_units
            )
        ),
        "rifleStocksSeatAtShoulders": (
            len(marine_units) == 4
            and all(
                row["stockShoulderError"] is not None
                and row["stockShoulderError"] <= 0.12
                for row in marine_units
            )
        ),
        "supportHandsLockForegrips": (
            len(marine_units) == 4
            and all(
                row["supportHandError"] is not None
                and row["supportHandError"] <= 0.045
                for row in marine_units
            )
        ),
        "rifleHandlesPointTowardGround": (
            len(marine_units) == 4
            and all(
                row["weaponDownAlignment"] is not None
                and row["weaponDownAlignment"] >= 0.94
                for row in marine_units
            )
        ),
        "twoGbu57WeaponsConfigured": (
            payload_metrics["bomber"]["maxShots"] == 2
            and payload_metrics["bomber"]["shotsFired"] == 2
            and payload_metrics["bomber"]["remainingShots"] == 0
        ),
        "oneGbu57OutpowersOneEntrance": (
            payload_metrics["bomber"]["damage"]
            > max(target["maxHp"] for target in payload_metrics["targets"])
        ),
        "twoEntrancesSealedByTwoReleases": (
            len(payload_metrics["targets"]) == 2
            and all(not target["alive"] for target in payload_metrics["targets"])
        ),
        "penetratorImpactUsesHeavyParticles": (
            payload_metrics["fx"]["hotParticles"] >= 40
            and payload_metrics["fx"]["smokeParticles"] >= 20
        ),
        "noRuntimeErrors": not any(errors.values()),
    }
    passed = all(checks.values())
    record = (
        OUT
        / f"hormuz-rts-{tag}-stealth-bomber-marine-alignment-validation.json"
    )
    record.write_text(
        json.dumps(
            {
                "url": url,
                "passed": passed,
                "checks": checks,
                "metrics": metrics,
                "payloadMetrics": payload_metrics,
                "errors": errors,
                "screenshot": str(screenshot),
                "bomberScreenshot": str(bomber_screenshot),
                "payloadScreenshot": str(payload_screenshot),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    for name, ok in checks.items():
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(f"기록: {record}")
    print(f"화면: {screenshot}")
    print(f"B-2 화면: {bomber_screenshot}")
    print(f"GBU-57 2발 화면: {payload_screenshot}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="B-2·해병 소총 결착 런타임 검증"
    )
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
