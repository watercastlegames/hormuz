"""연안 미사일 포대 지상 경비대와 해병 단독 돌격 밸런스를 검증한다.

로컬 서버가 127.0.0.1:8080에서 저장소 루트를 제공하는 상태에서 실행한다.
실제 런타임에서 아군을 해병 2명으로만 편성하고, TEL 4기와 경비 분대 4개가
배치됐는지 확인한 뒤 전투 시간을 빠르게 진행해 해병 단독 승리가 불가능한지
검사한다.
"""

import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "validation"


def wait_ready(page):
    for _ in range(120):
        try:
            if page.evaluate(
                "() => !!(window.__HORMUZ_RTS__ && "
                "window.__HORMUZ_RTS__.getSnapshot().initialized)"
            ):
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False


SETUP_JS = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  for (const type of Object.keys(battle.fleetSelection)) {
    battle.fleetSelection[type] = type === 'marine' ? 2 : 0;
  }
  battle.config.battle.enemyEngageDelaySeconds = 0;
  battle.updateFleetBuilder();
  battle.startBattle();
  battle.paused = true;

  const marines = battle.units.filter(
    (unit) => unit.team === 'ally' && unit.type === 'marine' && unit.alive
  );
  const guards = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'enemyMarine' && unit.alive
  );
  const launchers = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'tel' && unit.alive
  );
  const enemyUnits = [...guards, ...launchers];
  const center = enemyUnits.length
    ? enemyUnits.reduce(
        (sum, unit) => sum.add(unit.position),
        enemyUnits[0].position.clone().set(0, 0, 0)
      ).divideScalar(enemyUnits.length)
    : null;
  if (center) {
    battle.cameraFollowUnit = null;
    battle.cameraFocus.copy(center).setY(0);
    battle.cameraHeight = 30;
    battle.cameraDistance = 26;
    battle.updateCameraPosition(true);
  }
  battle.updateMeshyMarineLodBatches();
  battle.updateMarineWeaponBatches();
  battle.updateHud(true);
  return {
    selection: {...battle.fleetSelection},
    objectiveTargetType: battle.config.battle.objectiveTargetType || null,
    objectiveEnemyCount: battle.config.battle.objectiveEnemyCount,
    marines: marines.map((unit) => unit.callsign),
    guards: guards.map((unit) => unit.callsign),
    launchers: launchers.map((unit) => unit.callsign),
    landPlacementValid: battle.dom.shell.dataset.landPlacementValid,
    marineLodBatches: battle.marineLodBatches.length,
    guardRigs: guards.map((unit) => ({
      id: unit.id,
      meshy: Boolean(unit.marineRig?.meshy),
      strategic: Boolean(unit.marineRig?.strategic),
      mixer: Boolean(unit.marineRig?.mixer),
      walkClip: unit.marineRig?.walkAction?.getClip?.()?.name || null,
      combatClip: unit.marineRig?.combatAction?.getClip?.()?.name || null
    }))
  };
}"""


SIMULATE_JS = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  const marines = battle.units.filter(
    (unit) => unit.team === 'ally' && unit.type === 'marine' && unit.alive
  );
  const guards = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'enemyMarine' && unit.alive
  );
  const launchers = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'tel' && unit.alive
  );
  const center = guards[0]?.position.clone() || launchers[0]?.position.clone();
  if (center) {
    const place = (unit, x, z) => {
      unit.position.set(
        center.x + x,
        unit.placementAltitude ?? unit.definition.altitude ?? 0,
        center.z + z
      );
      unit.group.position.copy(unit.position);
      unit.currentSpeed = 0;
      unit.velocity.set(0, 0, 0);
    };
    marines.forEach((unit, index) => place(unit, (index - 0.5) * 1.2, -18));
    guards.forEach((unit, index) => place(unit, (index - 1.5) * 1.4, -0.3));
    launchers.forEach((unit, index) => place(unit, (index - 1.5) * 2.2, 4.8));
    marines.forEach((unit) => {
      unit.order = {
        type: 'attackMove',
        targetPos: center.clone().add({x: 0, y: 0, z: 5.6})
      };
    });
    guards.forEach((unit, index) => {
      unit.lastHitAt = 0;
      unit.order = {
        type: 'attack',
        targetUnit: marines[index % marines.length]
      };
    });
    launchers.forEach((unit) => {
      unit.order = {type: 'hold'};
    });
  }
  const delta = 0.05;
  const walkSamples = guards.map((unit) => {
    const legBone = unit.marineRig?.bones?.find((bone) => (
      /left.*(upleg|leg|foot)/i.test(bone.name)
      || /mixamorig.*left.*upleg/i.test(bone.name)
    )) || null;
    return {
      unit,
      legBone,
      startPosition: unit.position.clone(),
      startLegQuaternion: legBone?.quaternion.clone() || null
    };
  });
  let guardWalkEvidence = [];
  for (let step = 0; step < 3600 && !battle.ended; step += 1) {
    battle.elapsed += delta;
    battle.remaining = Math.max(
      0,
      battle.config.battle.durationSeconds - battle.elapsed
    );
    battle.updateUnits(delta, battle.elapsed);
    battle.updateProjectiles(delta);
    battle.checkOutcome();
    if (step === 20) {
      guardWalkEvidence = walkSamples.map((sample) => {
        const rig = sample.unit.marineRig;
        const activeAction = rig?.activeAction || null;
        return {
          id: sample.unit.id,
          state: sample.unit.animationState || rig?.state || null,
          statesSeen: [...(sample.unit.animationStatesSeen || [])],
          movedDistance: Number(
            sample.unit.position.distanceTo(sample.startPosition).toFixed(3)
          ),
          activeClip: activeAction?.getClip?.()?.name || null,
          activeClipTime: Number((activeAction?.time || 0).toFixed(3)),
          activeActionPaused: Boolean(activeAction?.paused),
          legBone: sample.legBone?.name || null,
          legQuaternionDelta: sample.legBone && sample.startLegQuaternion
            ? Number(sample.startLegQuaternion.angleTo(sample.legBone.quaternion).toFixed(4))
            : 0
        };
      });
    }
  }
  battle.updateMeshyMarineLodBatches();
  battle.updateMarineWeaponBatches();
  battle.updateHud(true);
  const alive = (team, type) => battle.units.filter(
    (unit) => unit.alive && unit.team === team && (!type || unit.type === type)
  ).length;
  return {
    elapsed: Number(battle.elapsed.toFixed(1)),
    ended: battle.ended,
    success: battle.battleSuccess,
    marinesAlive: alive('ally', 'marine'),
    guardsAlive: alive('enemy', 'enemyMarine'),
    launchersAlive: alive('enemy', 'tel'),
    objectiveDestroyed: battle.getObjectiveDestroyedCount(),
    destroyedEnemies: battle.destroyedEnemies,
    guardWalkEvidence,
    triangles: Number(battle.dom.shell.dataset.triangles || 0),
    drawCalls: Number(battle.dom.shell.dataset.drawCalls || 0)
  };
}"""

