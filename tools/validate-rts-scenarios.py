"""HORMUZ RTS 시나리오 성능·무결성 게이트.

전 시나리오를 실제 브라우저에서 띄워 삼각형·드로콜·콘솔 오류·바다 유닛 육지 침범을
측정하고, 검증 화면과 JSON 기록을 output/validation/ 에 남긴다.

성능 헌법: 삼각형 120,000 / 드로콜 90. 유닛을 추가하거나 모델 경로를 바꾸면
한 시나리오만 보지 말고 반드시 전부 다시 돌린다.

사전 준비:
    pip install playwright
    python -m playwright install chromium
    (로컬 정적 서버가 127.0.0.1:8080 에서 저장소 루트를 서빙 중이어야 한다)

사용:
    python -X utf8 tools/validate-rts-scenarios.py
    python -X utf8 tools/validate-rts-scenarios.py --tag v84
    python -X utf8 tools/validate-rts-scenarios.py --scenarios large_fleet_battle
"""

import argparse
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"

TRIANGLE_BUDGET = 120_000
DRAW_CALL_BUDGET = 90

ALL_SCENARIOS = [
    "convoy_shield",
    "tanker_rescue",
    "mine_corridor",
    "missile_screen",
    "coastal_battery",
    "pickaxe_mountain",
    "large_fleet_battle",
]

EXPECTED_MAP_IDS = {
    "convoy_shield": "hormuz_strait",
    "tanker_rescue": "larak_tanker_rescue",
    "mine_corridor": "gulf_of_oman",
    "missile_screen": "western_gulf",
    "coastal_battery": "bushehr_coast",
    "pickaxe_mountain": "pickaxe_mountain",
    "large_fleet_battle": "jask_joint_battle",
}

EXPECTED_ENEMY_TYPES = {
    "convoy_shield": {"fastBoat"},
    "tanker_rescue": {"fastBoat", "enemyUsv"},
    "mine_corridor": {"mine"},
    "missile_screen": {"airThreat"},
    "coastal_battery": {"tel", "enemyMarine"},
    "pickaxe_mountain": {"bunkerEntrance", "tel"},
    "large_fleet_battle": {"fastBoat", "enemyUsv", "airThreat"},
}

SNAPSHOT_JS = """() => {
  const s = window.__HORMUZ_RTS__.getSnapshot();
  const b = window.__HORMUZ_RTS__.battle;
  const count = (team) => b.units.filter((u) => u.team === team).length;
  const types = {};
  b.units.forEach((u) => { types[u.type] = (types[u.type] || 0) + 1; });
  return {
    initialized: s.initialized,
    ended: s.ended,
    battleSuccess: b.battleSuccess,
    objectiveDestroyed: s.objectiveDestroyed,
    mapId: s.map && s.map.id,
    mapName: s.map && s.map.name,
    provider: s.map && s.map.provider,
    googleStatus: s.map && s.map.googleStatus,
    seaUnitsOnLand: (s.navigation && s.navigation.seaUnitsOnLand) || [],
    landUnits: ((s.map && s.map.landUnits) || []).length,
    landUnitsOnLand: ((s.map && s.map.landUnits) || []).filter((u) => u.onLand).length,
    ally: count('ally'), enemy: count('enemy'), civilian: count('civilian'),
    types,
    enemyTypes: [...new Set(
      b.units.filter((u) => u.team === 'enemy').map((u) => u.type)
    )].sort(),
    objective: (document.getElementById('objective-text') || {}).textContent || null,
    runtimeVersion: document.getElementById('rts-game')?.dataset.runtimeVersion || null,
    manualOrderRecovery: window.__HORMUZ_AUTO_BATTLE_ENABLE_QA__ || null,
    googleWheelQa: window.__HORMUZ_GOOGLE_WHEEL_QA__ || null,
    autoBattle: s.autoBattle || null,
    shots: s.shots || null,
    autoButton: (() => {
      const button = document.querySelector("[data-command='autoBattle']");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        text: button.textContent.trim(),
        active: button.classList.contains('active'),
        pressed: button.getAttribute('aria-pressed'),
        disabled: button.disabled,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    })(),
    drawCalls: b.renderer.info.render.calls,
    triangles: b.renderer.info.render.triangles
  };
}"""

