"""전체 캠페인 자동 주행 검사 (한/영).

사용: python -X utf8 tools/validate-campaign-fullrun.py

debug=fast 자동 모드로 과거 사건 → 본편 → 종결까지 실제로 플레이하고,
영어 주행에서는 매 샘플마다 화면의 잔여 한글을, 두 언어 모두에서
콘솔 오류·HTTP 오류·게임 멈춤을 잡는다.
"""
import json
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8080"
OUT = "D:/soccerstarWebSource/GameCreator/hormuz/output/validation"
KOREAN = re.compile(r"[가-힣]")
ALLOWED = {"한국어"}

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

STATE_JS = """() => {
  const h = window.__HORMUZ__;
  if (!h) return null;
  return {
    day: h.state.day, phase: h.state.phase, act: h.state.act,
    ended: h.state.ended ? { id: h.state.ended.endingId || h.state.ended.id || null,
                             name: h.state.ended.name || null, score: h.state.ended.score || null } : null,
    logTail: h.state.log.slice(-3)
  };
}"""


def run_lang(browser, lang):
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    console_errors, page_errors, http_errors = [], [], []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("response", lambda r: http_errors.append(f"{r.status} {r.url}")
            if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)

    url = f"{BASE}/index.html?debug=fast&autostart=1&startMode=new&google=0&lang={lang}"
    page.goto(url, wait_until="load", timeout=60_000)

    korean_hits = {}
    raw_keys = set()
    snapshots = []
    ended = None
    stalled = 0
    last_sig = None

    for tick in range(240):  # 최대 4분
        page.wait_for_timeout(1000)
        state = page.evaluate(STATE_JS)
        if state:
            snapshots.append((state["day"], state["phase"]))
            sig = (state["day"], state["phase"], tuple(state["logTail"]))
            stalled = stalled + 1 if sig == last_sig else 0
            last_sig = sig
            if state["ended"]:
                ended = state["ended"]
                break
            if stalled > 45:
                break
        if tick % 3 == 0:
            texts = page.evaluate(TEXT_JS)
            for text in texts:
                if lang == "en" and KOREAN.search(text) and text not in ALLOWED:
                    korean_hits.setdefault(text[:80], 0)
                    korean_hits[text[:80]] += 1
                if re.fullmatch(r"[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+", text):
                    raw_keys.add(text)
    page.screenshot(path=f"{OUT}/hormuz-fullrun-{lang}-final.jpg", type="jpeg", quality=80)

    days = sorted({d for d, _ in snapshots})
    result = {
        "lang": lang,
        "reachedDays": f"{min(days) if days else '?'}~{max(days) if days else '?'}",
        "ended": ended,
        "stalledOut": stalled > 45,
        "koreanInEn": dict(sorted(korean_hits.items(), key=lambda kv: -kv[1])[:15]),
        "untranslatedKeys": sorted(raw_keys)[:15],
        "consoleErrors": console_errors[:10],
        "pageErrors": page_errors[:10],
        "httpErrors": sorted(set(http_errors))[:10],
    }
    failed = bool(page_errors) or bool(raw_keys) or (lang == "en" and korean_hits) \
        or (not ended) or bool(http_errors)
    print(f"[{'PASS' if not failed else 'FAIL'}] {lang} 주행 · DAY {result['reachedDays']} · "
          f"엔딩 {ended and ended.get('id')} · 점수 {ended and ended.get('score')} · "
          f"콘솔 {len(console_errors)} · 페이지오류 {len(page_errors)} · HTTP {len(set(http_errors))}")
    if lang == "en" and korean_hits:
        print("   영어 주행 중 한글:", list(korean_hits.items())[:8])
    if raw_keys:
        print("   미치환 키:", sorted(raw_keys)[:8])
    if page_errors:
        print("   페이지 오류:", page_errors[:3])
    if http_errors:
        print("   HTTP:", sorted(set(http_errors))[:5])
    page.close()
    return result, failed


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    all_failed = False
    report = {}
    for lang in ("en", "ko"):
        result, failed = run_lang(browser, lang)
        report[lang] = result
        all_failed = all_failed or failed
    browser.close()

with open(f"{OUT}/hormuz-fullrun-validation.json", "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("기록:", f"{OUT}/hormuz-fullrun-validation.json")
sys.exit(1 if all_failed else 0)
