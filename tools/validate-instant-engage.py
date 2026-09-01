"""적이 전투 시작과 동시에 공격해도 판이 성립하는지 잰다.

교전 지연(enemyEngageDelaySeconds)을 전 시나리오 0으로 내렸다. 예전에는
18~45초를 기다렸다가 적이 움직였다. 그 시간이 없어졌으니 확인할 것은 하나다 —
**손 쓸 틈 없이 지는 판이 생겼는가.**

판정 기준
  - 난이도 1에서 자동전투만으로 못 이기면 너무 어려워진 것이다.
  - 시작 5초 안에 유조선이 격침되면 사람이 개입할 틈이 없다.
  - 난이도 5에서 지는 것은 정상일 수 있다. 어떻게 지는지만 남긴다.

브라우저는 하나만 띄우고 순서대로 돈다. 시나리오마다 브라우저를 새로 띄우면
소프트웨어 렌더링 때문에 PC 를 붙잡는다. 실행은 tools/run-quiet.py 로 감쌀 것:
  python tools/run-quiet.py --report python tools/validate-instant-engage.py
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
    "hormuz-instant-engage.json"
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

# 화면에서 한 번에 뽑아온다. 왕복이 잦으면 그것 자체가 시뮬을 느리게 만든다.
SNAPSHOT = """() => {
  const b = window.__HORMUZ_RTS__?.battle;
  if (!b) return null;
  const ratio = (team) => {
    const list = b.units.filter(u => u.team === team && u.alive);
    if (!list.length) return 0;
    return Math.min(...list.map(u => u.hp / (u.definition?.maxHp || u.maxHp || u.hp)));
  };
  return {
    elapsed: b.elapsed,
    ended: b.ended,
    success: b.battleSuccess,
    delay: b.config.battle.enemyEngageDelaySeconds,
    allies: b.units.filter(u => u.team === 'ally' && u.alive).length,
    civilians: b.units.filter(u => u.team === 'civilian' && u.alive).length,
    allyHp: ratio('ally'),
    civilianHp: ratio('civilian'),
    objective: b.getObjectiveDestroyedCount ? b.getObjectiveDestroyedCount() : null
  };
}"""


def play(page, scenario, difficulty, cap_seconds, time_scale):
    page.goto(
        f"{BASE}?scenario={scenario}&lang=ko&google=0&difficulty={difficulty}",
        wait_until="load", timeout=240000,
    )
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=240000
    )
    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    page.evaluate(f"() => window.__HORMUZ_RTS__.setTimeScale({time_scale})")
    # 아무 명령도 주지 않는다. 추천 기본 편성 + 자동전투만.
    page.evaluate("() => window.__HORMUZ_RTS__.setAutoBattle(true)")

    first = page.evaluate(SNAPSHOT)
    start_civilians = first["civilians"]
    first_ally_hit = None
    first_civilian_hit = None
    first_civilian_sunk = None
    last = first
    wall_limit = time.time() + 600

    while time.time() < wall_limit:
        state = page.evaluate(SNAPSHOT)
        if state is None:
            break
        last = state
        if first_ally_hit is None and state["allyHp"] < 0.999:
            first_ally_hit = round(state["elapsed"], 1)
        # 맞은 것과 가라앉은 것은 다르다. 맞는 건 정상이고, 개입할 틈 없이
        # 가라앉는 것만 문제다.
        if first_civilian_hit is None and state["civilianHp"] < 0.999:
            first_civilian_hit = round(state["elapsed"], 1)
        if first_civilian_sunk is None and state["civilians"] < start_civilians:
            first_civilian_sunk = round(state["elapsed"], 1)
        if state["ended"] or state["elapsed"] >= cap_seconds:
            break
        time.sleep(0.35)

    return {
        "difficulty": difficulty,
        "engageDelay": first["delay"],
        "success": bool(last["ended"] and last["success"]),
        "ended": bool(last["ended"]),
        "endedAt": round(last["elapsed"], 1),
        "firstAllyHitAt": first_ally_hit,
        "firstCivilianHitAt": first_civilian_hit,
        "firstCivilianSunkAt": first_civilian_sunk,
        "alliesAlive": last["allies"],
        "civiliansAlive": last["civilians"],
        "civilianStart": start_civilians,
    }


def judge(rows):
    """치명적인 것만 고른다."""
    problems = []
    for row in rows:
        tag = f"{row['scenarioKo']} d{row['difficulty']}"
        if row["difficulty"] == 1 and not row["success"]:
            problems.append(f"{tag}: 난이도 1인데 자동전투로 못 이김"
                            f" (종료={row['ended']}, {row['endedAt']}초)")
        sunk = row.get("firstCivilianSunkAt")
        if sunk is not None and sunk <= 5:
            problems.append(f"{tag}: 시작 {sunk}초에 유조선 격침 — 개입할 틈 없음")
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--difficulties", default="1,3,5")
    parser.add_argument("--cap", type=float, default=150, help="시나리오당 시뮬 상한 초")
    parser.add_argument("--speed", type=float, default=6)
    parser.add_argument("--only", default="", help="쉼표로 구분한 시나리오 id")
    args = parser.parse_args()

    levels = [int(x) for x in args.difficulties.split(",") if x.strip()]
    wanted = {x.strip() for x in args.only.split(",") if x.strip()}
    targets = [s for s in SCENARIOS if not wanted or s[0] in wanted]

    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        page = browser.new_page(viewport={"width": 900, "height": 600})
        for scenario, korean in targets:
            for difficulty in levels:
                started = time.time()
                row = play(page, scenario, difficulty, args.cap, args.speed)
                row["scenario"] = scenario
                row["scenarioKo"] = korean
                row["wallSeconds"] = round(time.time() - started, 1)
                rows.append(row)
                mark = "승리" if row["success"] else ("패배" if row["ended"] else "미종료")
                print(f"[{mark:>3}] {korean:<12} d{difficulty}  "
                      f"지연={row['engageDelay']}s  종료 {row['endedAt']:>5.1f}초  "
                      f"아군피격 {str(row['firstAllyHitAt']):>5}  "
                      f"유조선피격 {str(row['firstCivilianHitAt']):>5}  "
                      f"격침 {str(row.get('firstCivilianSunkAt')):>5}  "
                      f"유조선 {row['civiliansAlive']}/{row['civilianStart']}",
                      flush=True)
        browser.close()

    problems = judge(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"allPassed": not problems, "problems": problems, "runs": rows},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n기록: {OUT}")
    if problems:
        print("손봐야 할 것:")
        for line in problems:
            print(f"  - {line}")
        return 1
    print("난이도 1 전부 자동전투로 승리 · 초반 즉사 없음.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
