"""교전 시작 안내 문구가 실제 지연 시간과 맞는지 잰다.

문구에 초가 박혀 있던 시절에는 난이도가 그 시간을 줄여도 문구가 그대로였다.
그래서 화면이 말하는 초와 실제로 적이 오는 초가 달랐다.

검사하는 불변식 두 가지:
  1. 문구에 숫자가 있으면 그 숫자는 실제 지연 초와 같아야 한다.
  2. 지연이 0이면(기뢰 회랑) 기다리라는 말 대신 다른 문장이 나와야 하고
     거기에는 숫자가 없어야 한다.
곡괭이산처럼 문구에 애초 숫자가 없는 시나리오는 1번을 자동으로 만족한다.
"""
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:8080/rts-combat.html"
OUT = pathlib.Path(
    "D:/soccerstarWebSource/GameCreator/hormuz/output/validation/"
    "hormuz-contact-countdown-133.json"
)

CASES = [
    ("convoy_shield", 1), ("convoy_shield", 5),
    ("tanker_rescue", 1), ("tanker_rescue", 4),
    ("mine_corridor", 1), ("mine_corridor", 5),
    ("missile_screen", 1), ("missile_screen", 3),
    ("coastal_battery", 1), ("coastal_battery", 5),
    ("pickaxe_mountain", 1), ("pickaxe_mountain", 5),
    ("large_fleet_battle", 1), ("large_fleet_battle", 5),
]

# 화면이 실제로 쓴 문장과, 그 문장을 만든 값을 같은 시점에 뽑는다.
READ = """() => {
  const b = window.__HORMUZ_RTS__?.battle;
  if (!b) return null;
  const nodes = Array.from(document.querySelectorAll('#battle-log > *'));
  return {
    delay: b.config.battle.enemyEngageDelaySeconds,
    difficulty: b.config.battle.adaptiveProfile?.difficulty ?? null,
    line: b.contactCountdownLine(),
    template: b.text('contactCountdown'),
    templateNow: b.text('contactCountdownNow'),
    lang: b.lang,
    logs: nodes.map(n => n.textContent.trim())
  };
}"""

# 시간 표기만 본다. "3개 축" 같은 다른 숫자는 시간이 아니다.
TIME = re.compile(r"\d+\s*초|\d+\s*second", re.I)


def probe(page, scenario, difficulty, lang):
    page.goto(
        f"{BASE}?scenario={scenario}&lang={lang}&google=0&difficulty={difficulty}",
        wait_until="load",
    )
    page.wait_for_function(
        "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=60000
    )
    page.evaluate("() => window.__HORMUZ_RTS__.start()")
    page.wait_for_timeout(900)
    return page.evaluate(READ)


def judge(state, delay):
    """(통과 여부, 사유)

    문장 안의 숫자를 세는 대신, 문장을 만든 템플릿을 본다. 대규모 함대전처럼
    "3개 축" 같은 다른 숫자가 섞인 문장이 있어서, 숫자 개수로는 판정할 수 없다.
    """
    line, logs = state["line"], state["logs"]
    if not line:
        return False, "안내 문구가 비어 있음"
    # 로그 항목 앞에는 경과 시각이 붙는다. 문장은 그 뒤에 그대로 있어야 한다.
    if not any(line in entry for entry in logs):
        return False, "문구가 전투 로그에 찍히지 않음"

    if delay <= 0:
        template = state["templateNow"]
        if template == "contactCountdownNow":
            return False, "지연 0인데 전용 문구가 없음(키 그대로 노출)"
        if TIME.search(template):
            return False, "지연 0인데 문구에 기다리라는 시간이 남아 있음"
        if line != template:
            return False, "문구가 템플릿과 다름"
        return True, "지연 0 → 기다리라고 하지 않음"

    template = state["template"]
    if "{delay}" not in template:
        if TIME.search(template):
            return False, f"초가 문구에 박혀 있음: {template}"
        return True, "문구에 시간 언급 없음 (대조 대상 아님)"
    label = f"{delay} seconds" if state["lang"] == "en" else f"{delay}초"
    expected = template.replace("{delay}", label)
    if line != expected:
        return False, f"기대 '{expected}' ≠ 실제 '{line}'"
    return True, f"일치 ({label})"


def main():
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        for scenario, difficulty in CASES:
            for lang in ("ko", "en"):
                state = probe(page, scenario, difficulty, lang)
                delay = int(round(state["delay"] or 0))
                ok, why = judge(state, delay)
                rows.append({
                    "scenario": scenario, "difficulty": difficulty, "lang": lang,
                    "actualDelay": delay, "line": state["line"],
                    "pass": ok, "why": why,
                })
                print(f"[{'PASS' if ok else 'FAIL'}] {scenario:<19} d{difficulty} {lang}  "
                      f"실제={delay:>2}s  {why}")
                if not ok:
                    print(f"        {state['line']}")
        browser.close()

    failed = [r for r in rows if not r["pass"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"allPassed": not failed, "cases": rows}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n기록: {OUT}")
    print("전 케이스 통과." if not failed else f"실패 {len(failed)}건")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
