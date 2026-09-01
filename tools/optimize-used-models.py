"""실제로 쓰이는 3D 모델을 웹용으로 다시 압축한다.

부하 점검에서 전투 하나가 10.5~19.8MB 를 내려받는 것을 확인했고, 그 대부분이
3D 모델이었다. 모델 용량의 대부분은 모델마다 붙은 2048x2048 JPEG 텍스처 한 장
(약 1MB)이다. 해상도는 그대로 두고 형식만 WebP 로 바꾸면 실측 66~67% 줄어든다.

원칙
  - 코드가 실제로 참조하는 파일만 건드린다. 저장소의 옛 판본은 그대로 둔다.
  - 원본은 assets/meshy-source/pre-webp-v1/ 로 옮겨 놓는다. 되돌릴 수 있어야 한다.
  - 삼각형 수가 달라지면 실패로 본다. 이 작업은 형태를 바꾸는 것이 아니다.
  - 이미 가벼운 파일(기본 300KB 미만)은 건너뛴다. 얻을 게 없다.

실행:
    python tools/optimize-used-models.py --dry-run
    python tools/optimize-used-models.py
"""
import argparse
import json
import pathlib
import shutil
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKUP = ROOT / "assets/meshy-source/pre-webp-v1"
USED = ROOT / "output/validation/used-models.json"
REPORT = ROOT / "output/validation/model-optimize.json"


def triangles(path):
    data = path.read_bytes()
    json_length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + json_length].decode("utf-8"))
    accessors = doc.get("accessors", [])
    total = 0
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if "indices" in primitive:
                total += accessors[primitive["indices"]]["count"] // 3
            elif "POSITION" in primitive.get("attributes", {}):
                total += accessors[primitive["attributes"]["POSITION"]]["count"] // 3
    return total


def position_ranges(path):
    """정점 좌표의 범위. 형태가 뭉개졌는지 보는 데 쓴다."""
    data = path.read_bytes()
    json_length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + json_length].decode("utf-8"))
    accessors = doc.get("accessors", [])
    ranges = []
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index = primitive.get("attributes", {}).get("POSITION")
            if index is None:
                continue
            accessor = accessors[index]
            low, high = accessor.get("min"), accessor.get("max")
            if not low or not high:
                continue
            span = [high[i] - low[i] for i in range(3)]
            scale = max(span) or 1
            ranges.append(tuple(round(v / scale, 3) for v in span))
    return ranges


def run(arguments):
    result = subprocess.run(
        ["npx", "--yes", "@gltf-transform/cli", *arguments],
        capture_output=True, text=True, shell=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[-400:] or result.stdout.strip()[-400:])


def optimize(source, destination):
    """텍스처 형식만 바꾼다. 좌표는 손대지 않는다.

    ★ 두 번 데였다.
      1. `optimize` 명령은 중복 정점 병합까지 해서 삼각형이 달라졌다
         (구축함 41,000 → 40,075).
      2. `meshopt` 는 좌표를 다시 양자화한다. 이미 양자화된 모델에 또 걸면
         형태가 무너진다. 실제로 MH-60R 편대기 몸체의 좌표 범위가
         16316x4333x16383 에서 0x0x32767 로 뭉개져 화면에는 로터만 남았다.
         삼각형 수는 그대로여서 그 검사로는 못 잡았다.
    용량의 대부분은 텍스처다. 텍스처만 바꿔도 충분하다.
    """
    run(["webp", str(source), str(destination)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--min-kb", type=float, default=300,
                        help="이보다 작은 파일은 건너뛴다")
    args = parser.parse_args()

    used = json.loads(USED.read_text(encoding="utf-8"))
    targets = []
    for relative in used:
        path = ROOT / relative
        if not path.exists():
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
    rows, failed = [], []
    before_total = after_total = 0.0
    for relative, path, kb in targets:
        backup_path = BACKUP / pathlib.Path(relative).relative_to("assets/models")
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        if not backup_path.exists():
            shutil.copy2(path, backup_path)
        staged = path.with_suffix(".optimizing.glb")
        try:
            optimize(backup_path, staged)
            before = triangles(backup_path)
            after = triangles(staged)
            if before != after:
                staged.unlink(missing_ok=True)
                raise RuntimeError(f"삼각형이 달라졌다 {before:,} → {after:,}")
            # 삼각형 수가 같아도 좌표가 뭉개질 수 있다. 가로·세로·높이 비율을 본다.
            shape_before = position_ranges(backup_path)
            shape_after = position_ranges(staged)
            if len(shape_before) != len(shape_after) or any(
                any(abs(a - b) > 0.02 for a, b in zip(one, two))
                for one, two in zip(shape_before, shape_after)
            ):
                staged.unlink(missing_ok=True)
                raise RuntimeError(f"형태 비율이 달라졌다 {shape_before} → {shape_after}")
            new_kb = staged.stat().st_size / 1024
            staged.replace(path)
        except Exception as error:  # noqa: BLE001
            staged.unlink(missing_ok=True)
            failed.append((relative, str(error)))
            print(f"  [실패] {relative}\n         {error}")
            continue
        before_total += kb
        after_total += new_kb
        rows.append({"file": relative, "beforeKb": round(kb), "afterKb": round(new_kb),
                     "triangles": before})
        print(f"  {kb:>8.0f}KB → {new_kb:>7.0f}KB  ({(1-new_kb/kb)*100:>4.0f}% 감소)  {relative}")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(
        {"backup": str(BACKUP), "beforeKb": round(before_total),
         "afterKb": round(after_total), "files": rows, "failed": failed},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n합계 {before_total/1024:.1f} MB → {after_total/1024:.1f} MB "
          f"({(1-after_total/max(1,before_total))*100:.0f}% 감소)")
    print(f"원본 보관: {BACKUP}")
    if failed:
        print(f"실패 {len(failed)}건")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
