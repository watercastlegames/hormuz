"""쓰이는 이미지를 WebP 로 바꿔 내려받는 양을 줄인다.

브리핑·결과 화면 이미지 8장이 1672x941 PNG 로 각각 2~2.6MB 다. 같은 크기의
WebP 는 127~265KB 다. 형식만 바꿔도 대부분이 사라진다. 사장님이 "이미지가 너무
늦게 뜬다"고 하신 것이 이것이다.

원칙
  - 코드가 실제로 참조하는 이미지만 건드린다.
  - 원본은 assets/image-source/pre-webp-v1/ 로 보관한다. 되돌릴 수 있어야 한다.
  - 해상도는 그대로 둔다. 화면에 그대로 크게 뜨는 그림들이다.
  - 파일 이름이 .png 에서 .webp 로 바뀌므로 참조하는 곳을 모두 함께 고친다.
    하나라도 놓치면 그림이 안 뜬다.

실행:
    python tools/optimize-used-images.py --dry-run
    python tools/optimize-used-images.py
"""
import argparse
import json
import pathlib
import shutil
import sys

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUP = ROOT / "assets/image-source/pre-webp-v1"
USED = ROOT / "output/validation/used-images.json"
REPORT = ROOT / "output/validation/image-optimize.json"
QUALITY = 82

SOURCE_GLOBS = ["assets/js/**/*.js", "assets/data/*.json", "*.html", "assets/css/*.css"]


def source_files():
    files = []
    for pattern in SOURCE_GLOBS:
        files.extend(p for p in ROOT.glob(pattern) if "bundle" not in p.name)
    return files


def convert(source, destination):
    with Image.open(source) as image:
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.mode else "RGB")
        image.save(destination, "WEBP", quality=QUALITY, method=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--min-kb", type=float, default=120)
    args = parser.parse_args()

    used = json.loads(USED.read_text(encoding="utf-8"))
    targets = []
    for relative in used:
        path = ROOT / relative
        if not path.exists() or path.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            continue
        kb = path.stat().st_size / 1024
        if kb < args.min_kb:
            continue
        targets.append((relative, path, kb))

    print(f"대상 {len(targets)}개 · 합계 {sum(t[2] for t in targets)/1024:.1f} MB\n")
    if args.dry_run:
        for relative, _path, kb in targets:
            print(f"  {kb:>8.0f}KB  {relative}")
        return 0

    BACKUP.mkdir(parents=True, exist_ok=True)
    files = source_files()
    rows, failed = [], []
    before_total = after_total = 0.0

    for relative, path, kb in targets:
        webp_relative = relative.rsplit(".", 1)[0] + ".webp"
        webp_path = ROOT / webp_relative
        backup_path = BACKUP / pathlib.Path(relative).relative_to("assets/images")
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if not backup_path.exists():
                shutil.copy2(path, backup_path)
            convert(backup_path, webp_path)
            new_kb = webp_path.stat().st_size / 1024
            # 참조를 모두 바꾼다. 하나라도 남으면 없는 파일을 가리키게 된다.
            touched = 0
            for source in files:
                text = source.read_text(encoding="utf-8")
                if relative not in text:
                    continue
                source.write_text(text.replace(relative, webp_relative), encoding="utf-8")
                touched += 1
            path.unlink()
        except Exception as error:  # noqa: BLE001
            failed.append((relative, str(error)))
            print(f"  [실패] {relative}\n         {error}")
            continue
        before_total += kb
        after_total += new_kb
        rows.append({"before": relative, "after": webp_relative,
                     "beforeKb": round(kb), "afterKb": round(new_kb), "files": touched})
        print(f"  {kb:>8.0f}KB → {new_kb:>7.0f}KB  ({(1-new_kb/kb)*100:>4.0f}% 감소) "
              f"참조 {touched}곳  {webp_relative}")

    # 남은 참조가 없는지 확인한다.
    leftovers = []
    for relative, _path, _kb in targets:
        for source in files:
            if relative in source.read_text(encoding="utf-8"):
                leftovers.append((relative, str(source.relative_to(ROOT))))

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(
        {"backup": str(BACKUP), "quality": QUALITY,
         "beforeKb": round(before_total), "afterKb": round(after_total),
         "files": rows, "failed": failed, "leftoverReferences": leftovers},
        ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n합계 {before_total/1024:.1f} MB → {after_total/1024:.1f} MB "
          f"({(1-after_total/max(1,before_total))*100:.0f}% 감소)")
    print(f"원본 보관: {BACKUP}")
    if leftovers:
        print(f"★ 옛 경로가 남아 있다 {len(leftovers)}곳: {leftovers[:3]}")
        return 1
    if failed:
        print(f"실패 {len(failed)}건")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
