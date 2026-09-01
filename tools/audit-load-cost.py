"""전투마다 얼마나 내려받고 얼마나 무거운지 잰다.

"과부하가 있고 무겁다"는 신고를 숫자로 확인하기 위한 것이다. 소프트웨어 렌더링
환경이라 초당 프레임은 사장님 PC 와 다르므로, 하드웨어와 무관한 값 위주로 본다.

  - 내려받는 용량과 요청 수 (기기와 무관)
  - 화면에 올라간 삼각형·드로콜 (기기와 무관)
  - GPU 에 올린 기하·텍스처 개수 (기기와 무관)
  - 전투가 준비될 때까지 걸린 시간 (내려받기·파싱이 대부분이라 참고는 된다)

실행:
    python tools/run-quiet.py python tools/audit-load-cost.py
"""
import json
import pathlib
import sys
import time
from collections import defaultdict

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path("D:/soccerstarWebSource/GameCreator/hormuz")
OUT = ROOT / "output/validation/load-cost.json"
BASE = "http://127.0.0.1:8080/rts-combat.html"

SCENARIOS = [
    ("convoy_shield", "해협 방패"),
    ("tanker_rescue", "라락 구출작전"),
    ("mine_corridor", "기뢰 회랑"),
    ("missile_screen", "미사일 차단막"),
    ("coastal_battery", "해안 포대"),
    ("pickaxe_mountain", "곡괭이산"),
    ("large_fleet_battle", "대규모 함대전"),
]

STATS = """() => {
  const b = window.__HORMUZ_RTS__.battle;
  const info = b.renderer.info;
  return {
    triangles: info.render.triangles,
    calls: info.render.calls,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: (info.programs || []).length,
    units: b.units.length,
    sceneObjects: (() => { let n = 0; b.scene.traverse(() => { n += 1; }); return n; })()
  };
}"""


def kind_of(url):
    if url.endswith(".glb"):
        return "3D 모델"
    if url.endswith((".js", ".mjs")):
        return "스크립트"
    if url.endswith((".png", ".jpg", ".jpeg", ".webp")):
        return "이미지"
    if url.endswith(".json"):
        return "데이터"
    if url.endswith(".css"):
        return "스타일"
    if url.endswith((".mp3", ".ogg", ".wav", ".m4a")):
        return "소리"
    return "기타"


def measure(page, scenario):
    seen = {}

    def on_response(response):
        url = response.url
        if url in seen:
            return
        try:
            length = int(response.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        seen[url] = length

    page.on("response", on_response)
    started = time.time()
    page.goto(f"{BASE}?scenario={scenario}&lang=ko&google=0&difficulty=5",
              wait_until="load", timeout=240000)
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=240000
    )
    ready_seconds = time.time() - started
    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    page.wait_for_timeout(2500)
    stats = page.evaluate(STATS)
    page.remove_listener("response", on_response)

    by_kind = defaultdict(lambda: {"count": 0, "bytes": 0})
    heaviest = []
    for url, size in seen.items():
        kind = kind_of(url.split("?")[0])
        by_kind[kind]["count"] += 1
        by_kind[kind]["bytes"] += size
        if size > 0:
            heaviest.append((size, url.split("/")[-1].split("?")[0]))
    heaviest.sort(reverse=True)
    return {
        "readySeconds": round(ready_seconds, 1),
        "requests": len(seen),
        "totalBytes": sum(seen.values()),
        "byKind": {k: dict(v) for k, v in by_kind.items()},
        "heaviest": [{"bytes": s, "name": n} for s, n in heaviest[:8]],
        **stats,
    }


def main():
    rows = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        for scenario, korean in SCENARIOS:
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            rows[korean] = measure(page, scenario)
            page.close()
            row = rows[korean]
            print(f"{korean:<14}{row['totalBytes']/1024/1024:>7.1f} MB "
                  f"요청 {row['requests']:>3}  준비 {row['readySeconds']:>5.1f}초  "
                  f"삼각형 {row['triangles']:>8,}  드로콜 {row['calls']:>3}  "
                  f"텍스처 {row['textures']:>3}", flush=True)
        browser.close()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n기록: {OUT}")


if __name__ == "__main__":
    main()
