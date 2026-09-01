"""해병의 실제 양손 소총 사격 자세를 근접 전투 장면에서 검증한다."""

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
        f"?scenario=large_fleet_battle&google=0&qa=marine-posture&v={tag}"
    )
    screenshot = OUT / f"hormuz-rts-{tag}-marine-firing-posture-1920x1080.png"
    front_close = OUT / f"hormuz-rts-{tag}-marine-front-close-1600x1000.png"
    support_close = (
        OUT / f"hormuz-rts-{tag}-marine-support-side-close-1600x1000.png"
    )
    enemy_front_close = (
        OUT / f"hormuz-rts-{tag}-iranian-rifleman-front-close-1600x1000.png"
    )
    enemy_support_close = (
        OUT / f"hormuz-rts-{tag}-iranian-rifleman-side-close-1600x1000.png"
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
            "?.dataset.marinePostureQa === 'ready'",
            timeout=45_000,
        )
        page.wait_for_timeout(1_800)
        metrics = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              return {
                ally: snapshot.formations.marineUnits[0] || null,
                enemy: snapshot.formations.enemyGroundUnits[0] || null,
                render: snapshot.render
              };
            }"""
        )
        page.screenshot(path=str(screenshot), type="png", timeout=60_000)
        page.set_viewport_size({"width": 1600, "height": 1000})
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const marine = battle.units.find(
                unit => unit.team === "ally" && unit.type === "marine" && unit.alive
              );
              if (!marine) return;
              battle.paused = true;
              battle.cameraFollowUnit = null;
              const V3 = marine.position.constructor;
              const focus = marine.position.clone().add(new V3(0, 0.92, 0));
              const forward = marine.forward.clone().setY(0).normalize();
              const side = forward.clone().cross(new V3(0, 1, 0)).normalize();
              battle.updateCameraPosition = () => {};
              battle.camera.position.copy(focus)
                .addScaledVector(forward, 2.45)
                .addScaledVector(side, 0.48)
                .add(new V3(0, 0.12, 0));
              battle.camera.lookAt(focus);
              battle.camera.updateProjectionMatrix();
            }"""
        )
        page.wait_for_timeout(250)
        page.screenshot(path=str(front_close), type="png", timeout=60_000)
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const marine = battle.units.find(
                unit => unit.team === "ally" && unit.type === "marine" && unit.alive
              );
              if (!marine) return;
              const V3 = marine.position.constructor;
              const focus = marine.position.clone().add(new V3(0, 0.94, 0));
              const forward = marine.forward.clone().setY(0).normalize();
              const side = forward.clone().cross(new V3(0, 1, 0)).normalize();
              battle.camera.position.copy(focus)
                .addScaledVector(side, 2.35)
                .addScaledVector(forward, 0.18)
                .add(new V3(0, 0.08, 0));
              battle.camera.lookAt(focus);
              battle.camera.updateProjectionMatrix();
            }"""
        )
        page.wait_for_timeout(250)
        page.screenshot(path=str(support_close), type="png", timeout=60_000)

        enemy_url = (
            f"{base}/rts-combat.html"
            f"?scenario=large_fleet_battle&google=0"
            f"&qa=enemy-posture&view=front&v={tag}"
        )
        page.goto(enemy_url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => document.getElementById('rts-game')"
            "?.dataset.enemyPostureQa === 'ready'",
            timeout=60_000,
        )
        page.wait_for_timeout(450)
        metrics["enemy"] = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              return snapshot.formations.enemyGroundUnits[0] || null;
            }"""
        )
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const enemy = battle.units.find(
                unit => unit.team === "enemy"
                  && unit.type === "enemyMarine"
                  && unit.alive
              );
              if (!enemy) return;
              battle.paused = true;
              battle.cameraFollowUnit = null;
              const V3 = enemy.position.constructor;
              const focus = enemy.position.clone().add(new V3(0, 0.92, 0));
              const forward = enemy.forward.clone().setY(0).normalize();
              const side = forward.clone().cross(new V3(0, 1, 0)).normalize();
              battle.updateCameraPosition = () => {};
              battle.camera.position.copy(focus)
                .addScaledVector(forward, 2.45)
                .addScaledVector(side, 0.34)
                .add(new V3(0, 0.1, 0));
              battle.camera.lookAt(focus);
              battle.camera.updateProjectionMatrix();
            }"""
        )
        page.wait_for_timeout(250)
        page.screenshot(path=str(enemy_front_close), type="png", timeout=60_000)
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              const enemy = battle.units.find(
                unit => unit.team === "enemy"
                  && unit.type === "enemyMarine"
                  && unit.alive
              );
              if (!enemy) return;
              const V3 = enemy.position.constructor;
              const focus = enemy.position.clone().add(new V3(0, 0.94, 0));
              const forward = enemy.forward.clone().setY(0).normalize();
              const side = forward.clone().cross(new V3(0, 1, 0)).normalize();
              battle.camera.position.copy(focus)
                .addScaledVector(side, 2.35)
                .addScaledVector(forward, 0.18)
                .add(new V3(0, 0.08, 0));
              battle.camera.lookAt(focus);
              battle.camera.updateProjectionMatrix();
            }"""
        )
        page.wait_for_timeout(250)
        page.screenshot(path=str(enemy_support_close), type="png", timeout=60_000)
        browser.close()

    ally = metrics["ally"]
    enemy = metrics["enemy"]
    checks = {
        "alliedMarineUsesMeshyCombatRig": bool(
            ally
            and ally["meshy"]
            and ally["meshyAnimation"]
            and ally["weaponBone"] == "RightHand"
            and ally["supportHandBone"] == "LeftHand"
        ),
        "alliedMarineIsAiming": bool(
            ally
            and ally["order"] == "attack"
            and ally["animationState"] == "aim-fire"
        ),
        "alliedRiflePointsAtTarget": bool(
            ally
            and ally["weaponForwardAlignment"] is not None
            and ally["weaponForwardAlignment"] >= 0.985
        ),
        "alliedRifleRemainsLevelAndUpright": bool(
            ally
            and ally["weaponDownAlignment"] is not None
            and ally["weaponDownAlignment"] >= 0.97
        ),
        "alliedTriggerHandLocksGrip": bool(
            ally
            and ally["gripError"] is not None
            and ally["gripError"] <= 0.025
        ),
        "alliedSupportHandLocksForegrip": bool(
            ally
            and ally["supportHandError"] is not None
            and ally["supportHandError"] <= 0.045
        ),
        "alliedStockSeatsAtShoulder": bool(
            ally
            and ally["stockShoulderError"] is not None
            and ally["stockShoulderError"] <= 0.12
        ),
        "alliedRifleSocketsUseRealWorldScale": bool(
            ally
            and ally["rifleSocketSpan"] is not None
            and ally["rifleSocketSpan"] >= 0.62
        ),
        "alliedWristsRemainStraight": bool(
            ally
            and ally["rightWristStraightness"] is not None
            and ally["leftWristStraightness"] is not None
            and ally["rightWristStraightness"] >= 0.95
            and ally["leftWristStraightness"] >= 0.95
        ),
        "freeRifleAnimationReferenceLoaded": bool(
            ally
            and ally["referenceAnimationSource"]
            == "KayKit Character Animations 1.2 CC0"
            and ally["referenceAnimationClip"] == "Shooting(2h)"
            and ally["referenceAnimationTime"] is not None
        ),
        "iranianMarineUsesMeshyStrategicRig": bool(
            enemy
            and enemy["meshy"]
            and enemy["strategicLod"]
            and enemy["animationState"] == "aim-fire"
        ),
        "iranianRiflePointsAtTarget": bool(
            enemy
            and enemy["weaponForwardAlignment"] is not None
            and enemy["weaponForwardAlignment"] >= 0.94
        ),
        "iranianRifleRemainsUpright": bool(
            enemy
            and enemy["weaponDownAlignment"] is not None
            and enemy["weaponDownAlignment"] >= 0.94
        ),
        "iranianTriggerHandLocksGrip": bool(
            enemy
            and enemy["gripError"] is not None
            and enemy["gripError"] <= 0.045
        ),
        "iranianSupportHandLocksForegrip": bool(
            enemy
            and enemy["supportHandError"] is not None
            and enemy["supportHandError"] <= 0.045
        ),
        "iranianStockSeatsAtShoulder": bool(
            enemy
            and enemy["stockShoulderError"] is not None
            and enemy["stockShoulderError"] <= 0.12
        ),
        "noRuntimeErrors": not any(errors.values()),
    }
    passed = all(checks.values())
    record = OUT / f"hormuz-rts-{tag}-marine-firing-posture-validation.json"
    record.write_text(
        json.dumps(
            {
                "url": url,
                "passed": passed,
                "checks": checks,
                "metrics": metrics,
                "errors": errors,
                "screenshot": str(screenshot),
                "front_close_screenshot": str(front_close),
                "support_close_screenshot": str(support_close),
                "enemy_front_close_screenshot": str(enemy_front_close),
                "enemy_support_close_screenshot": str(enemy_support_close),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    for name, ok in checks.items():
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(f"기록: {record}")
    print(f"전체 화면: {screenshot}")
    print(f"정면 확대: {front_close}")
    print(f"지지손 측면 확대: {support_close}")
    print(f"Iranian rifleman front: {enemy_front_close}")
    print(f"Iranian rifleman side: {enemy_support_close}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="해병의 양손 소총 사격 자세 검증"
    )
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
