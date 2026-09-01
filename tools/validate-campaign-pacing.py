"""HORMUZ 장기전 진행 구조와 대통령 발언 연출 검증.

사용:
    python -X utf8 tools/validate-campaign-pacing.py --tag v132
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def run(base: str, tag: str) -> bool:
    OUT.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []
    http_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
        ])
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.on("console", lambda message: console_errors.append(message.text)
                if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: http_errors.append(
            f"{response.status} {response.url}"
        ) if response.status >= 400 else None)

        url = (
            f"{base}/index.html?autostart=1&startMode=new&debug=fast"
            f"&mapcheck=1&google=0&pacingqa={tag}"
        )
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function(
            "() => !!(window.__HORMUZ__ && window.__HORMUZ__.director)",
            timeout=60_000,
        )
        profile = page.evaluate("""() => {
          const { director, data } = window.__HORMUZ__;
          const diplomacyIndex = director.dailyDecisionTracks.findIndex((track) => track.id === 'diplomacy');
          const channel = data.cards.find((card) => card.id === 'open_channel');
          const minimumChoiceCount = data.timeline.length
            + (director.minimumSuccessDay - 1) * director.dailyDecisionTracks.length
            + diplomacyIndex + 1
            + 4;
          return {
            runtime: document.querySelector('#game')?.dataset.runtimeVersion || null,
            minimumSuccessDay: director.minimumSuccessDay,
            maximumCampaignDay: director.maxCampaignDay,
            dailyDecisionTracks: director.dailyDecisionTracks,
            timelineChoices: data.timeline.length,
            diplomacyTrackIndex: diplomacyIndex,
            negotiationClauseChoices: 4,
            minimumSuccessfulChoiceCount: minimumChoiceCount,
            openChannelDayMin: channel?.unlock?.dayMin || null,
            statementCount: data.president_statements?.statements?.length || 0,
            statementSourcesComplete: (data.president_statements?.statements || []).every((item) =>
              item.lineKo && item.contextKo && item.sourceDate && item.sourceUrl
            ),
            titleLead: document.querySelector('.title-lead')?.textContent?.trim() || ''
          };
        }""")

        page.evaluate("""() => {
          const { director, data } = window.__HORMUZ__;
          const statements = data.president_statements.statements;
          document.documentElement.classList.remove('map-check');
          director.ui.auto = false;
          void director.ui.showPresidentStatement({
            day: 5,
            statement: statements[4],
            previous: statements[3]
          });
        }""")
        page.locator(".president-statement-modal").wait_for(state="visible", timeout=10_000)
        visual = page.evaluate("""() => ({
          bubble: document.querySelector('.president-speech-bubble')?.textContent?.trim() || '',
          previous: document.querySelector('.president-statement-copy aside q')?.textContent?.trim() || '',
          disclaimer: document.querySelector('.president-statement-copy small')?.textContent?.trim() || '',
          image: document.querySelector('.president-statement-visual img')?.getAttribute('src') || '',
          imageAlt: document.querySelector('.president-statement-visual img')?.getAttribute('alt') || '',
          button: document.querySelector('#confirm-president-statement')?.textContent?.trim() || ''
        })""")
        screenshot = OUT / f"hormuz-{tag}-president-statement-1600x900.png"
        page.screenshot(
            path=str(screenshot),
            full_page=True,
            animations="disabled",
            timeout=60_000,
        )
        browser.close()

    verdict = {
        "runtime132": profile["runtime"] == "143",
        "threeDailyDecisions": len(profile["dailyDecisionTracks"]) == 3,
        "successLockedUntilDay12": profile["minimumSuccessDay"] >= 12,
        "campaignExtendedToDay54": profile["maximumCampaignDay"] >= 54,
        "minimumSuccessfulChoicesTripled": profile["minimumSuccessfulChoiceCount"] >= 42,
        "openChannelLocked": profile["openChannelDayMin"] >= 12,
        "presidentStatementsLoaded": profile["statementCount"] >= 8,
        "statementSourcesComplete": profile["statementSourcesComplete"],
        "rearViewOnly": "president-rear" in visual["image"] and "뒷모습" in visual["imageAlt"],
        "speechBubbleVisible": bool(visual["bubble"]),
        "previousMessageVisible": bool(visual["previous"]),
        "adaptationNoticeVisible": "재구성" in visual["disclaimer"],
        "noBrowserErrors": not console_errors and not page_errors and not http_errors,
    }
    passed = all(verdict.values())
    record = {
        "profile": profile,
        "visual": visual,
        "verdict": verdict,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "httpErrors": http_errors,
        "screenshot": str(screenshot),
        "passed": passed,
    }
    output = OUT / f"hormuz-{tag}-campaign-pacing-validation.json"
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"최소 성공 DAY: {profile['minimumSuccessDay']}")
    print(f"최대 캠페인 DAY: {profile['maximumCampaignDay']}")
    print(f"하루 결정 단계: {len(profile['dailyDecisionTracks'])}")
    print(f"최단 성공 선택 수: {profile['minimumSuccessfulChoiceCount']}")
    print(f"대통령 발언: {profile['statementCount']}개")
    print(f"브라우저 오류: {len(console_errors) + len(page_errors) + len(http_errors)}")
    print(f"결과: {'PASS' if passed else 'FAIL'}")
    print(output)
    return passed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v132")
    args = parser.parse_args()
    return 0 if run(args.base.rstrip("/"), args.tag) else 1


if __name__ == "__main__":
    sys.exit(main())
