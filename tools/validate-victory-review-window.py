"""승리 확정 후 3초 동안 전장 이동·입력이 계속되는지 검증한다."""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def run(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    output = OUT / f"hormuz-rts-{tag}-victory-review-window-validation.json"
    screenshot = OUT / f"hormuz-rts-{tag}-victory-review-moving-1920x1080.jpg"
    url = (
        f"{base}/rts-combat.html?"
        f"scenario=convoy_shield&google=0&lang=ko&v=120"
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
        page.wait_for_function(
            "() => Boolean(window.__HORMUZ_RTS__?.getSnapshot().initialized)",
            timeout=60_000,
        )
        setup = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          battle.config.battle.enemyEngageDelaySeconds = 999;
          battle.startBattle();
          const fighter = battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'fighter'
          );
          if (!fighter) return {ready: false};
          battle.selectUnits([fighter]);
          const target = fighter.position.clone().add({x: 13, y: 0, z: 8});
          const midpoint = fighter.position.clone().lerp(target, 0.5);
          battle.cameraFollowUnit = null;
          battle.cameraFocus.copy(midpoint).setY(0);
          battle.cameraHeight = 20;
          battle.cameraDistance = 18;
          battle.updateCameraPosition(true);
          battle.camera.updateMatrixWorld(true);
          battle.scene.updateMatrixWorld(true);
          const projected = target.clone().project(battle.camera);
          const rect = battle.canvas.getBoundingClientRect();
          const startPosition = fighter.position.toArray();
          const elapsedAtVictory = battle.elapsed;
          const remainingAtVictory = battle.remaining;
          battle.endBattle(true);
          battle.canvas.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
            clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
            button: 2,
            buttons: 2
          }));
          return {
            ready: true,
            fighterId: fighter.id,
            startPosition,
            elapsedAtVictory,
            remainingAtVictory,
            clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
            clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
            resultStartedAt: battle.resultPendingStartedAt
          };
        }""")

        if setup.get("ready"):
            page.wait_for_timeout(120)
        command_state = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const fighter = battle.units.find(
            (unit) => unit.id === 'vfa-27-1'
          ) || battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'fighter'
          );
          return {
            lastCommand: battle.lastCommand,
            order: fighter?.order?.type || null,
            resultPending: battle.resultPending,
            resultVisible: !battle.dom.result.hidden,
            resultReviewInteractive: (
              battle.dom.shell.dataset.resultReviewInteractive === 'true'
            ),
            commandButtonsEnabled: [...document.querySelectorAll(
              "[data-command]:not([data-command='pause']):not([data-command='selectAll'])"
            )].some((button) => !button.disabled)
          };
        }""")

        page.wait_for_function(
            """() => {
              const snapshot = window.__HORMUZ_RTS__.getSnapshot();
              return snapshot.resultPending && snapshot.postBattleElapsed >= 0.8;
            }""",
            timeout=60_000,
        )
        moving_state = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const fighter = battle.units.find(
            (unit) => unit.id === 'vfa-27-1'
          ) || battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'fighter'
          );
          const snapshot = window.__HORMUZ_RTS__.getSnapshot();
          return {
            position: fighter?.position.toArray() || [],
            order: fighter?.order?.type || null,
            elapsed: snapshot.elapsed,
            remaining: snapshot.remaining,
            postBattleElapsed: snapshot.postBattleElapsed,
            resultPending: snapshot.resultPending,
            resultVisible: snapshot.resultVisible,
            resultReviewInteractive: snapshot.resultReviewInteractive
          };
        }""")
        page.screenshot(path=str(screenshot), type="jpeg", quality=88)

        page.wait_for_function(
            "() => window.__HORMUZ_RTS__.getSnapshot().resultVisible",
            timeout=60_000,
        )
        revealed_state = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const fighter = battle.units.find(
            (unit) => unit.id === 'vfa-27-1'
          ) || battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'fighter'
          );
          const snapshot = window.__HORMUZ_RTS__.getSnapshot();
          return {
            position: fighter?.position.toArray() || [],
            paused: snapshot.paused,
            resultPending: snapshot.resultPending,
            resultVisible: snapshot.resultVisible,
            resultReviewInteractive: snapshot.resultReviewInteractive,
            resultRevealReady: snapshot.resultRevealReady,
            postBattleElapsed: snapshot.postBattleElapsed,
            actualDelayMs: Number(
              battle.dom.shell.dataset.resultActualDelayMs
            ) || 0,
            commandButtonsDisabled: [...document.querySelectorAll(
              "[data-command]:not([data-command='pause']):not([data-command='selectAll'])"
            )].every((button) => button.disabled)
          };
        }""")
        page.wait_for_timeout(500)
        stopped_position = page.evaluate("""() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const fighter = battle.units.find(
            (unit) => unit.id === 'vfa-27-1'
          ) || battle.units.find(
            (unit) => unit.alive && unit.team === 'ally' && unit.type === 'fighter'
          );
          return fighter?.position.toArray() || [];
        }""")
        browser.close()

    def planar_distance(first, second):
        if len(first) < 3 or len(second) < 3:
            return 0
        return (
            (first[0] - second[0]) ** 2
            + (first[2] - second[2]) ** 2
        ) ** 0.5

    moved_during_review = planar_distance(
        setup.get("startPosition", []),
        moving_state.get("position", []),
    )
    moved_after_popup = planar_distance(
        revealed_state.get("position", []),
        stopped_position,
    )
    verdict = {
        "runtimeInitialized": setup.get("ready") is True,
        "rightClickMoveAcceptedAfterVictory": (
            command_state.get("lastCommand") == "move"
            and command_state.get("order") == "move"
            and command_state.get("resultPending") is True
            and command_state.get("resultVisible") is False
            and command_state.get("resultReviewInteractive") is True
            and command_state.get("commandButtonsEnabled") is True
        ),
        "unitMovesDuringThreeSecondReview": (
            moved_during_review >= 1
            and moving_state.get("postBattleElapsed", 0) >= 0.8
            and moving_state.get("resultPending") is True
            and moving_state.get("resultVisible") is False
            and moving_state.get("resultReviewInteractive") is True
        ),
        "combatClockFrozenAtVictory": (
            abs(
                moving_state.get("elapsed", -1)
                - setup.get("elapsedAtVictory", -2)
            ) < 0.01
            and abs(
                moving_state.get("remaining", -1)
                - setup.get("remainingAtVictory", -2)
            ) < 0.01
        ),
        "resultAppearsAfterAboutThreeSeconds": (
            revealed_state.get("resultPending") is False
            and revealed_state.get("resultVisible") is True
            and revealed_state.get("resultReviewInteractive") is False
            and revealed_state.get("postBattleElapsed", 0) >= 2.9
            and revealed_state.get("actualDelayMs", 0) >= 2800
        ),
        "battlefieldStopsWhenPopupAppears": (
            revealed_state.get("paused") is True
            and revealed_state.get("commandButtonsDisabled") is True
            and moved_after_popup < 0.05
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
        "setup": setup,
        "commandState": command_state,
        "movingState": moving_state,
        "revealedState": revealed_state,
        "movedDuringReview": round(moved_during_review, 3),
        "movedAfterPopup": round(moved_after_popup, 3),
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
    parser.add_argument("--tag", default="v120")
    args = parser.parse_args()
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    sys.exit(main())
