"""전투에 나오는 모든 객체를 하나씩 찍어 눈으로 확인할 수 있게 만든다.

왜 필요한가
-----------
"포대 경비 분대가 네모난 로봇처럼 보인다"는 신고가 있었다. 원인은 증원 유닛을
임시 도형으로 그리게 만든 회귀였는데, 그런 것은 숫자 검사로는 안 잡힌다.
삼각형 예산도 통과하고 콘솔 오류도 없다. 눈으로 봐야만 보인다.

그래서 유닛 종류마다 카메라를 붙여 한 장씩 찍고, 모델 파일이 실제로 있는지와
함께 한 문서에 모은다.

실행:
    python tools/run-quiet.py python tools/audit-combat-units.py
"""
import base64
import html
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path("D:/soccerstarWebSource/GameCreator/hormuz")
SHOTS = ROOT / "output/validation/units"
TARGET = ROOT / "docs/hormuz-combat-units-2026-08-03.html"
BASE = "http://127.0.0.1:8080/rts-combat.html"

# 유닛 종류를 모두 만나려면 이 시나리오들을 다 열어야 한다.
SCENARIOS = [
    "convoy_shield", "tanker_rescue", "mine_corridor", "missile_screen",
    "coastal_battery", "pickaxe_mountain", "large_fleet_battle",
]

TEAM_KO = {"ally": "아군", "enemy": "적군", "civilian": "민간"}
DOMAIN_KO = {"sea": "해상", "air": "공중", "land": "지상"}

DUMP = """() => {
  const b = window.__HORMUZ_RTS__.battle;
  const seen = {};
  b.units.forEach(u => { if (!seen[u.type]) seen[u.type] = u.team; });
  const out = {};
  for (const [type, team] of Object.entries(seen)) {
    const def = b.config.unitTypes[type] || {};
    out[type] = {
      name: def.name || type, nameEn: def.nameEn || '', team,
      domain: def.domain || '', model: def.model || null,
      formationModel: def.formationModel || null,
      strategicModel: def.strategicModel || null,
      heroModel: Boolean(def.heroModel), desiredSize: def.desiredSize || null,
      maxHp: def.maxHp, damage: def.damage, weapon: def.weapon || null
    };
  }
  return out;
}"""

# 카메라를 유닛 앞에 붙이고 한 장 그린다. 전투는 멈춰 둔다.
SHOOT = """(type) => {
  const b = window.__HORMUZ_RTS__.battle;
  const unit = b.units.find(u => u.type === type && u.alive);
  if (!unit || !unit.group) return null;
  b.paused = true;

  /* 유닛의 실제 크기를 재서 화면에 꽉 차게 잡는다.
     정의된 desiredSize 로 거리를 잡으면 지상 유닛은 카메라가 지형에 박힌다.
     번들이 THREE 를 전역에 두지 않으므로 정점을 직접 옮겨 경계를 구한다. */
  let minX=1e9,minY=1e9,minZ=1e9,maxX=-1e9,maxY=-1e9,maxZ=-1e9;
  let tri=0, meshes=0;
  unit.group.updateWorldMatrix(true, true);
  unit.group.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    meshes += 1;
    const g = o.geometry; if (!g || !g.attributes || !g.attributes.position) return;
    const p = g.attributes.position;
    const n = g.index ? g.index.count / 3 : p.count / 3;
    tri += n * (o.isInstancedMesh ? o.count : 1);
    const m = o.matrixWorld.elements;
    const step = Math.max(1, Math.floor(p.count / 400));
    for (let i = 0; i < p.count; i += step) {
      const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
      const wx = m[0]*x + m[4]*y + m[8]*z + m[12];
      const wy = m[1]*x + m[5]*y + m[9]*z + m[13];
      const wz = m[2]*x + m[6]*y + m[10]*z + m[14];
      if (wx<minX) minX=wx; if (wx>maxX) maxX=wx;
      if (wy<minY) minY=wy; if (wy>maxY) maxY=wy;
      if (wz<minZ) minZ=wz; if (wz>maxZ) maxZ=wz;
    }
  });
  if (minX > maxX) return null;
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
  const sx=maxX-minX, sy=maxY-minY, sz=maxZ-minZ;
  const radius = Math.max(0.6, Math.sqrt(sx*sx+sy*sy+sz*sz) * 0.5);
  const dist = radius * 2.6;
  b.camera.position.set(cx + dist*0.62, cy + Math.max(dist*0.48, radius*0.8), cz + dist*0.62);
  b.camera.near = Math.max(0.05, radius * 0.04);
  b.camera.far = Math.max(500, dist * 10);
  b.camera.lookAt(cx, cy, cz);
  b.camera.updateProjectionMatrix();
  b.renderer.render(b.scene, b.camera);
  return {
    image: b.renderer.domElement.toDataURL('image/jpeg', 0.85),
    tri: Math.round(tri), meshes,
    size: [+sx.toFixed(1), +sy.toFixed(1), +sz.toFixed(1)]
  };
}"""


