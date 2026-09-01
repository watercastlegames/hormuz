"""본편 미션 라우팅·캠페인 로드맵 정합성 검증.

카드가 지목한 미션 종류가 실제 RTS 시나리오로 올바르게 연결되는지, 그리고
campaign.json 의 implementation 표시가 실제 구현 상태와 어긋나지 않는지 확인한다.

정적 라우팅은 debug=fast + mapcheck=1 조합으로 director만 만들어 확인한다.
또한 일반 속도의 mission=large·mission=rescue·mission=pickaxe 직접 주소가 과거 사건·인트로 관문에
막히지 않고 각각의 전투 편성 iframe을 여는지도 별도로 확인한다.

사용:
    python -X utf8 tools/validate-mission-routing.py
    python -X utf8 tools/validate-mission-routing.py --tag v84
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"

# 카드가 넘기는 미션 종류 -> 최종 RTS 시나리오
EXPECTED_ROUTING = {
    "swarm": "convoy_shield",
    "minesweep": "mine_corridor",
    "intercept": "missile_screen",
    "rescue": "tanker_rescue",
    "bombrun": "coastal_battery",
    "pickaxe": "pickaxe_mountain",
    "large": "large_fleet_battle",
}

# 실제로 전투가 붙어 있는 작전. campaign.json 이 이보다 적게/많이 표시하면 어긋난 것이다.
EXPECTED_PLAYABLE = {
    "convoy_shield",
    "mine_corridor",
    "missile_screen",
    "tanker_rescue",
    "coastal_battery",
    "pickaxe_strike",
    "carrier_screen",
}

ROUTING_JS = """(types) => {
  const director = window.__HORMUZ__.director;
  const fallback = {
    surface_swarm: 'convoy_shield',
    air_defense: 'missile_screen',
    mine_clearance: 'mine_corridor',
    tanker_rescue: 'tanker_rescue',
    strategic_strike: 'coastal_battery',
    pickaxe_strike: 'pickaxe_mountain',
    large_fleet_battle: 'large_fleet_battle'
  };
  const out = {};
  for (const type of types) {
    const mission = director.missionById(director.missionIdFor(type));
    out[type] = {
      missionId: mission.id,
      title: mission.title,
      scenario: mission.scenario || fallback[mission.id] || 'convoy_shield',
      budgetCap: mission.budgetCap || null,
      targetCount: mission.targetCount || null
    };
  }
  return out;
}"""

CAMPAIGN_JS = """() => window.__HORMUZ__.data.campaign.operations.map((o) => ({
  id: o.id, order: o.order, title: o.title,
  implementation: o.implementation, scenario: o.scenario || null
}))"""

DIRECT_LARGE_JS = """() => {
  const frame = document.querySelector('.embedded-rts-frame');
  const replayChoices = [...document.querySelectorAll('[data-replay]')]
    .filter((button) => {
      const style = getComputedStyle(button);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  const frameUrl = frame ? new URL(frame.src, location.href) : null;
  return {
    framePresent: Boolean(frame),
    frameScenario: frameUrl?.searchParams.get('scenario') || null,
    frameCampaign: frameUrl?.searchParams.get('campaign') || null,
    frameVersion: frameUrl?.searchParams.get('v') || null,
    replayChoiceCount: replayChoices.length,
    brief: document.querySelector('#brief-text')?.textContent?.trim() || ''
  };
}"""


def run(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        console_errors, page_errors, http_errors = [], [], []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("response", lambda r: http_errors.append(f"{r.status} {r.url}") if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)

        # autostart=1 로 타이틀 대기를 건너뛰고, debug=fast 로 인트로 전투를 건너뛰고,
        # mapcheck=1 로 director.start() 직전에 멈춘다.
        url = f"{base}/index.html?autostart=1&startMode=new&debug=fast&mapcheck=1&google=0"
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function("() => !!(window.__HORMUZ__ && window.__HORMUZ__.director)", timeout=60_000)

        routing = page.evaluate(ROUTING_JS, list(EXPECTED_ROUTING.keys()))
        operations = page.evaluate(CAMPAIGN_JS)
        # 정적 라우팅 확인이 끝난 본편 월드는 즉시 닫는다. Google/Three.js
        # 컨텍스트를 여러 장 동시에 유지하면 뒤쪽 직접 임무 진입이 늦어진다.
        page.close()

        direct = browser.new_page(viewport={"width": 1600, "height": 900})
        direct.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        direct.on("pageerror", lambda e: page_errors.append(str(e)))
        direct.on("response", lambda r: http_errors.append(f"{r.status} {r.url}") if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)
        direct_url = (
            f"{base}/index.html?autostart=1&prologue=complete&startMode=new"
            f"&mission=large&google=0&routingqa={tag}"
        )
        direct.goto(direct_url, wait_until="domcontentloaded", timeout=60_000)
        # 이 화면은 단계 전환 때 오버레이 DOM을 교체한다. locator 대기는 이미
        # iframe을 찾고도 교체 순간의 핸들을 기다리다 간헐적으로 시간 초과한다.
        # 최종 DOM에 iframe이 존재하는지만 재평가하는 조건 대기를 사용한다.
        direct.wait_for_function(
            "() => !!document.querySelector('.embedded-rts-frame')",
            timeout=60_000,
        )
        direct_large = direct.evaluate(DIRECT_LARGE_JS)
        # 대규모전 iframe의 WebGL 컨텍스트를 해제한 뒤 구출 임무를 연다.
        # 두 전장을 동시에 띄우면 SwiftShader 환경에서 다음 본편 초기화가
        # 60초를 넘겨 실제 라우팅 오류처럼 보일 수 있다.
        direct.close()

        rescue = browser.new_page(viewport={"width": 1600, "height": 900})
        rescue.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        rescue.on("pageerror", lambda e: page_errors.append(str(e)))
        rescue.on("response", lambda r: http_errors.append(f"{r.status} {r.url}") if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)
        rescue_url = (
            f"{base}/index.html?autostart=1&prologue=complete&startMode=new"
            f"&mission=rescue&google=0&routingqa={tag}"
        )
        rescue.goto(rescue_url, wait_until="domcontentloaded", timeout=60_000)
        rescue.wait_for_function(
            "() => !!document.querySelector('.embedded-rts-frame')",
            timeout=60_000,
        )
        direct_rescue = rescue.evaluate(DIRECT_LARGE_JS)
        rescue.close()

        pickaxe = browser.new_page(viewport={"width": 1600, "height": 900})
        pickaxe.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pickaxe.on("pageerror", lambda e: page_errors.append(str(e)))
        pickaxe.on("response", lambda r: http_errors.append(f"{r.status} {r.url}") if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)
        pickaxe_url = (
            f"{base}/index.html?autostart=1&prologue=complete&startMode=new"
            f"&mission=pickaxe&google=0&routingqa={tag}"
        )
        pickaxe.goto(pickaxe_url, wait_until="domcontentloaded", timeout=60_000)
        pickaxe.wait_for_function(
            "() => !!document.querySelector('.embedded-rts-frame')",
            timeout=60_000,
        )
        direct_pickaxe = pickaxe.evaluate(DIRECT_LARGE_JS)
        browser.close()

    print("미션 라우팅")
    for type_name, expected in EXPECTED_ROUTING.items():
        got = routing[type_name]["scenario"]
        ok = got == expected
        if not ok:
            problems.append(f"routing {type_name}: {got} != {expected}")
        print(f"  [{'OK' if ok else 'MISMATCH'}] {type_name:10s} -> {routing[type_name]['missionId']:18s}"
              f" -> {got:18s} (기대 {expected})")

    playable = {o["id"] for o in operations if o["implementation"] == "playable"}
    missing = EXPECTED_PLAYABLE - playable
    extra = playable - EXPECTED_PLAYABLE
    if missing:
        problems.append(f"playable 누락: {sorted(missing)}")
    if extra:
        problems.append(f"playable 과다 표시: {sorted(extra)}")

    direct_ok = (
        direct_large["framePresent"]
        and direct_large["frameScenario"] == "large_fleet_battle"
        and direct_large["frameCampaign"] == "mission"
        and direct_large["frameVersion"] == "138"
        and direct_large["replayChoiceCount"] == 0
    )
    if not direct_ok:
        problems.append(f"직접 대규모 임무 진입 실패: {direct_large}")
    print(
        "\n직접 대규모 임무 "
        f"[{'OK' if direct_ok else 'MISMATCH'}] "
        f"iframe={direct_large['framePresent']} "
        f"scenario={direct_large['frameScenario']} "
        f"v={direct_large['frameVersion']} "
        f"과거선택={direct_large['replayChoiceCount']}"
    )

    direct_rescue_ok = (
        direct_rescue["framePresent"]
        and direct_rescue["frameScenario"] == "tanker_rescue"
        and direct_rescue["frameCampaign"] == "mission"
        and direct_rescue["frameVersion"] == "138"
        and direct_rescue["replayChoiceCount"] == 0
    )
    if not direct_rescue_ok:
        problems.append(f"직접 구출 임무 진입 실패: {direct_rescue}")
    print(
        "직접 구출 임무 "
        f"[{'OK' if direct_rescue_ok else 'MISMATCH'}] "
        f"iframe={direct_rescue['framePresent']} "
        f"scenario={direct_rescue['frameScenario']} "
        f"v={direct_rescue['frameVersion']} "
        f"과거선택={direct_rescue['replayChoiceCount']}"
    )

    direct_pickaxe_ok = (
        direct_pickaxe["framePresent"]
        and direct_pickaxe["frameScenario"] == "pickaxe_mountain"
        and direct_pickaxe["frameCampaign"] == "mission"
        and direct_pickaxe["frameVersion"] == "138"
        and direct_pickaxe["replayChoiceCount"] == 0
    )
    if not direct_pickaxe_ok:
        problems.append(f"직접 곡괭이산 임무 진입 실패: {direct_pickaxe}")
    print(
        "직접 곡괭이산 임무 "
        f"[{'OK' if direct_pickaxe_ok else 'MISMATCH'}] "
        f"iframe={direct_pickaxe['framePresent']} "
        f"scenario={direct_pickaxe['frameScenario']} "
        f"v={direct_pickaxe['frameVersion']} "
        f"과거선택={direct_pickaxe['replayChoiceCount']}"
    )

    print("\n캠페인 로드맵")
    for operation in sorted(operations, key=lambda o: o["order"]):
        print(f"  작전 {operation['order']:02d} {operation['id']:18s} {operation['implementation']:9s}"
              f" scenario={operation['scenario']}")

    print(f"\n콘솔 오류 {len(console_errors)} · 페이지 오류 {len(page_errors)} · HTTP 4xx/5xx {len(http_errors)}")
    if console_errors or page_errors or http_errors:
        problems.append("브라우저 오류 발생")

    record = OUT / f"hormuz-{tag}-mission-routing-validation.json"
    record.write_text(json.dumps({
        "routing": routing,
        "expectedRouting": EXPECTED_ROUTING,
        "campaignOperations": operations,
        "expectedPlayable": sorted(EXPECTED_PLAYABLE),
        "directLargeMission": direct_large,
        "directRescueMission": direct_rescue,
        "directPickaxeMission": direct_pickaxe,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "httpErrors": http_errors,
        "problems": problems,
        "allPassed": not problems,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"기록: {record}")
    if problems:
        for problem in problems:
            print(f"  문제: {problem}")
        return 1
    print("라우팅·로드맵 정합성 통과.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="본편 미션 라우팅·캠페인 로드맵 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
