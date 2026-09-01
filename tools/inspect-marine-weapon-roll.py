"""해병 조준 자세에서 소총의 총열축과 수직 롤축을 계산한다."""

import json

from playwright.sync_api import sync_playwright


URL = (
    "http://127.0.0.1:8080/rts-combat.html"
    "?scenario=large_fleet_battle&google=0&qa=marine-animation&v=roll-inspect"
)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(args=[
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
    ])
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_function(
        "() => !!(window.__HORMUZ_RTS__"
        " && window.__HORMUZ_RTS__.getSnapshot().initialized)",
        timeout=60_000,
    )
    page.wait_for_function(
        "() => document.getElementById('rts-game')"
        "?.dataset.marineAnimationQa === 'aim-fire'",
        timeout=45_000,
    )
    result = page.evaluate(
        """() => {
          const battle = window.__HORMUZ_RTS__.battle;
          const units = [
            battle.units.find(
              (candidate) => candidate.alive
                && candidate.team === 'ally'
                && candidate.type === 'marine'
            ),
            battle.units.find(
              (candidate) => candidate.alive
                && candidate.team === 'enemy'
                && candidate.type === 'enemyMarine'
            )
          ].filter(Boolean);

          return units.map((unit) => {
            const rig = unit.marineRig;
            const rightHand = rig?.rightHand;
            const leftHand = rig?.leftHand;
            const weapon = rig?.weaponAnchor;
            if (!rightHand || !leftHand || !weapon) return null;

            rightHand.updateWorldMatrix(true, false);
            leftHand.updateWorldMatrix(true, false);
            weapon.updateWorldMatrix(true, false);

            const right = rightHand.getWorldPosition(weapon.position.clone());
            const left = leftHand.getWorldPosition(weapon.position.clone());
            const rightQuaternion = rightHand.getWorldQuaternion(
              weapon.quaternion.clone()
            );
            const inverseRight = rightQuaternion.clone().invert();
            const aimWorld = left.clone().sub(right).normalize();
            const aimLocal = aimWorld.clone()
              .applyQuaternion(inverseRight)
              .normalize();

            const upLocal = right.clone().set(0, 1, 0)
              .applyQuaternion(inverseRight);
            upLocal.addScaledVector(aimLocal, -upLocal.dot(aimLocal)).normalize();
            const sideLocal = aimLocal.clone().cross(upLocal).normalize();
            const basis = rightHand.matrixWorld.clone().identity().makeBasis(
              aimLocal,
              upLocal,
              sideLocal
            );
            const correctedQuaternion = weapon.quaternion.clone()
              .setFromRotationMatrix(basis);
            const correctedEuler = weapon.rotation.clone()
              .setFromQuaternion(correctedQuaternion, 'XYZ');

            const gripPoint = weapon.position.clone().fromArray(
              unit.definition.weaponGripPoint || [-0.18, -0.04, 0]
            );
            const correctedOffset = gripPoint.clone()
              .applyQuaternion(correctedQuaternion)
              .multiplyScalar(-1);

            const worldDown = right.clone().set(0, -1, 0);
            const localDown = right.clone().set(0, -1, 0);
            const currentDown = localDown.clone()
              .applyQuaternion(weapon.quaternion)
              .applyQuaternion(rightQuaternion)
              .normalize();
            const correctedDown = localDown.clone()
              .applyQuaternion(correctedQuaternion)
              .applyQuaternion(rightQuaternion)
              .normalize();

            return {
              unit: unit.id,
              rightHand: rightHand.name,
              leftHand: leftHand.name,
              aimLocal: aimLocal.toArray(),
              currentEuler: weapon.rotation.toArray().slice(0, 3),
              correctedEuler: [
                correctedEuler.x,
                correctedEuler.y,
                correctedEuler.z
              ],
              correctedOffset: correctedOffset.toArray(),
              currentDownAlignment: currentDown.dot(worldDown),
              correctedDownAlignment: correctedDown.dot(worldDown)
            };
          });
        }"""
    )
    browser.close()

print(json.dumps(result, ensure_ascii=False, indent=2))