COMBINED_ARMS_JS = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  battle.config.battle.enemyEngageDelaySeconds = 0;
  battle.startBattle();
  battle.paused = true;
  const allies = battle.units.filter(
    (unit) => unit.team === 'ally' && unit.alive
  );
  const guards = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'enemyMarine' && unit.alive
  );
  const launchers = battle.units.filter(
    (unit) => unit.team === 'enemy' && unit.type === 'tel' && unit.alive
  );
  const marines = allies.filter((unit) => unit.type === 'marine');
  const aircraft = allies.filter(
    (unit) => unit.type === 'fighter' || unit.type === 'bomber'
  );
  const center = guards[0]?.position.clone() || launchers[0]?.position.clone();
  if (center) {
    const place = (unit, x, z) => {
      unit.position.set(
        center.x + x,
        unit.placementAltitude ?? unit.definition.altitude ?? 0,
        center.z + z
      );
      unit.group.position.copy(unit.position);
      unit.currentSpeed = 0;
      unit.velocity.set(0, 0, 0);
    };
    guards.forEach((unit, index) => place(unit, (index - 1.5) * 1.4, 0));
    launchers.forEach((unit, index) => place(unit, (index - 1.5) * 2.2, 5.5));
    marines.forEach((unit, index) => place(unit, (index - 0.5) * 1.4, -4.6));
    aircraft.forEach((unit, index) => {
      const target = launchers[index % launchers.length];
      place(unit, target.position.x - center.x, target.position.z - center.z - 13);
      const forward = target.position.clone().sub(unit.position).setY(0).normalize();
      unit.forward.copy(forward);
      unit.group.rotation.y = Math.atan2(forward.x, forward.z);
      unit.order = {type: 'attack', targetUnit: target};
    });
    marines.forEach((unit, index) => {
      unit.order = {
        type: 'attack',
        targetUnit: guards[index % guards.length]
      };
    });
    guards.forEach((unit, index) => {
      unit.lastHitAt = 0;
      unit.order = {
        type: 'attack',
        targetUnit: marines[index % marines.length]
      };
    });
    launchers.forEach((unit) => {
      unit.order = {type: 'hold'};
    });
  }
  const delta = 0.05;
  for (let step = 0; step < 5200 && !battle.ended; step += 1) {
    const livingLaunchers = launchers.filter((unit) => unit.alive);
    aircraft.forEach((unit, index) => {
      if (!unit.alive || !livingLaunchers.length) return;
      if (!unit.order?.targetUnit?.alive) {
        unit.order = {
          type: 'attack',
          targetUnit: livingLaunchers[index % livingLaunchers.length]
        };
      }
    });
    const livingGuards = guards.filter((unit) => unit.alive);
    marines.forEach((unit, index) => {
      if (!unit.alive || !livingGuards.length) return;
      if (!unit.order?.targetUnit?.alive) {
        unit.order = {
          type: 'attack',
          targetUnit: livingGuards[index % livingGuards.length]
        };
      }
    });
    battle.elapsed += delta;
    battle.remaining = Math.max(
      0,
      battle.config.battle.durationSeconds - battle.elapsed
    );
    battle.updateUnits(delta, battle.elapsed);
    battle.updateProjectiles(delta);
    battle.checkOutcome();
  }
  const alive = (team, type) => battle.units.filter(
    (unit) => unit.alive && unit.team === team && (!type || unit.type === type)
  ).length;
  return {
    selection: {...battle.fleetSelection},
    elapsed: Number(battle.elapsed.toFixed(1)),
    ended: battle.ended,
    success: battle.battleSuccess,
    alliesAlive: alive('ally'),
    marinesAlive: alive('ally', 'marine'),
    guardsAlive: alive('enemy', 'enemyMarine'),
    launchersAlive: alive('enemy', 'tel'),
    objectiveDestroyed: battle.getObjectiveDestroyedCount(),
    weaponShots: {...battle.weaponShots},
    aircraft: aircraft.map((unit) => ({
      id: unit.id,
      type: unit.type,
      alive: unit.alive,
      shotsFired: unit.shotsFired,
      order: unit.order?.type || null,
      target: unit.order?.targetUnit?.id || null,
      targetAlive: unit.order?.targetUnit?.alive ?? null,
      position: unit.position.toArray(),
      forward: unit.forward.toArray()
    })),
    launcherHp: launchers.map((unit) => ({
      id: unit.id,
      hp: unit.hp,
      maxHp: unit.maxHp,
      alive: unit.alive
    }))
  };
}"""


def run(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    screenshot = OUT / f"hormuz-rts-{tag}-coastal-ground-defense-1920x1080.jpg"
    output = OUT / f"hormuz-rts-{tag}-coastal-ground-defense-validation.json"
    url = (
        f"{base}/rts-combat.html?"
        f"scenario=coastal_battery&google=0&lang=ko&v=119"
    )
    console_errors, page_errors, http_errors = [], [], []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
        ])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on("console", lambda message: (
            console_errors.append(message.text) if message.type == "error" else None
        ))
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("response", lambda response: (
            http_errors.append(f"{response.status} {response.url}")
            if response.status >= 400 else None
        ))
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        ready = wait_ready(page)
        setup = page.evaluate(SETUP_JS) if ready else {}
        if ready:
            page.wait_for_timeout(1000)
            page.screenshot(path=str(screenshot), type="jpeg", quality=88)
        result = page.evaluate(SIMULATE_JS) if ready else {}
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        combined_ready = wait_ready(page)
        combined_result = page.evaluate(COMBINED_ARMS_JS) if combined_ready else {}
        browser.close()

    verdict = {
        "initialized": ready,
        "fourIranianGroundGuardSquads": len(setup.get("guards", [])) == 4,
        "fourTelLaunchers": len(setup.get("launchers", [])) == 4,
        "twoMarineOnlyPackage": setup.get("selection") == {
            "destroyer": 0,
            "fighter": 0,
            "helicopter": 0,
            "carrier": 0,
            "usv": 0,
            "bomber": 0,
            "marine": 2,
        },
        "telOnlyObjectiveCounting": (
            setup.get("objectiveTargetType") == "tel"
            and setup.get("objectiveEnemyCount") == 4
        ),
        "allGroundUnitsPlacedOnLand": setup.get("landPlacementValid") == "true",
        "animatedMeshyGuardRigs": (
            setup.get("marineLodBatches") == 0
            and len(setup.get("guardRigs", [])) == 4
            and all(
                rig.get("meshy")
                and not rig.get("strategic")
                and rig.get("mixer")
                and rig.get("walkClip")
                and rig.get("combatClip")
                for rig in setup.get("guardRigs", [])
            )
        ),
        "guardWalkAnimationMoves": (
            len(result.get("guardWalkEvidence", [])) == 4
            and all(
                "rifle-up-walk" in evidence.get("statesSeen", [])
                and evidence.get("movedDistance", 0) >= 1
                and evidence.get("activeClipTime", 0) > 0.05
                and not evidence.get("activeActionPaused")
                and evidence.get("legQuaternionDelta", 0) > 0.01
                for evidence in result.get("guardWalkEvidence", [])
            )
        ),
        "marineOnlyAssaultFails": (
            result.get("ended") is True
            and result.get("success") is False
            and result.get("marinesAlive") == 0
            and result.get("objectiveDestroyed", 4) < 4
        ),
        "defaultCombinedArmsCanWin": (
            combined_ready
            and combined_result.get("ended") is True
            and combined_result.get("success") is True
            and combined_result.get("objectiveDestroyed") == 4
        ),
        "noRuntimeErrors": not console_errors and not page_errors and not http_errors,
    }
    passed = all(verdict.values())
    payload = {
        "version": tag,
        "url": url,
        "passed": passed,
        "verdict": verdict,
        "setup": setup,
        "simulation": result,
        "combinedArmsSimulation": combined_result,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "httpErrors": http_errors,
        "screenshot": str(screenshot),
    }
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="v119")
    args = parser.parse_args()
    return run(args.base.rstrip("/"), args.tag)


if __name__ == "__main__":
    sys.exit(main())
