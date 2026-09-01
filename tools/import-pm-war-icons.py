"""프로젝트매니저가 모아 둔 war 테마 아이콘을 게임 UI 용으로 들여온다.

원본: D:/soccerstarWebSource/projectManager/assets/football_objects/war (512px PNG, 100종)
받는 곳: assets/images/ui/war-icons/ (128px WebP)

고르는 기준
  이 아이콘들은 두꺼운 외곽선의 2.5D 카툰 그림이고, 게임 화면은 어두운 사실체다.
  3D 장면 위에 얹으면 어울리지 않는다. 그래서 **글자뿐이던 작은 UI 자리**에만 쓴다.
    - 편성 카드: 병과마다 그 역할을 나타내는 장비
    - 결정 카드 분류 배지: 군사·외교·경제·정보 등

  탈것 자체(구축함·항모)는 이 자료에 없다. 대신 그 병과를 상징하는 장비를 쓴다.
  예를 들어 전투기는 조종사 헬멧, 무인수상정은 정찰 드론이다.

실행:
    python tools/import-pm-war-icons.py
"""
import json
import pathlib
import sys

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_ROOT = pathlib.Path(
    "D:/soccerstarWebSource/projectManager/assets/football_objects"
)
TARGET = ROOT / "assets/images/ui/war-icons"
SIZE = 128
QUALITY = 86

# 게임의 자리 → 프로젝트매니저 아이콘
PICKS = {
    # ★ 파일 이름과 실제 그림이 다른 것이 있다. 이름만 믿지 말고 눈으로 확인할 것.
    #   예: pilot_flight_helmet 은 주황색 펀치, surveillance_quadcopter 는 캠핑 버너,
    #   fuel_jerry_can 은 폭발 그림이다. 아래는 테마별 시트를 펼쳐 그림을 확인하고
    #   고른 것이다.

    # ── 편성 카드 (병과의 역할을 보여주는 장비) ──
    "fleet-destroyer": ("war", "naval_captain_binoculars", "구축함 · 함장 쌍안경"),
    "fleet-fighter": ("war", "aircraft_oxygen_mask", "전투기 · 조종사 산소마스크"),
    "fleet-helicopter": ("war", "medical_evacuation_beacon", "헬기 · 구조 신호기"),
    "fleet-carrier": ("war", "aircraft_carrier_deck_helmet", "항공모함 · 갑판 요원 헬멧"),
    "fleet-usv": ("war", "torpedo_guidance_module", "무인수상정 · 수중 유도체"),
    "fleet-bomber": ("war", "laser_target_designator", "폭격기 · 레이저 표적지시기"),
    "fleet-marine": ("war", "tactical_plate_carrier", "해병 · 방탄 조끼"),

    # ── 결정 카드 분류 ──
    "cat-mil": ("war", "tactical_combat_helmet", "군사 · 전투 헬멧"),
    "cat-dip": ("war", "ceasefire_white_flag_folded", "외교 · 백기"),
    "cat-eco": ("war", "armored_vehicle_wheel", "경제 · 유류 드럼"),
    "cat-info": ("war", "field_intelligence_folder_blank", "정보 · 정보 문서철"),
    "cat-asset": ("war", "armored_supply_crate", "자산 · 보급 상자"),
    "cat-roe": ("war", "folded_tactical_map", "교전 수칙 · 작전 지도"),
    "cat-policy": ("war", "service_medal_blank", "정책 · 훈장"),

    # ── 작전 로드맵 (작전별) ──
    "op-convoy_shield": ("war", "steel_barricade_section", "해협 방패 · 차단선"),
    "op-mine_corridor": ("war", "land_mine_detector", "기뢰 회랑 · 기뢰 탐지기"),
    "op-missile_screen": ("war", "thermal_imaging_scope", "미사일 차단막 · 열영상 조준경"),
    "op-tanker_rescue": ("war", "field_stretcher_folded", "라락 구출 · 들것"),
    "op-coastal_battery": ("war", "anti_armor_rocket_launcher", "해안 포대 · 대전차 발사기"),
    "op-pickaxe_mountain": ("war", "command_bunker_key", "곡괭이산 · 벙커 열쇠"),
    "op-large_fleet_battle": ("war", "signal_flare_pistol", "대규모 함대전 · 신호탄"),
    "op-base_retaliation": ("war", "grenade_storage_case", "기지 보복 · 탄약 상자"),
    "op-ceasefire_cover": ("war", "folded_memorial_flag", "정전 엄호 · 접힌 기"),

    # ── 예산·정치 원장 (업무 테마) ──
    "ledger-authorized": ("business", "gold_bar_single", "승인 예산 · 금괴"),
    "ledger-spent": ("business", "cash_drawer_open", "집행액 · 금전함"),
    "ledger-available": ("business", "investment_coin_jar", "가용 예산 · 동전 항아리"),
    "politics-congress": ("business", "bank_building_miniature", "의회 · 의사당"),
    "politics-party": ("business", "handshake_sculpture", "여당 · 악수"),
    "politics-approval": ("business", "best_employee_medal_blank", "국민 지지 · 표창"),

    # ── 결과 화면 ──
    "ending-grade": ("business", "award_trophy_business", "최종 평가 · 트로피"),
    "news-archive": ("business", "global_business_globe", "뉴스 · 지구본"),
}


def main():
    if not SOURCE_ROOT.exists():
        print(f"원본 폴더가 없습니다: {SOURCE_ROOT}")
        return 1
    TARGET.mkdir(parents=True, exist_ok=True)

    rows, missing = [], []
    total = 0
    for name, (theme, slug, label) in PICKS.items():
        source = SOURCE_ROOT / theme / f"{slug}.png"
        if not source.exists():
            missing.append((name, f"{theme}/{slug}"))
            continue
        destination = TARGET / f"{name}.webp"
        with Image.open(source) as image:
            image = image.convert("RGBA")
            # 투명 여백을 잘라내 아이콘이 자리를 꽉 채우게 한다.
            box = image.getbbox()
            if box:
                image = image.crop(box)
            side = max(image.size)
            square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            square.alpha_composite(
                image, ((side - image.width) // 2, (side - image.height) // 2)
            )
            square = square.resize((SIZE, SIZE), Image.LANCZOS)
            square.save(destination, "WEBP", quality=QUALITY, method=6)
        kb = destination.stat().st_size / 1024
        total += kb
        rows.append({"slot": name, "theme": theme, "source": slug,
                     "label": label, "kb": round(kb, 1)})
        print(f"  {name:<24}{kb:>6.1f}KB  ← {theme}/{slug}  ({label})")

    report = ROOT / "output/validation/war-icons.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(
        {"source": str(SOURCE_ROOT), "size": SIZE, "totalKb": round(total, 1),
         "icons": rows, "missing": missing}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"\n{len(rows)}개 · 합계 {total:.0f}KB → {TARGET}")
    if missing:
        print("원본에 없는 것:", missing)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
