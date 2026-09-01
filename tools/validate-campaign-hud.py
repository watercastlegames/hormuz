"""본편(작전) 화면이 지도를 얼마나 가리는지, HUD 끼리 겹치는지 실측한다.

"너무 가린다"는 겹침만의 문제가 아니다. 겹치지 않아도 HUD 가 화면의 절반을 먹으면
전장이 안 보인다. 그래서 겹침과 함께 **화면 점유율**과 **지도가 온전히 보이는 띠**를 잰다.

세 상태를 각각 잰다. 상태마다 가리는 양이 다르고 고칠 곳도 다르다.
  대기    아무 패널도 없는 기본 상태. 하루 대부분이 이 상태다.
  결과    결정 직후 뜨는 '선택 결과' 패널 (7.6초 뒤 자동으로 사라진다).
  결정    선택지 3개가 뜬 상태. 여기서 못 보는 선택지가 있으면 판단이 왜곡된다.

결정 패널은 슬라이드 애니메이션으로 오르내린다. 애니메이션 도중에 재면 화면 밖으로
나간 것처럼 보이므로, 한 번의 evaluate 안에서 전환을 끄고 열린 상태로 고정해 잰다.

지형은 기본을 로컬로 잡는다. Google 3D 가 붙으면
`.google-terrain-active .map-label { display:none }` 규칙이 도시 지명을 감춰
라벨 겹침을 검사할 수 없다. 로컬 지형이 폴백이자 더 엄격한 조건이다.

사용:
    python -X utf8 tools/validate-campaign-hud.py
    python -X utf8 tools/validate-campaign-hud.py --base https://sidak.kr/autodev/GameCreator/hormuz
    python -X utf8 tools/validate-campaign-hud.py --shots
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"
SHOT_DIR = OUT / "campaign-hud"

VIEWPORTS = [
    (430, 932),   # iPhone 15 Pro Max
    (393, 852),   # iPhone 15
    (360, 800),   # 안드로이드 최빈 폭
    (1440, 900),  # 데스크톱
]
LANGS = ["ko", "en"]

PHONE_MAX_WIDTH = 850   # 이 폭 이하가 폰 규칙을 받는다.

# 합격선은 "HUD 가 몇 %냐" 가 아니라 "지도를 볼 수 있느냐" 로 잡는다.
# 지도가 이 게임의 절반인데, 위아래 띠에 잘려 가운데만 남으면 상황을 읽을 수 없다.
# 그래서 HUD 에 한 번도 걸리지 않는 가로 띠가 화면 높이의 절반 이상이어야 한다.
MAP_BAND_RATIO = 0.55   # 지도가 온전히 보이는 세로 띠 / 화면 높이
IDLE_BUDGET = 30.0      # 그래도 전체 점유가 이 이상이면 답답하다(%)
REPORT_BUDGET = 55.0    # 선택 결과가 떠 있는 7.6초 동안의 상한(%)
# 데스크톱은 패널이 네 귀퉁이에 흩어져 있어 '온전한 띠' 로 재면 실제보다 나쁘게 나온다.
# 대신 전체 점유율로 본다.
DESKTOP_BUDGET = 35.0

# 화면을 실제로 칠하는 것만 센다. 빈 껍데기 레이어는 화면을 가리지 않는다.
MEASURE = """() => {
  const SELECTORS = [
    ['.brand-block', '브랜드'],
    ['#dial-grid', '지표 타일'],
    ['.map-legend', '범례'],
    ['#auto-camera', 'AUTO CAM'],
    ['#campaign-office', '작전·예산'],
    ['.brief-panel', '브리핑'],
    ['.change-feedback', '선택 결과'],
    ['#decision-panel', '결정 패널'],
    ['#modal-layer', '모달'],
    ['.ticker', '속보'],
    ['.developer-fixed-link', '개발자 링크'],
  ];
  const CONTAINERS = new Set(['#modal-layer', '#decision-panel']);
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    if (el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const boxes = [];
  for (const [sel, name] of SELECTORS) {
    const el = document.querySelector(sel);
    if (!el || !shown(el)) continue;
    if (CONTAINERS.has(sel) && el.childElementCount === 0) continue;
    const r = el.getBoundingClientRect();
    // 결정 패널은 닫혀 있으면 화면 밖으로 밀려 있다. 그때는 세지 않는다.
    if (sel === '#decision-panel' && !el.classList.contains('open')) continue;
    boxes.push({
      sel, name,
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  }

  const STEP = 8;
  const cols = Math.ceil(innerWidth / STEP), rows = Math.ceil(innerHeight / STEP);
  const grid = new Uint8Array(cols * rows);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.left / STEP));
    const x1 = Math.min(cols, Math.ceil(b.right / STEP));
    const y0 = Math.max(0, Math.floor(b.top / STEP));
    const y1 = Math.min(rows, Math.ceil(b.bottom / STEP));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) grid[y * cols + x] = 1;
  }
  let covered = 0;
  for (let i = 0; i < grid.length; i += 1) if (grid[i]) covered += 1;

  let best = 0, run = 0;
  for (let y = 0; y < rows; y += 1) {
    let clean = true;
    for (let x = 0; x < cols; x += 1) if (grid[y * cols + x]) { clean = false; break; }
    run = clean ? run + 1 : 0;
    if (run > best) best = run;
  }

  const collisions = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) collisions.push({ a: a.name, b: b.name, overlap: `${x}x${y}px` });
    }
  }

  const labels = [...document.querySelectorAll('#map-labels .map-label')].filter((el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    // 지명은 150ms 페이드로 사라진다. 사라지라고 정해진(inline opacity 0) 라벨은
    // 아직 화면에 옅게 남아 있어도 겹침으로 세지 않는다 — 곧 사라지는 잔상이다.
    // 계산 결과 자체를 보려면 스타일 속성값을 봐야 한다.
    if (el.style.opacity === '0') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim().slice(0, 14),
             left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  const labelHits = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i], b = labels[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) {
        labelHits.push(`${a.text} × ${b.text} ${Math.round(x)}x${Math.round(y)}px`);
      }
    }
  }

  return {
    boxes,
    collisions,
    labelCount: labels.length,
    labelHits,
    coverage: +(covered / grid.length * 100).toFixed(1),
    cleanBandPx: best * STEP,
  };
}"""

# 애니메이션과 경쟁하지 않는다. 한 호출 안에서 전환을 끄고 열어 곧바로 잰다.
FORCE_DECISION = """() => {
  const panel = document.querySelector('#decision-panel');
  if (!panel || panel.childElementCount === 0) return { has: false };
  panel.style.transition = 'none';
  panel.classList.add('open');
  void panel.offsetHeight;
  const pr = panel.getBoundingClientRect();
  const options = [...panel.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const t = document.elementFromPoint(cx, cy);
    return {
      text: (b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24),
      inView: r.top >= -1 && r.bottom <= innerHeight + 1,
      hittable: !!t && (t === b || b.contains(t)),
    };
  });
  return {
    has: true,
    height: Math.round(pr.height),
    coverPct: +(Math.min(pr.height, innerHeight) / innerHeight * 100).toFixed(1),
    scrollHidden: Math.max(0, panel.scrollHeight - panel.clientHeight),
    options,
  };
}"""

STATE = """() => {
  if (!window.__HORMUZ__) return 'booting';
  const title = document.querySelector('#title-screen');
  if (title && !title.classList.contains('hidden')) return 'title';
  const modal = document.querySelector('#modal-layer');
  if (modal && modal.childElementCount > 0) return 'modal';
  const panel = document.querySelector('#decision-panel');
  if (panel && panel.classList.contains('open')) return 'decision';
  const report = document.querySelector('.change-feedback');
  if (report && !report.hidden && report.classList.contains('show')) return 'report';
  return window.__HORMUZ__.state.day > 0 ? 'idle' : 'day0';
}"""


def wait_for_state(page, wanted, tries=260, gap=200):
    for _ in range(tries):
        page.wait_for_timeout(gap)
        try:
            if page.evaluate(STATE) == wanted:
                return True
        except Exception:  # noqa: BLE001 — 화면 전환 중 컨텍스트가 끊기면 다시 본다
            continue
    return False


def wait_idle_settled(page, tries=200, gap=200):
    """대기 상태를 기다린다.

    ★ 지형이 붙기를 함께 기다리면 안 된다. 이 검증은 debug=fast 로 도는데,
      Google 3D 는 붙는 데 9초쯤 걸리고 그 사이 게임은 이미 결정·결과 상태로
      넘어간다. 두 조건이 겹치는 순간이 오지 않아 8케이스 전부 측정 실패했다.
      지형은 기다리지 않고 그 시점의 값을 기록만 한다.
    """
    for _ in range(tries):
        page.wait_for_timeout(gap)
        try:
            if page.evaluate(STATE) != "idle":
                continue
            return page.evaluate(
                "() => document.querySelector('#game').dataset.mapProvider || '(미정)'")
        except Exception:  # noqa: BLE001 — 화면 전환 중 컨텍스트가 끊기면 다시 본다
            continue
    return None


def inspect(browser, base, width, height, lang, shots, google):
    page = browser.new_page(viewport={"width": width, "height": height})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/index.html?debug=fast&autostart=1&prologue=complete"
              f"&startMode=new&timeline=complete&lang={lang}"
              f"&google={'1' if google else '0'}",
              wait_until="load", timeout=120_000)
    page.bring_to_front()

    idle = report = None
    decision = {"has": False}
    terrain = wait_idle_settled(page)
    if terrain:
        page.wait_for_timeout(600)
        idle = page.evaluate(MEASURE)
        # 지명 라벨은 150ms 페이드로 사라진다. 한 번만 재면 사라지는 중인 라벨이
        # 잡혀 실재하지 않는 겹침이 보고된다. 잠시 뒤 다시 재서 양쪽에 다 있는
        # 겹침만 진짜로 센다.
        page.wait_for_timeout(700)
        second = page.evaluate(MEASURE)
        lasting = set(idle["labelHits"]) & set(second["labelHits"])
        idle["labelHitsFirst"] = idle["labelHits"]
        idle["labelHits"] = sorted(lasting)
        if shots:
            SHOT_DIR.mkdir(parents=True, exist_ok=True)
            try:
                page.screenshot(path=str(SHOT_DIR / f"idle-{width}x{height}-{lang}.jpg"),
                                type="jpeg", quality=86, timeout=60_000)
            except Exception:  # noqa: BLE001
                pass
    if wait_for_state(page, "report"):
        report = page.evaluate(MEASURE)
        if shots:
            try:
                page.screenshot(path=str(SHOT_DIR / f"report-{width}x{height}-{lang}.jpg"),
                                type="jpeg", quality=86, timeout=60_000)
            except Exception:  # noqa: BLE001
                pass
    # 결정 패널은 하루 세 번 뜬다. 실제 속도에서는 기다려야 하므로 넉넉히 잡는다.
    for _ in range(600):
        page.wait_for_timeout(250)
        try:
            got = page.evaluate(FORCE_DECISION)
        except Exception:  # noqa: BLE001
            continue
        if got.get("has") and got["options"]:
            decision = got
            if shots:
                try:
                    page.screenshot(
                        path=str(SHOT_DIR / f"decision-{width}x{height}-{lang}.jpg"),
                        type="jpeg", quality=86, timeout=60_000)
                except Exception:  # noqa: BLE001
                    pass
            break
    page.close()

    phone = width <= PHONE_MAX_WIDTH
    problems = []
    if idle is None:
        problems.append("대기 상태 진입 실패")
    else:
        if idle["collisions"]:
            problems.append(f"HUD 겹침 {len(idle['collisions'])}건")
        if idle["labelHits"]:
            problems.append(f"지명 라벨 겹침 {len(idle['labelHits'])}쌍")
        if phone and idle["coverage"] > IDLE_BUDGET:
            problems.append(f"대기 가림 {idle['coverage']}% > {IDLE_BUDGET}%")
        if phone:
            need = round(height * MAP_BAND_RATIO)
            if idle["cleanBandPx"] < need:
                problems.append(f"지도 온전한 띠 {idle['cleanBandPx']}px < {need}px")
        elif idle["coverage"] > DESKTOP_BUDGET:
            problems.append(f"대기 가림 {idle['coverage']}% > {DESKTOP_BUDGET}%")
    if report and phone and report["coverage"] > REPORT_BUDGET:
        problems.append(f"결과 패널 가림 {report['coverage']}% > {REPORT_BUDGET}%")
    if not decision.get("has"):
        problems.append("결정 패널 확인 실패")
    else:
        unseen = [o for o in decision["options"] if not o["inView"]]
        if unseen:
            problems.append(f"스크롤해야 보이는 선택지 {len(unseen)}/{len(decision['options'])}")
    if errors:
        problems.append(f"페이지 오류 {len(errors)}건")

    return {
        "viewport": f"{width}x{height}", "lang": lang, "phone": phone,
        "terrain": terrain,
        "idle": idle, "report": report, "decision": decision,
        "errors": errors[:5], "problems": problems, "passed": not problems,
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
                idle = case["idle"] or {}
                dec = case["decision"]
                rep = case["report"] or {}
                mark = "PASS" if case["passed"] else "FAIL"
                print(f"  [{mark}] {case['viewport']:>9s} {lang}"
                      f" · 대기 가림 {idle.get('coverage', '?')}%"
                      f" · 지도 띠 {idle.get('cleanBandPx', '?')}px"
                      f" · 결과 가림 {rep.get('coverage', '-')}%"
                      f" · 결정 {dec.get('coverPct', '-')}%"
                      f" · 라벨겹침 {len(idle.get('labelHits', []))}")
                for problem in case["problems"]:
                    print(f"          {problem}")
        browser.close()
    return cases


def main():
    parser = argparse.ArgumentParser(description="본편 작전 화면 HUD 가림·겹침 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--shots", action="store_true")
    parser.add_argument("--google", default="0", choices=["0", "1"],
                        help="Google 3D 지형을 붙여 잰다. 기본은 로컬 지형 — "
                             "Google 지형은 지명 라벨을 CSS 로 감추므로 라벨 겹침을 "
                             "검사하려면 로컬이어야 한다")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    google = args.google == "1"
    print(f"본편 작전 화면 HUD 검증 ({args.base}) 지형={'Google 3D' if google else '로컬'}")
    cases = run(args.base.rstrip("/"), args.shots, google)
    OUT.mkdir(parents=True, exist_ok=True)
    passed = all(case["passed"] for case in cases)
    name = "hormuz-campaign-hud-validation" + ("" if google else "-local") + ".json"
    (OUT / name).write_text(
        json.dumps({"base": args.base, "terrain": "google3d" if google else "local",
                    "cases": cases, "allPassed": passed},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("결과:", "PASS" if passed else "FAIL",
          f"({sum(1 for c in cases if c['passed'])}/{len(cases)})")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
