#!/usr/bin/env python3
"""Validate HORMUZ safe checkpoints, title summary, and resume boundaries."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "validation"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="v129")
    parser.add_argument("--url", default="http://127.0.0.1:8080/index.html")
    return parser.parse_args()


def validate_ui(browser, url: str, tag: str) -> dict:
    context = browser.new_context(viewport={"width": 1600, "height": 900})
    page = context.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector("#start-game:not([disabled])", timeout=15_000)
    page.click("#start-game")
    page.wait_for_selector('#replay-screen [data-replay="2"]', timeout=15_000)
    page.click('#replay-screen [data-replay="2"]')
    page.wait_for_selector("#next-history", timeout=15_000)
    page.click("#next-history")
    page.wait_for_selector("#replay-screen h2", timeout=15_000)
    next_event_before_reload = page.locator("#replay-screen h2").inner_text()

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#continue-game:not([hidden]):not([disabled])", timeout=15_000)
    summary_text = page.locator("#save-summary").inner_text()
    continue_text = page.locator("#continue-game").inner_text()
    desktop_path = OUTPUT / f"hormuz-{tag}-save-resume-desktop-1600x900.png"
    page.screenshot(path=str(desktop_path), full_page=False)

    dialogs: list[str] = []

    def dismiss(dialog) -> None:
        dialogs.append(dialog.message)
        dialog.dismiss()

    page.once("dialog", dismiss)
    page.click("#start-game")
    page.wait_for_timeout(250)
    new_game_cancel_kept_save = not page.locator("#title-screen").evaluate(
        "element => element.classList.contains('hidden')"
    )
    page.click("#continue-game")
    page.wait_for_selector("#replay-screen h2", timeout=15_000)
    resumed_event = page.locator("#replay-screen h2").inner_text()

    page.goto(url, wait_until="domcontentloaded")
    page.set_viewport_size({"width": 430, "height": 932})
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#continue-game:not([hidden]):not([disabled])", timeout=15_000)
    mobile_path = OUTPUT / f"hormuz-{tag}-save-resume-mobile-430x932.png"
    page.screenshot(path=str(mobile_path), full_page=False)
    mobile_scroll = page.evaluate(
        "({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight })"
    )

    assert "해협 봉쇄와 유가 급등" in next_event_before_reload
    assert all(
        label in summary_text
        for label in ("통항", "유가", "국민 지지", "국제 지지", "탄약", "확전", "가용 예산", "여당 지지")
    )
    assert "마지막 선택부터 계속" in continue_text
    assert dialogs and new_game_cancel_kept_save
    assert "해협 봉쇄와 유가 급등" in resumed_event
    assert mobile_scroll["documentHeight"] <= mobile_scroll["viewportHeight"]
    assert not page_errors
    context.close()
    return {
        "nextEventBeforeReload": next_event_before_reload,
        "continueButton": continue_text.replace("\n", " · "),
        "resumedEvent": resumed_event,
        "newGameCancelKeptSave": new_game_cancel_kept_save,
        "mobileScroll": mobile_scroll,
        "pageErrors": page_errors,
        "screenshots": [str(desktop_path), str(mobile_path)],
    }


def validate_state_roundtrip(browser, url: str) -> dict:
    context = browser.new_context()
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    result = page.evaluate(
        """async () => {
          const mod = await import("./assets/js/core/state.js");
          mod.resetGame();
          mod.update((state) => {
            state.phase = "DAY_POLICY";
            state.day = 7;
            state.act = "ATTRITION";
            Object.assign(state.dials, {
              transit: 63, oil: 117, approval: 52, intl: 68, ammo: 31, esc: 4
            });
            Object.assign(state.politics, {
              authorizedBudget: 7400, spentBudget: 2150,
              partySupport: 46, congressSupport: 51
            });
            state.replay.choices = ["a", "b", "c"];
            state.flags.history = Array.from({ length: 75 }, (_, index) => `choice_${index + 1}`);
            state.flags.revealed = true;
            state.log = ["저장 검증용 최종 선택"];
            state.resume = {
              stage: "policy_execute",
              day: 7,
              replayIndex: 3,
              policy: {
                id: "saved_policy",
                name: "저장된 정책",
                desc: "복원 검증",
                delta: { transit: 4, ammo: -2 },
                mission: "intercept",
                fx: "missile"
              },
              eventId: ""
            };
          });
          mod.saveCheckpoint("DAY 7 선택 확정 · 저장된 정책");
          mod.update((state) => {
            state.day = 1;
            Object.assign(state.dials, {
              transit: 1, oil: 300, approval: 1, intl: 1, ammo: 1, esc: 1
            });
            state.politics.spentBudget = 7000;
            state.resume = {
              stage: "brief", day: 1, replayIndex: 0, policy: null, eventId: ""
            };
          });
          const restored = mod.restoreLocalProgress();
          const snapshot = {
            restored,
            day: mod.state.day,
            phase: mod.state.phase,
            stage: mod.state.resume.stage,
            policyId: mod.state.resume.policy?.id,
            dials: { ...mod.state.dials },
            availableBudget: mod.state.politics.authorizedBudget - mod.state.politics.spentBudget,
            partySupport: mod.state.politics.partySupport,
            choices: [...mod.state.replay.choices],
            historyLength: mod.state.flags.history.length,
            revealed: mod.state.flags.revealed,
            summary: mod.getSavedRunSummary()
          };
          mod.resetGame();
          snapshot.resetCleared = !mod.hasSavedRun();
          return snapshot;
        }"""
    )
    assert result["restored"]
    assert result["day"] == 7 and result["stage"] == "policy_execute"
    assert result["policyId"] == "saved_policy"
    assert result["dials"] == {
        "transit": 63,
        "oil": 117,
        "approval": 52,
        "intl": 68,
        "ammo": 31,
        "esc": 4,
    }
    assert result["availableBudget"] == 5250
    assert result["partySupport"] == 46
    assert result["choices"] == ["a", "b", "c"]
    assert result["historyLength"] == 75 and result["revealed"]
    assert result["resetCleared"]
    context.close()
    return result


def validate_legacy_and_boundaries(browser, url: str) -> dict:
    context = browser.new_context()
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    result = page.evaluate(
        """async () => {
          const stateModule = await import("./assets/js/core/state.js");
          const directorModule = await import("./assets/js/core/director.js");
          const [cards, events, endings, missions, campaign] = await Promise.all(
            ["cards", "events", "endings", "missions", "campaign"].map((name) =>
              fetch(`./assets/data/${name}.json`).then((response) => response.json())
            )
          );
          const ui = {
            auto: true,
            render() {},
            setBrief() {},
            pushTicker() {},
            showCinematicBriefing: async () => {},
            choose: async ({ options }) => options[0],
            sleep: async () => {},
            showDayReport: async () => {},
            showMissionResult: async () => {},
            showEnding: async () => null,
            cancelPending() {}
          };
          const scene = { setDay() {}, playPreset() {} };

          stateModule.resetGame();
          stateModule.update((state) => {
            state.version = 1;
            state.phase = "MISSION";
            state.day = 5;
            Object.assign(state.dials, {
              transit: 72, oil: 101, approval: 49, intl: 61, ammo: 27, esc: 4
            });
            Object.assign(state.politics, {
              authorizedBudget: 6800, spentBudget: 1700, partySupport: 44
            });
            state.resume = null;
          });
          const legacyRestored = stateModule.restoreLocalProgress();
          const legacy = {
            restored: legacyRestored,
            phase: stateModule.state.phase,
            stage: stateModule.state.resume.stage,
            day: stateModule.state.day,
            transit: stateModule.state.dials.transit,
            availableBudget:
              stateModule.state.politics.authorizedBudget - stateModule.state.politics.spentBudget,
            partySupport: stateModule.state.politics.partySupport
          };

          stateModule.resetGame();
          stateModule.update((state) => {
            state.day = 4;
            state.phase = "DAY_RESOLVE";
            state.dials.ammo = 40;
            state.resume = {
              stage: "report", day: 4, replayIndex: 0, policy: null, eventId: ""
            };
          });
          stateModule.saveCheckpoint("DAY 4 일일 결산 완료");
          let director = new directorModule.GameDirector({
            state: stateModule.state,
            update: stateModule.update,
            cards, events, endings, missions, campaign, ui, scene, fast: true
          });
          director.runToken = 1;
          await director.runDay(1);
          const reportBoundary = {
            day: stateModule.state.day,
            stage: stateModule.state.resume.stage,
            ammo: stateModule.state.dials.ammo
          };

          stateModule.resetGame();
          const policy = {
            id: "resume_policy",
            name: "이어하기 정책",
            desc: "한 번만 반영",
            delta: { transit: 4, approval: 2 },
            flag: "guarantee",
            mission: "",
            negotiation: false,
            fx: "diplomacy"
          };
          stateModule.update((state) => {
            state.day = 2;
            state.phase = "DAY_POLICY";
            state.resume = {
              stage: "policy_execute", day: 2, replayIndex: 0, policy, eventId: ""
            };
          });
          stateModule.saveCheckpoint("DAY 2 선택 확정");
          stateModule.update((state) => {
            state.dials.transit += 4;
            state.flags.history.push("resume_policy");
            state.phase = "DAY_EXEC";
          });
          stateModule.restoreLocalProgress();
          const transitBefore = stateModule.state.dials.transit;
          director = new directorModule.GameDirector({
            state: stateModule.state,
            update: stateModule.update,
            cards, events, endings, missions, campaign, ui, scene, fast: true
          });
          director.runToken = 1;
          await director.runDay(1);
          const policyBoundary = {
            transitBefore,
            day: stateModule.state.day,
            stage: stateModule.state.resume.stage,
            policyCount: stateModule.state.flags.history.filter(
              (item) => item === "resume_policy"
            ).length
          };
          await director.end(endings[0].id);
          const endingClearedContinue = !stateModule.hasSavedRun();
          stateModule.resetGame();
          return { legacy, reportBoundary, policyBoundary, endingClearedContinue };
        }"""
    )
    legacy = result["legacy"]
    assert legacy == {
        "restored": True,
        "phase": "DAY_BRIEF",
        "stage": "brief",
        "day": 5,
        "transit": 72,
        "availableBudget": 5100,
        "partySupport": 44,
    }
    assert result["reportBoundary"] == {"day": 5, "stage": "brief", "ammo": 40}
    assert result["policyBoundary"]["transitBefore"] == 30
    assert result["policyBoundary"]["day"] == 3
    assert result["policyBoundary"]["stage"] == "brief"
    assert result["policyBoundary"]["policyCount"] == 1
    assert result["endingClearedContinue"]
    context.close()
    return result


def main() -> int:
    args = parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        report = {
            "version": 1,
            "tag": args.tag,
            "url": args.url,
            "ui": validate_ui(browser, args.url, args.tag),
            "stateRoundtrip": validate_state_roundtrip(browser, args.url),
            "boundaries": validate_legacy_and_boundaries(browser, args.url),
        }
        browser.close()
    report["passed"] = True
    output_path = OUTPUT / f"hormuz-{args.tag}-save-resume-validation.json"
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("저장·이어하기 검증 통과")
    print(f"기록: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
