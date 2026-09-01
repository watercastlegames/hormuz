"""assets/models 전 GLB의 삼각형 수를 집계한다.

의존성 없이 GLB 바이너리의 JSON 청크만 읽어 accessor count 를 더한다.
런타임 경로로 원본(-web-v1.glb, 4만 삼각형대)을 잘못 지정했는지 잡아내는 용도.

사용:
    python -X utf8 tools/glb-tri-count.py
    python -X utf8 tools/glb-tri-count.py --used-only
"""

import argparse
import glob
import json
import os
import re
import struct
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(REPO, "assets", "models")


def glb_json(path):
    with open(path, "rb") as handle:
        magic, _version, length = struct.unpack("<III", handle.read(12))
        if magic != 0x46546C67:
            return None
        while handle.tell() < length:
            chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
            data = handle.read(chunk_length)
            if chunk_type == 0x4E4F534A:
                return json.loads(data.decode("utf-8"))
    return None


def tri_count(path):
    document = glb_json(path)
    if not document:
        return None
    accessors = document.get("accessors", [])
    total = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                continue
            if "indices" in primitive:
                total += accessors[primitive["indices"]]["count"] // 3
            else:
                position = primitive.get("attributes", {}).get("POSITION")
                if position is not None:
                    total += accessors[position]["count"] // 3
    return total


def runtime_paths():
    """rts-combat.json 과 rts-combat.js 가 실제 런타임에 쓰는 GLB 경로."""
    used = set()
    data_path = os.path.join(REPO, "assets", "data", "rts-combat.json")
    if os.path.exists(data_path):
        def walk(node):
            if isinstance(node, dict):
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)
            elif isinstance(node, str) and node.endswith(".glb"):
                used.add(node.replace("\\", "/"))
        walk(json.load(open(data_path, encoding="utf-8")))
    source_paths = [
        os.path.join(REPO, "assets", "js", "rts-combat.js"),
        os.path.join(REPO, "assets", "js", "scene", "world.js"),
        os.path.join(REPO, "assets", "js", "scene", "google_map_layer.js"),
    ]
    for source_path in source_paths:
        if not os.path.exists(source_path):
            continue
        source = open(source_path, encoding="utf-8").read()
        used.update(re.findall(r'"(assets/models/[^"]+\.glb)"', source))
    return used


def main():
    parser = argparse.ArgumentParser(description="GLB 삼각형 집계")
    parser.add_argument("--used-only", action="store_true", help="런타임이 실제로 쓰는 모델만 표시")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    used = runtime_paths()
    used_abs = {os.path.normpath(os.path.join(REPO, path)) for path in used}

    rows = []
    for path in glob.glob(os.path.join(MODELS, "**", "*.glb"), recursive=True):
        in_use = os.path.normpath(path) in used_abs
        if args.used_only and not in_use:
            continue
        rows.append((tri_count(path) or 0, os.path.getsize(path), os.path.relpath(path, MODELS), in_use))
    rows.sort(reverse=True)

    print(f"{'tri':>8} {'bytes':>10}  {'런타임':4}  file")
    for triangles, size, name, in_use in rows:
        print(f"{triangles:>8,} {size:>10,}  {'사용' if in_use else '  · ':4}  {name}")

    live = [row for row in rows if row[3]]
    if live:
        print(f"\n런타임 모델 {len(live)}종 · 최대 {max(r[0] for r in live):,} 삼각형")
        heavy = [r for r in live if r[0] > 20_000]
        if heavy:
            print("경고 — 런타임 경로에 2만 삼각형 초과 모델이 있다. 감축본으로 교체를 검토하라:")
            for triangles, _size, name, _ in heavy:
                print(f"  {triangles:>8,}  {name}")

    missing = [path for path in sorted(used) if not os.path.exists(os.path.join(REPO, path))]
    if missing:
        print("\n존재하지 않는 모델을 참조하고 있다:")
        for path in missing:
            print(f"  {path}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