# 유닛 종류별 삼각형 분해. 예산을 넘겼을 때 어느 모델이 범인인지 즉시 나온다.
BREAKDOWN_JS = """() => {
  const b = window.__HORMUZ_RTS__.battle;
  const per = {};
  const triOf = (obj) => {
    let t = 0;
    obj.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      if (o.visible === false) return;
      const g = o.geometry;
      if (!g) return;
      const n = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
      t += n * (o.isInstancedMesh ? o.count : 1);
    });
    return Math.round(t);
  };
  b.units.forEach((u) => {
    const key = u.team + ':' + u.type;
    if (!per[key]) per[key] = { count: 0, tri: 0 };
    per[key].count += 1;
    if (u.group) per[key].tri += triOf(u.group);
  });
  return per;
}"""


def run(base, scenarios, tag, lang, warmup_ms, viewport, google, speed):
    OUT.mkdir(parents=True, exist_ok=True)
    results = {}
    failures = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        for scenario in scenarios:
            page = browser.new_page(viewport=viewport, device_scale_factor=1)
            console_errors, page_errors, http_errors = [], [], []
            # 헤드리스 브라우저에는 소리 장치가 없다. 그래서 WebAudio 가 이따금
            # 장치 오류를 뱉는데, 게임 결함이 아니라 측정 환경 문제다. 회차마다
            # 나왔다 사라져 판정을 흔들기만 한다. 이 한 가지만 걸러낸다.
            def is_environment_noise(text):
                return "AudioContext encountered an error" in text

            page.on(
                "console",
                lambda m: (
                    console_errors.append(m.text)
                    if m.type == "error" and not is_environment_noise(m.text)
                    else None
                ),
            )
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.on("response", lambda r: http_errors.append(f"{r.status} {r.url}") if r.status >= 400 and "cdn-cgi/trace" not in r.url else None)

            url = (
                f"{base}/rts-combat.html?scenario={scenario}"
                f"&google={google}&lang={lang}&speed={speed}"
            )
            page.goto(url, wait_until="load", timeout=60_000)

            ready = False
            for _ in range(60):
                try:
                    ready = page.evaluate(
                        "() => !!(window.__HORMUZ_RTS__ && window.__HORMUZ_RTS__.getSnapshot().initialized)")
                except Exception:
                    ready = False
                if ready:
                    break
                page.wait_for_timeout(1000)

            snapshot, breakdown, shot = {}, {}, None
            if ready:
                page.evaluate("() => window.__HORMUZ_RTS__.start()")
                page.evaluate("""() => {
                  const api = window.__HORMUZ_RTS__;
                  const battle = api.battle;
                  const enemies = battle.units.filter((unit) => (
                    unit.team === 'enemy' && unit.alive
                  ));
                  battle.units
                    .filter((unit) => unit.team === 'ally' && unit.alive)
                    .forEach((unit, index) => {
                      const target = enemies.find((candidate) => (
                        battle.canUnitAttackTarget(unit, candidate)
                      )) || enemies[index % Math.max(1, enemies.length)];
                      if (target) unit.order = { type: 'attack', targetUnit: target };
                    });
                  api.setAutoBattle(true);
                  window.__HORMUZ_AUTO_BATTLE_ENABLE_QA__ = battle.units
                    .filter((unit) => unit.team === 'ally' && unit.alive)
                    .map((unit) => ({
                      id: unit.id,
                      order: unit.order?.type || null,
                      autoBattle: unit.order?.autoBattle === true
                    }));
                }""")
                if google == 1:
                    page.locator("#rts-canvas").hover()
                    for _ in range(24):
                        page.mouse.wheel(0, 800)
                    camera_at_limit = page.evaluate(
                        "() => window.__HORMUZ_RTS__.getSnapshot().camera"
                    )
                    for _ in range(12):
                        page.mouse.wheel(0, 800)
                    camera_after_extra_wheel = page.evaluate(
                        "() => window.__HORMUZ_RTS__.getSnapshot().camera"
                    )
                    page.evaluate(
                        """([atLimit, afterExtra]) => {
                          window.__HORMUZ_GOOGLE_WHEEL_QA__ = {
                            atLimit,
                            afterExtra
                          };
                        }""",
                        [camera_at_limit, camera_after_extra_wheel],
                    )
                # 벽시계가 아니라 전투 시간으로 기다린다.
                #
                # 예전에는 18초를 그냥 기다렸다. 그런데 CPU 를 묶어 돌리면
                # (tools/run-quiet.py) 같은 18초에 전투가 절반도 진행되지 않아,
                # 교전이 시작되기도 전에 측정해 "무기를 한 발도 안 쏜다"는
                # 잘못된 실패가 났다. 측정 환경이 결과를 바꾸면 안 된다.
                target_elapsed = (warmup_ms / 1000) * speed
                wall_deadline = time.time() + max(120, warmup_ms / 1000 * 8)
                while time.time() < wall_deadline:
                    state = page.evaluate(
                        "() => { const s = window.__HORMUZ_RTS__.getSnapshot();"
                        " return { elapsed: s.elapsed, ended: s.ended }; }"
                    )
                    if state["ended"] or state["elapsed"] >= target_elapsed:
                        break
                    page.wait_for_timeout(500)
                if scenario == "pickaxe_mountain":
                    for _ in range(60):
                        if page.evaluate(
                            "() => window.__HORMUZ_RTS__"
                            ".getSnapshot().objectiveDestroyed >= 2"
                        ):
                            break
                        page.wait_for_timeout(1000)
                snapshot = page.evaluate(SNAPSHOT_JS)
                breakdown = page.evaluate(BREAKDOWN_JS)
                shot = OUT / f"hormuz-rts-{tag}-{scenario.replace('_', '-')}-{viewport['width']}x{viewport['height']}.jpg"
                # 검증 화면은 기록용이다. CPU 를 묶어 돌리면(tools/run-quiet.py)
                # 캡처가 제한 시간을 넘길 때가 있는데, 그것 때문에 판정 자체를
                # 잃으면 안 된다. 숫자 판정은 이미 위에서 다 받았다.
                try:
                    page.screenshot(
                        path=str(shot),
                        type="jpeg",
                        quality=82,
                        timeout=60_000,
                    )
                except Exception as error:  # noqa: BLE001
                    print(f"  (검증 화면 저장 실패: {type(error).__name__})", flush=True)
                    shot = None

            triangles = snapshot.get("triangles") or 0
            draw_calls = snapshot.get("drawCalls") or 0
            on_land = snapshot.get("seaUnitsOnLand") or []
            verdict = {
                "initialized": bool(ready),
                "triangleBudget": triangles <= TRIANGLE_BUDGET,
                "drawCallBudget": draw_calls <= DRAW_CALL_BUDGET,
                "noConsoleError": not console_errors and not page_errors,
                "noHttpError": not http_errors,
                "noSeaUnitOnLand": len(on_land) == 0,
                "scenarioMapIdentity": (
                    snapshot.get("mapId") == EXPECTED_MAP_IDS.get(scenario)
                ),
                "scenarioEnemyIdentity": (
                    set(snapshot.get("enemyTypes") or [])
                    == EXPECTED_ENEMY_TYPES.get(scenario, set())
                ),
                "autoBattleControlReady": (
                    snapshot.get("runtimeVersion") == "138"
                    and snapshot.get("autoButton") is not None
                    and (
                        (
                            snapshot["autoButton"]["active"] is True
                            and snapshot["autoButton"]["pressed"] == "true"
                            and snapshot["autoButton"]["disabled"] is False
                        )
                        or snapshot.get("ended") is True
                    )
                ),
                "autoBattleIssuesOrders": (
                    snapshot.get("autoBattle") is not None
                    and snapshot["autoBattle"]["decisions"] > 0
                    and snapshot["autoBattle"]["targetAssignments"] > 0
                    and (
                        (
                            snapshot["autoBattle"]["enabled"] is True
                            and snapshot["autoBattle"]["activeOrders"] > 0
                        )
                        or snapshot.get("ended") is True
                    )
                ),
                "autoBattleOverridesManualOrders": (
                    bool(snapshot.get("manualOrderRecovery"))
                    and all(
                        item.get("autoBattle") is True
                        for item in snapshot["manualOrderRecovery"]
                    )
                ),
                "autoBattleFiresWeapons": (
                    snapshot.get("shots") is not None
                    and snapshot["shots"].get("ally", 0) > 0
                ),
                "googleWheelZoomSynchronized": (
                    google == 0
                    or (
                        snapshot.get("googleStatus") == "ready"
                        and snapshot.get("googleWheelQa") is not None
                        and (
                            snapshot["googleWheelQa"]["atLimit"]["height"] ** 2
                            + snapshot["googleWheelQa"]["atLimit"]["distance"] ** 2
                        ) ** 0.5
                        <= snapshot["googleWheelQa"]["atLimit"]["googleMaximumWorldView"] + 0.02
                        and abs(
                            snapshot["googleWheelQa"]["atLimit"]["height"]
                            - snapshot["googleWheelQa"]["afterExtra"]["height"]
                        ) < 0.02
                        and abs(
                            snapshot["googleWheelQa"]["atLimit"]["distance"]
                            - snapshot["googleWheelQa"]["afterExtra"]["distance"]
                        ) < 0.02
                    )
                ),
                "smartAirAttackRuns": (
                    (
                        snapshot.get("types", {}).get("fighter", 0)
                        + snapshot.get("types", {}).get("bomber", 0)
                    ) == 0
                    or (
                        snapshot.get("autoBattle") is not None
                        and snapshot["autoBattle"].get("airAttackRuns") is not None
                        and snapshot["autoBattle"]["airAttackRuns"]["started"] > 0
                        and snapshot["autoBattle"]["airAttackRuns"]["ingressLegs"] > 0
                        and snapshot["autoBattle"]["airAttackRuns"]["releases"] > 0
                        and snapshot["autoBattle"]["airAttackRuns"]["egressLegs"] > 0
                    )
                ),
                "pickaxeBombsHitOnlyMissionEntrances": (
                    scenario != "pickaxe_mountain"
                    or (
                        snapshot.get("objectiveDestroyed") == 2
                        and snapshot["autoBattle"]["airAttackRuns"]["releases"] == 2
                    )
                ),
            }
            passed = all(verdict.values())
            if not passed:
                failures.append(scenario)

            results[scenario] = {
                "url": url,
                "verdict": verdict,
                "passed": passed,
                "triangles": triangles,
                "trianglePercent": round(triangles / TRIANGLE_BUDGET * 100, 1),
                "drawCalls": draw_calls,
                "snapshot": snapshot,
                "triangleBreakdown": dict(sorted(breakdown.items(), key=lambda kv: -kv[1]["tri"])),
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "httpErrors": http_errors,
                "screenshot": str(shot) if shot else None,
            }

            mark = "PASS" if passed else "FAIL"
            print(f"[{mark}] {scenario:20s} tri={triangles:>7,}/{TRIANGLE_BUDGET:,}"
                  f" ({results[scenario]['trianglePercent']:>5.1f}%)"
                  f"  calls={draw_calls:>2}/{DRAW_CALL_BUDGET}"
                  f"  err={len(console_errors)+len(page_errors)}"
                  f"  onLand={len(on_land)}")
            if not passed:
                top = list(results[scenario]["triangleBreakdown"].items())[:4]
                for key, value in top:
                    print(f"         범인 후보 {key:22s} n={value['count']:2d} tri={value['tri']:,}")
            page.close()
        browser.close()

    record = OUT / f"hormuz-rts-{tag}-scenario-matrix-validation.json"
    record.write_text(json.dumps({
        "budget": {"triangles": TRIANGLE_BUDGET, "drawCalls": DRAW_CALL_BUDGET},
        "viewport": viewport,
        "allPassed": not failures,
        "failed": failures,
        "scenarios": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n기록: {record}")
    if failures:
        print(f"실패 시나리오: {', '.join(failures)}")
        return 1
    print("전 시나리오 통과.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="HORMUZ RTS 시나리오 성능·무결성 게이트")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest", help="출력 파일 이름에 붙일 태그 (예: v84)")
    parser.add_argument("--scenarios", nargs="*", default=ALL_SCENARIOS)
    parser.add_argument("--lang", default="ko", choices=["ko", "en"])
    parser.add_argument("--warmup-ms", type=int, default=18000, help="startBattle 후 계측까지 대기")
    parser.add_argument("--width", type=int, default=2560)
    parser.add_argument("--height", type=int, default=1313)
    parser.add_argument("--google", type=int, default=0, choices=[0, 1])
    parser.add_argument("--speed", type=float, default=8)
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    return run(
        args.base.rstrip("/"),
        args.scenarios,
        args.tag,
        args.lang,
        args.warmup_ms,
        {"width": args.width, "height": args.height},
        args.google,
        args.speed,
    )


if __name__ == "__main__":
    raise SystemExit(main())
