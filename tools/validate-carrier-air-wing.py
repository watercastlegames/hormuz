"""항공모함의 주 공격이 선체 미사일이 아닌 함재기 출격으로 표현되는지 검증한다."""

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
        f"?scenario=large_fleet_battle&google=0&v={tag}&carrierqa=1"
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
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
        page.evaluate(
            """() => {
              const battle = window.__HORMUZ_RTS__.battle;
              battle.config.battle.enemyEngageDelaySeconds = 999;
              battle.timeScale = 1;
              battle.startBattle();
              const carrier = battle.units.find(
                (unit) => unit.alive
                  && unit.team === 'ally'
                  && unit.type === 'carrier'
              );
              const target = battle.units.find(
                (unit) => unit.alive
                  && unit.team === 'enemy'
                  && unit.definition.domain === 'sea'
              );
              if (!carrier || !target) return;
              target.position.copy(carrier.position).add(
                carrier.forward.clone().multiplyScalar(18)
              );
              target.position.y = target.definition.altitude;
              battle.selectUnits([carrier]);
              battle.issueAttack(target);
              battle.cameraFollowUnit = carrier;
              battle.cameraFocus.copy(carrier.position).setY(0);
              battle.cameraHeight = 13;
              battle.cameraDistance = 15;
              battle.updateCameraPosition(true);
            }"""
        )
        page.wait_for_function(
            "() => window.__HORMUZ_RTS__.getSnapshot()"
            ".formations.carrierAirWingLaunches >= 1",
            timeout=45_000,
        )
        page.wait_for_timeout(460)
        screenshot = (
            OUT
            / f"hormuz-rts-{tag}-carrier-air-wing-launch-1920x1080.jpg"
        )
        page.screenshot(
            path=str(screenshot),
            type="jpeg",
            quality=91,
            timeout=60_000,
        )
        page.wait_for_function(
            "() => window.__HORMUZ_RTS__.getSnapshot()"
            ".formations.carrierAirWingHits >= 1",
            timeout=45_000,
        )
        metrics = page.evaluate(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              return {
                carrier: snapshot.formations.carrierUnits[0],
                launches: snapshot.formations.carrierAirWingLaunches,
                hits: snapshot.formations.carrierAirWingHits,
                weaponShots: snapshot.combat?.weaponShots || null
              };
            }"""
        )
        browser.close()

    carrier = metrics["carrier"]
    checks = {
        "carrierPrimaryAttackIsAirWing": (
            carrier["weapon"] == "carrierAirWing"
            and "함재기" in carrier["weaponSystem"]
        ),
        "carrierCloseWeaponIsSelfDefense": (
            "근접방어" in carrier["closeWeapon"]
        ),
        "twoAircraftSortieLaunched": metrics["launches"] >= 1,
        "airWingAttackReachedTarget": metrics["hits"] >= 1,
        "noRuntimeErrors": not any(errors.values()),
    }
    passed = all(checks.values())
    record = OUT / f"hormuz-rts-{tag}-carrier-air-wing-validation.json"
    record.write_text(
        json.dumps(
            {
                "url": url,
                "passed": passed,
                "checks": checks,
                "metrics": metrics,
                "errors": errors,
                "screenshot": str(screenshot),
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
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="항공모함 함재기 출격 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
