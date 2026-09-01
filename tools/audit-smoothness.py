"""전투가 매끄럽게 도는지, 어디서 끊기는지 프레임 단위로 잰다.

무엇을 믿을 수 있나
  이 측정 환경에는 GPU 가 없다(소프트웨어 렌더링). 그래서 **초당 프레임 절대값은
  사장님 화면과 다르다**. 대신 아래 두 가지는 환경과 크게 무관하다.
    - 긴 프레임의 개수와 원인: 한 프레임이 100ms 넘게 멈추는 것은 그릴 것이 많아서가
      아니라 대개 그 순간에 무언가를 불러오거나 만들기 때문이다.
    - 시간이 갈수록 느려지는가: 메모리와 프레임 시간이 계속 늘면 새는 곳이 있다.
  그래서 절대 속도가 아니라 **끊김과 악화**를 본다.

실행:
    python tools/run-quiet.py --cores 6 python tools/audit-smoothness.py
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(
    "D:/soccerstarWebSource/GameCreator/hormuz/output/validation/smoothness.json"
)

SCENARIOS = [
    ("convoy_shield", "해협 방패"),
    ("tanker_rescue", "라락 구출작전"),
    ("mine_corridor", "기뢰 회랑"),
    ("missile_screen", "미사일 차단막"),
    ("coastal_battery", "해안 포대"),
    ("pickaxe_mountain", "곡괭이산"),
    ("large_fleet_battle", "대규모 함대전"),
]

# 페이지 안에서 프레임 간격을 직접 모은다. 바깥에서 재면 측정 자체가 끼어든다.
# 그리기(GPU)와 계산(JS)을 나눠 잰다.
#
# 이 환경은 GPU 가 없어 그리기가 프레임의 대부분을 차지한다. 사장님 화면에는
# GPU 가 있으므로 그 몫은 크게 줄어든다. 반면 계산 시간은 기기가 달라도 비슷하다.
# 그래서 "계산에 몇 ms 쓰는가" 와 "계산이 튀는 순간이 있는가" 를 본다.
# 게임이 한 프레임에 쓰는 **자바스크립트 시간**을 잰다.
#
# renderer.render() 는 그리기 명령만 넘기고 곧장 돌아온다(1~2ms). 실제 그리기는
# 그 뒤에 GPU 가 한다. 그래서 render 안팎을 재는 방식으로는 갈리지 않는다.
# 대신 매 프레임 도는 animate() 를 통째로 재면 게임이 쓰는 계산 시간이 나온다.
# 이 값은 GPU 유무와 크게 상관없어 사장님 화면에도 대체로 그대로 적용된다.
START_PROBE = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  window.__STAT__ = { js: [], gap: [] };
  window.__PROBE_ON__ = true;
  const original = battle.animate.bind(battle);
  battle.__origAnimate = original;
  let previous = performance.now();
  battle.animate = function patched() {
    const at = performance.now();
    window.__STAT__.gap.push(at - previous);
    previous = at;
    original();
    if (window.__PROBE_ON__) window.__STAT__.js.push(performance.now() - at);
  };
}"""

READ_PROBE = """() => {
  window.__PROBE_ON__ = false;
  const battle = window.__HORMUZ_RTS__.battle;
  if (battle.__origAnimate) battle.animate = battle.__origAnimate;
  const stat = window.__STAT__;
  const js = stat.js.slice(1);
  const gap = stat.gap.slice(1);
  const pick = (list, q) => {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1);
  };
  return {
    frames: js.length,
    jsMedian: pick(js, 0.5),
    jsP95: pick(js, 0.95),
    jsWorst: pick(js, 0.999),
    jsOver8: js.filter((v) => v > 8).length,
    jsOver16: js.filter((v) => v > 16).length,
    jsOver50: js.filter((v) => v > 50).length,
    gapMedian: pick(gap, 0.5),
    heapMb: performance.memory
      ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
  };
}"""

def run(page, scenario):
    errors, http_errors = [], []
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error" and "AudioContext" not in m.text else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: http_errors.append(f"{r.status} {r.url.split('/')[-1]}")
            if r.status >= 400 else None)

    mid_battle = []
    battle_started = {"on": False}
    page.on("response", lambda r: mid_battle.append(r.url.split("/")[-1].split("?")[0])
            if battle_started["on"] and r.url.split("?")[0].endswith(
                (".glb", ".webp", ".png", ".jpg", ".mp3", ".json", ".js")) else None)

    started = time.time()
    page.goto(f"{BASE}/rts-combat.html?scenario={scenario}&lang=ko&google=0&difficulty=3",
              wait_until="load", timeout=240000)
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=240000)
    ready = time.time() - started

    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    page.evaluate("() => window.__HORMUZ_RTS__.setAutoBattle(true)")
    # 전투가 시작된 뒤에 무언가를 더 내려받으면 그 순간 화면이 끊긴다.
    page.wait_for_timeout(1200)
    battle_started["on"] = True
    page.evaluate(START_PROBE)
    heap_early = page.evaluate(
        "() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0")
    page.wait_for_timeout(20000)
    probe = page.evaluate(READ_PROBE)
    heap_late = page.evaluate(
        "() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0")
    snapshot = page.evaluate(
        "() => ({ tri: window.__HORMUZ_RTS__.battle.renderer.info.render.triangles,"
        " calls: window.__HORMUZ_RTS__.battle.renderer.info.render.calls,"
        " units: window.__HORMUZ_RTS__.battle.units.length })")
    return {"readySeconds": round(ready, 1), **probe, **snapshot,
            "midBattleRequests": sorted(set(mid_battle))[:6],
            "heapGrowthMb": round(heap_late - heap_early, 1),
            "errors": errors[:4], "httpErrors": http_errors[:4]}


def main():
    rows = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for scenario, korean in SCENARIOS:
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            rows[korean] = run(page, scenario)
            page.close()
            row = rows[korean]
            print(f"{korean:<14}준비 {row['readySeconds']:>4.1f}초 │ "
                  f"프레임당 계산 중앙 {row['jsMedian']:>5.1f} 95% {row['jsP95']:>6.1f} "
                  f"최악 {row['jsWorst']:>7.1f}ms │ "
                  f"8/16/50ms 초과 {row['jsOver8']:>3}/{row['jsOver16']:>3}/{row['jsOver50']:>2} "
                  f"({row['frames']}프레임) │ 전투중 내려받기 "
                  f"{len(row['midBattleRequests'])} │ 메모리 +{row['heapGrowthMb']}MB │ "
                  f"삼각형 {row['tri']:,} 오류 {len(row['errors'])}", flush=True)
        browser.close()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    print()
    stutter = [k for k, v in rows.items() if v["midBattleRequests"]]
    leaking = [k for k, v in rows.items() if v["heapGrowthMb"] > 12]
    broken = [k for k, v in rows.items() if v["errors"] or v["httpErrors"]]
    print("전투 도중 추가 내려받기(끊김 원인):", ", ".join(stutter) if stutter else "없음")
    print("메모리가 계속 느는 전투:", ", ".join(leaking) if leaking else "없음")
    print("오류·404 있는 전투:", ", ".join(broken) if broken else "없음")
    print(f"기록: {OUT}")


if __name__ == "__main__":
    main()
