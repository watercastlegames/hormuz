"""좁은 폰 폭에서 전투 HUD 가 서로 겹치거나 잘리지 않는지 실측으로 검증한다.

눈으로 보면 "좀 좁네" 로 넘어가지만, 실제로는 전술 지형 패널이 목표 문구를 덮어
무엇을 해야 하는지 읽을 수 없는 상태였다. 그래서 겹침을 픽셀로 잰다.

검사 항목
  1. 보이는 HUD 상자끼리 서로 겹치지 않는다 (헤더 자식 · 좌우 패널 · 선택 패널 · 명령바).
  2. 모든 HUD 상자가 뷰포트 안에 들어온다.
  3. 아군 목록(.force-panel)의 내용이 잘리지 않는다 (scrollHeight <= clientHeight).
     단 화면 높이가 700px 미만이면 스크롤을 허용한다. 헤더와 명령바만으로 세로가
     차버려 4기 전부를 담을 방법이 없는 화면이라, 잘림이 아니라 스크롤이 정답이다.
  4. 유닛 이름표가 화면 밖으로 잘리지 않는다.
한국어·영어 두 언어 모두 잰다. 영문 문구가 더 길어 한국어에서 통과해도 영어에서 깨진다.

지형은 두 갈래다. Google 3D 가 붙으면 배지 문구가 "GOOGLE 3D 실제 전투 지형" 으로
로컬("로컬 전술 지형")보다 길어져 배지가 커진다. 배지 높이는 아래 패널 위치를 정하므로
로컬만 재고 끝내면 실제 서비스 상태를 검증하지 못한다. --google 로 둘 다 돌린다.

사용:
    python -X utf8 tools/validate-hud-narrow.py
    python -X utf8 tools/validate-hud-narrow.py --google 1
    python -X utf8 tools/validate-hud-narrow.py --base https://sidak.kr/autodev/GameCreator/hormuz
    python -X utf8 tools/validate-hud-narrow.py --shots
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
SHOT_DIR = OUT / "hud-narrow"

# 세로로 잡는 폰 폭. 320 은 현역 최소폭(iPhone SE 1세대)이라 가장 먼저 깨진다.
VIEWPORTS = [
    (430, 932),   # iPhone 15 Pro Max
    (412, 915),   # Pixel 7
    (393, 852),   # iPhone 15
    (360, 800),   # Galaxy A 계열 — 안드로이드 최빈값
    (320, 568),   # iPhone SE 1세대 — 최소폭
    (1080, 1920),  # 세로 영상 촬영 규격
    # 눕힌 폰. 미디어 쿼리 두 개가 서로 배타라 어느 조정도 못 받던 구간이다.
    (844, 390),
    (667, 375),
    # 데스크톱 회귀 감시. 기본 규칙을 건드렸으니 좁은 폭만 보고 끝내면 안 된다.
    (1920, 1080),
    (1440, 900),
    (1280, 800),
    (1024, 768),
    (900, 600),   # 미디어 쿼리 701~1000px 구간 — 위치 상수를 물려받던 사각지대
]

# 이 높이 아래에서는 아군 목록을 다 담을 세로가 물리적으로 없다. 스크롤을 인정한다.
SCROLL_ALLOWED_BELOW = 700

LANGS = ["ko", "en"]

# 겹치면 안 되는 HUD 상자. 서로 부모-자식이 아니어야 한다.
BOXES = """() => {
  const SELECTORS = [
    ['.brand-block', 'brand'],
    ['.objective-block', 'objective'],
    ['.battle-clock', 'clock'],
    ['.force-panel', 'force'],
    ['.intel-panel', 'intel'],
    ['.selection-panel', 'selection'],
    ['.command-bar', 'command'],
    ['#command-hint', 'hint'],
    ['#terrain-provider', 'terrain'],
    ['#mission-cue', 'cue'],
  ];
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) < 0.05) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const boxes = [];
  for (const [selector, name] of SELECTORS) {
    const el = document.querySelector(selector);
    if (!el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    boxes.push({
      name,
      left: +r.left.toFixed(1), top: +r.top.toFixed(1),
      right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1),
    });
  }
  const force = document.querySelector('.force-panel');
  const labels = [...document.querySelectorAll('.unit-label')]
    .filter((el) => parseFloat(getComputedStyle(el).opacity) > 0.05)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent.trim().slice(0, 24),
        left: +r.left.toFixed(1), top: +r.top.toFixed(1),
        right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      };
    });
  const header = document.querySelector('.battle-header');
  return {
    viewport: { width: innerWidth, height: innerHeight },
    boxes,
    labels,
    headerHeight: header ? +header.getBoundingClientRect().height.toFixed(1) : 0,
    hudTop: getComputedStyle(document.documentElement).getPropertyValue('--hud-top').trim()
            || getComputedStyle(document.getElementById('rts-game'))
               .getPropertyValue('--hud-top').trim(),
    force: force ? {
      scrollHeight: force.scrollHeight,
      clientHeight: force.clientHeight,
    } : null,
  };
}"""

TOLERANCE = 1.0  # 소수점 반올림 오차만 허용한다.


def overlaps(a, b):
    """두 상자가 겹치는 가로·세로 px. 안 겹치면 None."""
    x = min(a["right"], b["right"]) - max(a["left"], b["left"])
    y = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
    if x > TOLERANCE and y > TOLERANCE:
        return round(x, 1), round(y, 1)
    return None


def wait_battle_ready(page):
    for _ in range(60):
        if page.evaluate("() => !!(window.__HORMUZ_RTS__ "
                         "&& window.__HORMUZ_RTS__.getSnapshot().initialized)"):
            return True
        page.wait_for_timeout(1000)
    return False


def wait_terrain_settled(page):
    """Google 3D 는 늦게 붙는다. 붙기 전에 재면 배지가 '연결 중' 문구라 폭이 다르다."""
    for _ in range(20):
        state = page.evaluate(
            "() => document.getElementById('rts-game').dataset.googleBattleMapStatus || ''")
        if state in ("ready", "fallback", "disabled", "error"):
            return state
        page.wait_for_timeout(1000)
    return "timeout"


def inspect(browser, base, width, height, lang, shots, google):
    page = browser.new_page(viewport={"width": width, "height": height})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/rts-combat.html?scenario=convoy_shield&lang={lang}"
              f"&google={'1' if google else '0'}&hud=1",
              wait_until="load", timeout=90_000)
    ready = wait_battle_ready(page)
    if ready:
        page.evaluate("() => window.__HORMUZ_RTS__.start()")
        # 배경 탭은 requestAnimationFrame 이 멈춰 이름표 좌표가 갱신되지 않는다.
        # 앞으로 올려 실제 화면과 같은 조건에서 잰다.
        page.bring_to_front()
        if google:
            wait_terrain_settled(page)
        page.wait_for_timeout(3500)
    data = page.evaluate(BOXES)
    if shots:
        SHOT_DIR.mkdir(parents=True, exist_ok=True)
        # 스크린샷은 증거일 뿐 판정 근거가 아니다. 소프트웨어 렌더러가 한 번씩
        # 늦어 실패하는데, 그때문에 측정 결과까지 버리지 않는다.
        suffix = "-g3d" if google else ""
        try:
            page.screenshot(path=str(SHOT_DIR / f"{width}x{height}-{lang}{suffix}.jpg"),
                            type="jpeg", quality=86, timeout=60_000)
        except Exception as error:  # noqa: BLE001
            print(f"        (스크린샷 실패, 측정은 유효: {type(error).__name__})")
    page.close()

    boxes = data["boxes"]
    collisions = []
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            hit = overlaps(a, b)
            if hit:
                collisions.append({"a": a["name"], "b": b["name"],
                                   "overlap": f"{hit[0]}x{hit[1]}px"})

    offscreen = []
    for box in boxes:
        for side, value, limit in (
            ("left", box["left"], 0), ("top", box["top"], 0),
            ("right", box["right"], width), ("bottom", box["bottom"], height),
        ):
            out = (limit - value) if side in ("left", "top") else (value - limit)
            if out > TOLERANCE:
                offscreen.append({"element": box["name"], "side": side,
                                  "px": round(out, 1)})

    clipped = []
    for label in data["labels"]:
        out = max(-label["left"], label["right"] - width,
                  -label["top"], label["bottom"] - height)
        if out > TOLERANCE:
            clipped.append({"text": label["text"], "px": round(out, 1)})

    force = data["force"] or {"scrollHeight": 0, "clientHeight": 0}
    hidden = max(0, force["scrollHeight"] - force["clientHeight"])
    hidden_allowed = height < SCROLL_ALLOWED_BELOW

    passed = (ready and not collisions and not offscreen and not clipped
              and (hidden <= TOLERANCE or hidden_allowed) and not errors)
    return {
        "viewport": f"{width}x{height}", "lang": lang,
        "terrain": "google3d" if google else "local", "ready": ready,
        "headerHeight": data["headerHeight"], "hudTop": data["hudTop"],
        "collisions": collisions, "offscreen": offscreen,
        "clippedLabels": clipped, "labelCount": len(data["labels"]),
        "forceHiddenPx": hidden, "forceScrollAllowed": hidden_allowed,
        "errors": errors[:5], "passed": passed,
    }


def run(base, shots, google):
    cases = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        for width, height in VIEWPORTS:
            for lang in LANGS:
                case = inspect(browser, base, width, height, lang, shots, google)
                cases.append(case)
                mark = "PASS" if case["passed"] else "FAIL"
                print(f"  [{mark}] {case['viewport']:>9s} {lang} "
                      f"· 헤더 {case['headerHeight']:>5.1f}px "
                      f"· 겹침 {len(case['collisions'])} "
                      f"· 화면밖 {len(case['offscreen'])} "
                      f"· 이름표잘림 {len(case['clippedLabels'])}/{case['labelCount']} "
                      f"· 아군목록 가려짐 {case['forceHiddenPx']}px"
                      f"{' (스크롤 허용)' if case['forceScrollAllowed'] else ''}")
                for hit in case["collisions"]:
                    print(f"          겹침 {hit['a']} × {hit['b']} → {hit['overlap']}")
                for out in case["offscreen"]:
                    print(f"          화면밖 {out['element']} {out['side']} {out['px']}px")
        browser.close()
    return cases


def main():
    parser = argparse.ArgumentParser(description="좁은 폰 폭 전투 HUD 겹침·잘림 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--shots", action="store_true", help="뷰포트별 스크린샷 저장")
    parser.add_argument("--google", default="0", choices=["0", "1"],
                        help="Google 3D 지형을 붙인 상태로 잰다 (기본 0=로컬 지형)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    google = args.google == "1"
    print(f"좁은 폰 폭 HUD 검증 ({args.base}) 지형={'Google 3D' if google else '로컬'}")
    cases = run(args.base.rstrip("/"), args.shots, google)
    OUT.mkdir(parents=True, exist_ok=True)
    passed = all(case["passed"] for case in cases)
    name = "hormuz-hud-narrow-validation" + ("-g3d" if google else "") + ".json"
    (OUT / name).write_text(
        json.dumps({"base": args.base, "terrain": "google3d" if google else "local",
                    "cases": cases, "allPassed": passed},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("결과:", "PASS" if passed else "FAIL",
          f"({sum(1 for c in cases if c['passed'])}/{len(cases)})")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
