"""좌상단 HORMUZ 를 눌러 시작 화면으로 돌아가는지 검증한다.

★ 반드시 실제 마우스 클릭으로 확인한다.
   HUD(.top-hud / .battle-header)는 전장 조작을 가리지 않으려 pointer-events:none 이다.
   버튼만 auto 로 되돌리지 않으면 클릭이 캔버스로 통과해 아무 일도 일어나지 않는데,
   element.click() 같은 합성 클릭은 이 통과를 감지하지 못하고 통과로 오판한다.

사용:
    python -X utf8 tools/validate-brand-home.py
    python -X utf8 tools/validate-brand-home.py --base https://sidak.kr/autodev/GameCreator/hormuz
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"

HIT_TEST_JS = """() => {
  const brand = document.querySelector('#brand-home');
  if (!brand) return { exists: false };
  const rect = brand.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    exists: true,
    center: [Math.round(cx), Math.round(cy)],
    hittable: top === brand || brand.contains(top),
    blockedBy: (top === brand || brand.contains(top))
      ? null : `${top ? top.tagName : 'null'}#${top && top.id ? top.id : ''}`,
    pointerEvents: getComputedStyle(brand).pointerEvents,
    cursor: getComputedStyle(brand).cursor,
    label: brand.getAttribute('aria-label'),
    text: brand.textContent.trim(),
  };
}"""


def wait_battle_ready(page):
    for _ in range(60):
        if page.evaluate("() => !!(window.__HORMUZ_RTS__ "
                         "&& window.__HORMUZ_RTS__.getSnapshot().initialized)"):
            return True
        page.wait_for_timeout(1000)
    return False


def wait_campaign_running(page):
    for _ in range(40):
        page.wait_for_timeout(1000)
        if page.evaluate("() => !!(window.__HORMUZ__ && window.__HORMUZ__.state.day > 0)"):
            return True
    return False


def run(base):
    results = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])

        # 1. 본편 진행 중 — 취소하면 잔류, 확인하면 시작 화면 (언어 유지)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/index.html?debug=fast&autostart=1&startMode=new&google=0&lang=en",
                  wait_until="load", timeout=90_000)
        running = wait_campaign_running(page)
        hit = page.evaluate(HIT_TEST_JS)

        page.once("dialog", lambda dialog: dialog.dismiss())
        page.mouse.click(hit["center"][0], hit["center"][1])
        page.wait_for_timeout(2500)
        stayed = page.evaluate("() => !!(window.__HORMUZ__ && window.__HORMUZ__.state.day > 0)")

        page.once("dialog", lambda dialog: dialog.accept())
        page.mouse.click(hit["center"][0], hit["center"][1])
        page.wait_for_timeout(6000)
        title_shown = page.evaluate(
            "() => !document.querySelector('#title-screen').classList.contains('hidden')")
        kept_lang = "lang=en" in page.url
        results["main_running"] = {
            "running": running, "hitTest": hit, "stayedOnCancel": stayed,
            "titleShown": title_shown, "keptLang": kept_lang, "url": page.url,
            "errors": errors[:5],
            "passed": running and hit.get("hittable") and stayed and title_shown
                      and kept_lang and not errors,
        }
        print(f"  [{'PASS' if results['main_running']['passed'] else 'FAIL'}] 본편 진행 중")
        print(f"        실제 클릭 도달 {hit.get('hittable')} "
              f"(막은 요소 {hit.get('blockedBy')}) · pointer-events {hit.get('pointerEvents')}")
        print(f"        취소 잔류 {stayed} · 시작 화면 복귀 {title_shown} · 언어 유지 {kept_lang}")
        page.close()

        # 2. 전투 중 — 취소하면 잔류, 확인하면 본편 시작 화면 (언어 유지)
        #    편성·결과 오버레이가 떠 있을 때는 헤더가 흐려져 조작 대상이 아니다.
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/rts-combat.html?scenario=convoy_shield&google=0&lang=en",
                  wait_until="load", timeout=90_000)
        ready = wait_battle_ready(page)
        page.evaluate("() => window.__HORMUZ_RTS__.start()")
        page.wait_for_timeout(3000)
        hit = page.evaluate(HIT_TEST_JS)

        page.once("dialog", lambda dialog: dialog.dismiss())
        page.mouse.click(hit["center"][0], hit["center"][1])
        page.wait_for_timeout(2500)
        stayed = "rts-combat.html" in page.url

        page.once("dialog", lambda dialog: dialog.accept())
        page.mouse.click(hit["center"][0], hit["center"][1])
        page.wait_for_url("**/index.html*", timeout=30_000)
        landed = page.url
        kept_lang = "lang=en" in landed
        results["battle_running"] = {
            "ready": ready, "hitTest": hit, "stayedOnCancel": stayed,
            "url": landed, "keptLang": kept_lang, "errors": errors[:5],
            "passed": ready and hit.get("hittable") and stayed
                      and "index.html" in landed and kept_lang and not errors,
        }
        print(f"  [{'PASS' if results['battle_running']['passed'] else 'FAIL'}] 전투 중")
        print(f"        실제 클릭 도달 {hit.get('hittable')} "
              f"(막은 요소 {hit.get('blockedBy')}) · pointer-events {hit.get('pointerEvents')}")
        print(f"        취소 잔류 {stayed} · 본편 이동 {'index.html' in landed} "
              f"· 언어 유지 {kept_lang}")
        page.close()
        browser.close()
    return results


def main():
    parser = argparse.ArgumentParser(description="좌상단 HORMUZ 홈 복귀 검증 (실제 클릭)")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    print(f"좌상단 HORMUZ → 시작 화면 ({args.base})")
    results = run(args.base.rstrip("/"))
    OUT.mkdir(parents=True, exist_ok=True)
    passed = all(item["passed"] for item in results.values())
    (OUT / "hormuz-brand-home-validation.json").write_text(
        json.dumps({"base": args.base, "cases": results, "allPassed": passed},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("결과:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