def collect():
    units, shots = {}, {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        page = browser.new_page(viewport={"width": 720, "height": 460})
        for scenario in SCENARIOS:
            page.goto(f"{BASE}?scenario={scenario}&lang=ko&google=0&difficulty=5&hud=0",
                      wait_until="load", timeout=240000)
            page.wait_for_function(
                "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=240000
            )
            page.evaluate("() => window.__HORMUZ_RTS__.start()")
            page.wait_for_timeout(900)
            found = page.evaluate(DUMP)
            for unit_type, info in found.items():
                if unit_type in units:
                    units[unit_type]["scenarios"].append(scenario)
                    continue
                info["scenarios"] = [scenario]
                units[unit_type] = info
                stat = page.evaluate(SHOOT, unit_type)
                if not stat:
                    continue
                image = stat.pop("image", None)
                info.update(stat)
                if image:
                    SHOTS.mkdir(parents=True, exist_ok=True)
                    path = SHOTS / f"{unit_type}.jpg"
                    path.write_bytes(base64.b64decode(image.split(",", 1)[1]))
                    shots[unit_type] = path
                print(f"  찍음 {unit_type:<16} 삼각형 {stat['tri']:>7,}  메시 {stat['meshes']}",
                      flush=True)
        browser.close()
    return units, shots


def verdict(info):
    """모델이 제대로 붙었는지 판정."""
    if not info.get("model"):
        return "없음", "모델 파일이 지정돼 있지 않다. 임시 도형으로 그려진다."
    if not (ROOT / info["model"]).exists():
        return "깨짐", "지정된 모델 파일이 저장소에 없다."
    tri = info.get("tri") or 0
    if tri < 1500 or (info.get("meshes") or 0) <= 2:
        return "의심", (f"삼각형 {tri:,}개 · 메시 {info.get('meshes')}개. "
                       "실제 모델 대신 임시 도형으로 그려지고 있을 가능성이 높다.")
    return "정상", ""


def build(units, shots):
    rows = []
    for unit_type, info in sorted(units.items(), key=lambda kv: (kv[1]["team"], kv[0])):
        mark, note = verdict(info)
        image = ""
        path = shots.get(unit_type)
        if path and path.exists():
            image = ("data:image/jpeg;base64,"
                     + base64.b64encode(path.read_bytes()).decode("ascii"))
        rows.append((unit_type, info, mark, note, image))

    bad = [r for r in rows if r[2] != "정상"]
    cards = "".join(f"""
      <article class="unit {'bad' if mark != '정상' else ''}">
        {f'<img src="{image}" alt="{html.escape(info["name"])}" loading="lazy">' if image
         else '<div class="noshot">화면 없음</div>'}
        <div class="meta">
          <span class="tag {info['team']}">{TEAM_KO.get(info['team'], info['team'])}
            · {DOMAIN_KO.get(info['domain'], info['domain'])}</span>
          <h3>{html.escape(info['name'])}</h3>
          <p class="id">{html.escape(unit_type)}</p>
          <dl>
            <dt>모델</dt><dd>{html.escape(info['model'] or '(지정 없음)')}</dd>
            <dt>삼각형</dt><dd>{(info.get('tri') or 0):,} · 메시 {info.get('meshes', 0)}</dd>
            <dt>체력·화력</dt><dd>{info.get('maxHp')} · {info.get('damage')}</dd>
            <dt>등장</dt><dd>{html.escape(', '.join(sorted(set(info['scenarios']))))}</dd>
          </dl>
          <p class="verdict {mark}">{mark}{f' — {html.escape(note)}' if note else ''}</p>
        </div>
      </article>""" for unit_type, info, mark, note, image in rows)

    page = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>전투 객체 전수조사 (2026-08-03)</title>
<style>
  :root {{ --bg:#04090e; --panel:#0a1620; --line:rgba(100,228,238,.22);
    --cyan:#64e4ee; --white:#eaf7fa; --muted:#7f9aa2; --red:#ff6b60; --green:#55e6a5; --amber:#ffc766; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:0 20px 80px; color:var(--white); background:var(--bg);
    font:400 16px/1.7 "Pretendard Variable","Pretendard","Segoe UI","Malgun Gothic",sans-serif; }}
  .wrap {{ max-width:1180px; margin:0 auto; }}
  header.top {{ padding:44px 0 20px; border-bottom:1px solid var(--line); }}
  h1 {{ margin:0 0 10px; font-size:28px; }}
  h1 small {{ display:block; margin-top:8px; color:var(--muted); font-size:15px; font-weight:400; }}
  h2 {{ margin:40px 0 12px; padding-bottom:8px; font-size:20px; color:var(--cyan);
    border-bottom:1px solid var(--line); }}
  p {{ margin:0 0 12px; }} .lead {{ color:#cfe6ea; }} .dim {{ color:var(--muted); font-size:14px; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:18px; }}
  .unit {{ border:1px solid var(--line); background:var(--panel); overflow:hidden; }}
  .unit.bad {{ border-color:rgba(255,107,96,.55); }}
  .unit img {{ display:block; width:100%; height:auto; background:#000; }}
  .noshot {{ padding:60px 0; text-align:center; color:var(--muted); background:#061019; }}
  .meta {{ padding:14px 16px 16px; }}
  .tag {{ display:inline-block; padding:2px 9px; margin-bottom:7px; font-size:12px;
    font-weight:800; color:#04222a; background:var(--cyan); }}
  .tag.enemy {{ background:#ff9a90; }} .tag.civilian {{ background:#ffe08a; }}
  h3 {{ margin:0 0 2px; font-size:17px; }}
  .id {{ margin:0 0 10px; color:var(--muted); font-size:13px; font-family:ui-monospace,monospace; }}
  dl {{ display:grid; grid-template-columns:auto 1fr; gap:4px 10px; margin:0 0 10px; font-size:13.5px; }}
  dt {{ color:var(--cyan); }} dd {{ margin:0; color:#cfe6ea; word-break:break-all; }}
  .verdict {{ margin:0; padding:8px 10px; font-size:13.5px; }}
  .verdict.정상 {{ color:#ccfff0; background:rgba(85,230,165,.08); border-left:3px solid var(--green); }}
  .verdict.없음, .verdict.깨짐 {{ color:#ffd9d5; background:rgba(255,107,96,.09); border-left:3px solid var(--red); }}
  .verdict.의심 {{ color:#ffeccf; background:rgba(255,199,102,.09); border-left:3px solid var(--amber); }}
  .foot {{ margin-top:46px; padding-top:18px; color:var(--muted); font-size:14px; border-top:1px solid var(--line); }}
</style></head><body><div class="wrap">
<header class="top">
  <h1>전투 객체 전수조사
    <small>HORMUZ · 2026-08-03 · 전투 유닛 {len(rows)}종 · 문제 {len(bad)}건</small></h1>
  <p class="lead">전투에 나오는 객체를 하나씩 카메라로 잡아 찍었다. 모델 파일이
  지정돼 있는지, 그 파일이 실제로 있는지, 그리고 삼각형 수가 임시 도형 수준은
  아닌지를 함께 본다.</p>
</header>
<h2>객체 {len(rows)}종</h2>
<div class="grid">{cards}</div>
<div class="foot">{TARGET}<br>공개 서버: https://sidak.kr/autodev/GameCreator/hormuz/</div>
</div></body></html>"""
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(page, encoding="utf-8")
    return rows, bad


def main():
    print("전투 객체를 찍는 중…", flush=True)
    units, shots = collect()
    rows, bad = build(units, shots)
    print(f"\n{'유닛':<16}{'진영':<7}{'삼각형':>9}  판정")
    for unit_type, info, mark, note, _ in rows:
        print(f"{unit_type:<16}{TEAM_KO.get(info['team'], ''):<7}"
              f"{(info.get('tri') or 0):>9,}  {mark}{(' — ' + note) if note else ''}")
    print(f"\n문서: {TARGET}")
    print(f"문제 {len(bad)}건" if bad else "이상 없음")


if __name__ == "__main__":
    main()
