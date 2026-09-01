"""달성 불가 상태에서 전투가 즉시 끝나는지 검증한다.

곡괭이산처럼 한정 탄약(B-2 의 GBU-57)으로만 목표를 깰 수 있는 전투는,
탄을 다 쓰고 목표가 남으면 승리가 불가능하다. 이때 타이머가 끝날 때까지
플레이어를 붙잡아 두면 안 된다. 즉시 실패로 끊고 결과 화면을 띄워야 한다.

영어 화면에 '발' 같은 한국어 수량 단위가 남지 않는지도 함께 본다.

사용:
    python -X utf8 tools/validate-unwinnable-abort.py
    python -X utf8 tools/validate-unwinnable-abort.py --base https://sidak.kr/autodev/GameCreator/hormuz
"""

import argparse
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
KOREAN = re.compile(r"[가-힣]")

# 탄을 다 쓴 상태를 만들고 남은 시간을 재는 스크립트.
EXPEND_JS = """() => {
  const api = window.__HORMUZ_RTS__;
  const battle = api.battle;
  const bombers = battle.units.filter((unit) => (
    unit.team === 'ally' && Number.isFinite(unit.definition.maxShots)
  ));
  bombers.forEach((unit) => { unit.shotsFired = unit.definition.maxShots; });
  battle.projectiles.length = 0;
  return {
    bombers: bombers.length,
    remainingBefore: Math.round(battle.remaining),
    objectiveDestroyed: battle.getObjectiveDestroyedCount(),
    objectiveNeeded: battle.config.battle.objectiveEnemyCount,
    unreachable: battle.objectiveUnreachable()
  };
}"""

TEXT_JS = """() => {
  const skip = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"]);
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { const t = child.textContent.trim(); if (t) out.push(t); continue; }
      if (child.nodeType !== 1 || skip.has(child.tagName)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (child.hasAttribute("hidden")) continue;
      walk(child);
    }
  };
  walk(document.body);
  return out;
}"""


def run(base, lang):
    problems = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(f"{base}/rts-combat.html?scenario=pickaxe_mountain&google=0&lang={lang}",
                  wait_until="load", timeout=90_000)
        for _ in range(60):
            if page.evaluate("() => !!(window.__HORMUZ_RTS__ "
                             "&& window.__HORMUZ_RTS__.getSnapshot().initialized)"):
                break
            page.wait_for_timeout(1000)

        page.evaluate("() => window.__HORMUZ_RTS__.start()")
        page.wait_for_timeout(3000)
        state = page.evaluate(EXPEND_JS)
        print(f"  폭격기 {state['bombers']}기 탄 소진 · 목표 "
              f"{state['objectiveDestroyed']}/{state['objectiveNeeded']} · "
              f"남은 시간 {state['remainingBefore']}초 · 달성불가 판정 {state['unreachable']}")
        if not state["unreachable"]:
            problems.append("탄을 다 썼는데 objectiveUnreachable() 이 false")

        ended_within = None
        for tick in range(15):
            page.wait_for_timeout(1000)
            snapshot = page.evaluate("() => window.__HORMUZ_RTS__.getSnapshot()")
            if snapshot.get("ended"):
                ended_within = tick + 1
                break
        if ended_within is None:
            problems.append("탄 소진 후 15초 안에 전투가 끝나지 않음")
        else:
            print(f"  탄 소진 {ended_within}초 뒤 전투 종료 "
                  f"(타이머 {state['remainingBefore']}초를 기다리지 않음)")

        page.wait_for_timeout(4500)  # 결과 팝업 지연
        texts = page.evaluate(TEXT_JS)
        korean = sorted({t for t in texts if KOREAN.search(t)})
        if lang == "en" and korean:
            problems.append(f"영어 화면에 한국어 잔존: {korean[:6]}")
        shot_unit = [t for t in texts if "발" in t]
        if lang == "en" and shot_unit:
            problems.append(f"영어 화면에 '발' 단위 잔존: {shot_unit[:4]}")
        if errors:
            problems.append(f"브라우저 오류 {errors[:3]}")

        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f"hormuz-unwinnable-abort-{lang}.jpg"),
                        type="jpeg", quality=80)
        result = page.evaluate("""() => {
          const el = document.querySelector('.result-card, .battle-result, [data-testid=result]');
          return el ? el.innerText.slice(0, 220) : null;
        }""")
        if result:
            print("  결과 화면:", " | ".join(result.split("\n")[:4]))
        browser.close()
    return problems


def main():
    parser = argparse.ArgumentParser(description="달성 불가 전투 즉시 종료 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    all_problems = {}
    for lang in ("en", "ko"):
        print(f"[{lang}] 곡괭이산 · 관통탄 소진 시나리오")
        problems = run(args.base.rstrip("/"), lang)
        all_problems[lang] = problems
        print(f"  {'PASS' if not problems else 'FAIL'}")
        for problem in problems:
            print("   ", problem)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hormuz-unwinnable-abort-validation.json").write_text(
        json.dumps({"base": args.base, "problems": all_problems,
                    "allPassed": not any(all_problems.values())},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if any(all_problems.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
