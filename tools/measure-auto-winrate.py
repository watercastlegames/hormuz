"""추천 편성 + 자동전투만으로 몇 판이나 이기는지 잰다.

왜 재는가
---------
목표는 "추천 편성 그대로 두고 손 놓으면 아슬아슬하게 지는 쪽"이다. 그래야
플레이어가 전력을 조금씩 더 넣어가며 이기는 맛이 난다. 자동전투가 100% 이기면
편성 화면이 의미가 없고, 0% 면 손을 대도 안 되는 판처럼 느껴진다.

한 판만 돌려서는 승률을 알 수 없다. 같은 조건에서도 결과가 갈린다 —
실제로 대규모 함대전 난이도 3 은 같은 편성으로 이기기도 지기도 했다.
그래서 조합마다 여러 번 돌려 비율을 낸다.

읽는 법
-------
  승률      목표에 얼마나 가까운가
  여유      이겼을 때 아군이 얼마나 남았는가. 낮을수록 아슬아슬한 승리다.
  걸린 시간 제한시간 대비 얼마나 썼는가

실행은 tools/run-quiet.py 로 감쌀 것:
  python tools/run-quiet.py python tools/measure-auto-winrate.py --repeats 3
"""
import argparse
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:8080/rts-combat.html"
OUT = pathlib.Path(
    "D:/soccerstarWebSource/GameCreator/hormuz/output/validation/"
    "hormuz-auto-winrate.json"
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

WATCH = """() => {
  const b = window.__HORMUZ_RTS__.battle;
  const alive = t => b.units.filter(u => u.team === t && u.alive).length;
  return {
    t: +b.elapsed.toFixed(1), ended: b.ended, ok: b.battleSuccess,
    ally: alive('ally'), civ: alive('civilian'),
    limit: b.config.battle.durationSeconds
  };
}"""

SETUP = """() => {
  const b = window.__HORMUZ_RTS__.battle;
  const o = b.config.fleetSelection.options;
  const cost = Object.entries(b.fleetSelection)
    .reduce((s, [t, n]) => s + n * (o[t]?.cost || 0), 0);
  return {
    fleet: { ...b.fleetSelection },
    cost, budget: b.config.fleetSelection.budget,
    allyStart: b.units.filter(u => u.team === 'ally').length,
    civStart: b.units.filter(u => u.team === 'civilian').length
  };
}"""


def one_run(page, scenario, difficulty, speed, hp=1.0, damage=1.0):
    page.goto(
        f"{BASE}?scenario={scenario}&lang=ko&google=0&difficulty={difficulty}"
        f"&enemyHp={hp}&enemyDamage={damage}",
        wait_until="load", timeout=240000,
    )
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=240000
    )
    setup = page.evaluate(SETUP)
    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    # 밸런스를 재는 데 화면은 필요 없다. GPU 가 없어 소프트웨어로 그리느라
    # CPU 를 거의 다 쓰는데, 그 몫을 시뮬레이션에 돌리면 훨씬 빨리 끝난다.
    page.evaluate("""() => {
      const b = window.__HORMUZ_RTS__.battle;
      b.renderer.render = () => {};
      b.updateLabels = () => {};
      b.updateRadar = () => {};
      b.updateHud = () => {};
    }""")
    # 편성은 전투가 시작돼야 전장에 놓인다. 시작 전에 세면 분모가 틀린다.
    started = page.evaluate(WATCH)
    page.evaluate(f"() => window.__HORMUZ_RTS__.setTimeScale({speed})")
    page.evaluate("() => window.__HORMUZ_RTS__.setAutoBattle(true)")

    state = None
    wall_limit = time.time() + 420
    while time.time() < wall_limit:
        state = page.evaluate(WATCH)
        if state["ended"]:
            break
        time.sleep(0.3)

    survivors = started["ally"] or 1
    return {
        "win": bool(state and state["ended"] and state["ok"]),
        "seconds": round(state["t"], 1) if state else None,
        "limit": state["limit"] if state else None,
        "allyLeft": state["ally"] if state else 0,
        "allyStart": started["ally"],
        "margin": round((state["ally"] if state else 0) / survivors, 2),
        "fleetCost": setup["cost"],
        "budget": setup["budget"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--difficulties", default="1,3,5")
    parser.add_argument("--speed", type=float, default=8)
    parser.add_argument("--only", default="")
    parser.add_argument("--target", type=float, default=0.65)
    parser.add_argument("--enemy-hp", type=float, default=1.0)
    parser.add_argument("--enemy-damage", type=float, default=1.0)
    args = parser.parse_args()

    levels = [int(x) for x in args.difficulties.split(",") if x.strip()]
    wanted = {x.strip() for x in args.only.split(",") if x.strip()}
    targets = [s for s in SCENARIOS if not wanted or s[0] in wanted]

    cells = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        page = browser.new_page(viewport={"width": 900, "height": 600})
        for scenario, korean in targets:
            for difficulty in levels:
                runs = [one_run(page, scenario, difficulty, args.speed,
                                args.enemy_hp, args.enemy_damage)
                        for _ in range(args.repeats)]
                wins = sum(1 for r in runs if r["win"])
                rate = wins / len(runs)
                won = [r for r in runs if r["win"]]
                margin = round(sum(r["margin"] for r in won) / len(won), 2) if won else 0
                cells.append({
                    "scenario": scenario, "scenarioKo": korean,
                    "difficulty": difficulty, "winRate": rate,
                    "wins": wins, "runs": len(runs),
                    "avgMargin": margin,
                    "fleetCost": runs[0]["fleetCost"], "budget": runs[0]["budget"],
                    "detail": runs,
                })
                print(f"{korean:<12} d{difficulty}  승률 {rate:>5.0%} ({wins}/{len(runs)})  "
                      f"여유 {margin:>4.0%}  편성 {runs[0]['fleetCost']}/{runs[0]['budget']}",
                      flush=True)
        browser.close()

    overall = sum(c["wins"] for c in cells) / sum(c["runs"] for c in cells)
    print(f"\n전체 승률 {overall:.0%} (목표 {args.target:.0%})")
    by_level = {}
    for cell in cells:
        by_level.setdefault(cell["difficulty"], []).append(cell)
    for level in sorted(by_level):
        group = by_level[level]
        rate = sum(c["wins"] for c in group) / sum(c["runs"] for c in group)
        print(f"  난이도 {level}: {rate:.0%}")
    print("\n목표에서 먼 조합 (차이 25%p 이상)")
    far = [c for c in cells if abs(c["winRate"] - args.target) >= 0.25]
    for cell in sorted(far, key=lambda c: -abs(c["winRate"] - args.target)):
        way = "너무 쉬움" if cell["winRate"] > args.target else "너무 어려움"
        print(f"  {cell['scenarioKo']:<12} d{cell['difficulty']}  "
              f"{cell['winRate']:.0%}  {way}")
    if not far:
        print("  없음")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"target": args.target, "overall": overall, "cells": cells},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n기록: {OUT}")


if __name__ == "__main__":
    main()
