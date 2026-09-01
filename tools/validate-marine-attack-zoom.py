"""해병 A 공격 명령과 마우스 휠 50% 확대 제한을 실제 입력으로 검증한다."""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def wait_ready(page):
    page.wait_for_function(
        "() => Boolean(window.__HORMUZ_RTS__?.getSnapshot().initialized)",
        timeout=60_000,
    )


def run(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    output = OUT / f"hormuz-rts-{tag}-marine-attack-zoom-validation.json"
    screenshot = OUT / f"hormuz-rts-{tag}-marine-a-attack-1920x1080.jpg"
    url = (
        f"{base}/rts-combat.html?"
        f"scenario=coastal_battery&google=0&lang=ko&v=119"
    )
    console_errors, page_errors, http_errors = [], [], []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on("console", lambda message: (
            console_errors.append(message.text)
            if message.type == "error" else None
        ))
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: (
            http_errors.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        wait_ready(page)
        target = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          battle.config.battle.enemyEngageDelaySeconds = 999;
          battle.startBattle();
          battle.paused = true;
          const marine = battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'marine'
          );
          const guard = battle.units.find(
            (unit) => unit.alive && unit.team === 'enemy' && unit.type === 'enemyMarine'
          );
          if (!marine || !guard) return {ready: false};
          battle.selectUnits([marine]);
          battle.cameraFollowUnit = null;
          battle.cameraFocus.copy(guard.position).setY(0);
          battle.cameraHeight = 30;
          battle.cameraDistance = 26;
          battle.updateCameraPosition(true);
          battle.camera.updateMatrixWorld(true);
          battle.scene.updateMatrixWorld(true);
          const projected = guard.group.position.clone().project(battle.camera);
          const rect = battle.canvas.getBoundingClientRect();
          return {
            ready: true,
            marineId: marine.id,
            guardId: guard.id,
            clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
            clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
            landTargetAllowed: battle.canUnitAttackTarget(marine, guard),
            seaTargetRejected: !battle.canUnitAttackTarget(marine, {
              alive: true,
              team: 'enemy',
              definition: {domain: 'sea'}
            }),
            airTargetRejected: !battle.canUnitAttackTarget(marine, {
              alive: true,
              team: 'enemy',
              definition: {domain: 'air'}
            })
          };
        }""")

        if target.get("ready"):
            page.keyboard.press("a")
            page.mouse.click(target["clientX"], target["clientY"])
            page.wait_for_timeout(250)

        attack_state = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const marine = battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'marine'
          );
          return {
            selected: [...battle.selected].map((unit) => unit.id),
            inspectedEnemies: [...battle.inspectedEnemies].map((unit) => unit.id),
            commandMode: battle.commandMode,
            lastCommand: battle.lastCommand,
            order: marine?.order?.type || null,
            orderTarget: marine?.order?.targetUnit?.id || null,
            lastPrimaryPick: battle.dom.shell.dataset.lastPrimaryPick || null
          };
        }""")
        page.screenshot(path=str(screenshot), type="jpeg", quality=88)

        overview = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          battle.resetCameraOverview();
          return window.__HORMUZ_RTS__.getSnapshot().camera;
        }""")
        canvas_box = page.locator("#rts-canvas").bounding_box()
        if canvas_box:
            page.mouse.move(
                canvas_box["x"] + canvas_box["width"] * 0.5,
                canvas_box["y"] + canvas_box["height"] * 0.5,
            )
            page.mouse.wheel(0, -100_000)
            page.wait_for_timeout(250)
        zoomed = page.evaluate(
            "() => window.__HORMUZ_RTS__.getSnapshot().camera"
        )
        browser.close()

    verdict = {
        "runtimeInitialized": target.get("ready") is True,
        "aEnemyClickKeepsMarineSelected": (
            target.get("marineId") in attack_state.get("selected", [])
            and not attack_state.get("inspectedEnemies")
        ),
        "aEnemyClickIssuesDirectAttack": (
            attack_state.get("order") == "attack"
            and attack_state.get("orderTarget") == target.get("guardId")
            and attack_state.get("lastCommand") == f"attack:{target.get('guardId')}"
            and attack_state.get("lastPrimaryPick") == target.get("guardId")
            and attack_state.get("commandMode") is None
        ),
        "marineTargetsLandOnly": (
            target.get("landTargetAllowed") is True
            and target.get("seaTargetRejected") is True
            and target.get("airTargetRejected") is True
        ),
        "wheelZoomStopsAtFiftyPercent": (
            zoomed.get("wheelZoomInLimitPercent") == 50
            and abs(
                zoomed.get("height", 0)
                - zoomed.get("minimumWheelHeight", -1)
            ) < 0.01
            and abs(
                zoomed.get("distance", 0)
                - zoomed.get("minimumWheelDistance", -1)
            ) < 0.01
            and abs(zoomed.get("height", 0) - overview.get("height", 0) * 0.5) < 0.01
            and abs(
                zoomed.get("distance", 0)
                - overview.get("distance", 0) * 0.5
            ) < 0.01
        ),
        "noRuntimeErrors": (
            not console_errors and not page_errors and not http_errors
        ),
    }
    payload = {
        "version": tag,
        "url": url,
        "passed": all(verdict.values()),
        "verdict": verdict,
        "target": target,
        "attackState": attack_state,
        "overviewCamera": overview,
        "maximumWheelZoomCamera": zoomed,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "httpErrors": http_errors,
        "screenshot": str(screenshot),
    }
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["passed"] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v119")
    args = parser.parse_args()
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    sys.exit(main())
