"""Normalize the mapshaper-clipped Natural Earth land into runtime JSON.

The original implementation clipped a globally connected land ring with a
single-ring Sutherland-Hodgman routine. In the Hormuz bbox that produced a
self-intersecting polygon joining Iran and the Arabian Peninsula across water.

Generate the topology-safe source once with:

  npx --yes mapshaper tools/sources/ne_10m_land.geojson \
    -clip "bbox=48,22,63,31.7" -clean \
    -simplify dp 8% keep-shapes \
    -o format=geojson precision=0.000001 \
    tools/sources/ne_10m_land_hormuz_clipped.geojson

Mapshaper preserves disconnected MultiPolygon parts. This script only flattens
those valid parts into the small runtime schema used by Three.js.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools" / "sources" / "ne_10m_land_hormuz_clipped.geojson"
OUTPUT = ROOT / "assets" / "data" / "coastline.json"
BOUNDS = (48.0, 22.0, 63.0, 31.7)


def polygon_parts(geometry):
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates", [])
    if kind == "Polygon":
        yield coordinates
    elif kind == "MultiPolygon":
        yield from coordinates


def close_ring(ring):
    points = [[round(float(point[0]), 6), round(float(point[1]), 6)] for point in ring]
    if len(points) >= 3 and points[0] != points[-1]:
        points.append(points[0])
    return points


def main():
    collection = json.loads(SOURCE.read_text(encoding="utf-8"))
    polygons = []
    for feature in collection.get("features", []):
        for polygon in polygon_parts(feature.get("geometry", {})):
            if not polygon:
                continue
            outer = close_ring(polygon[0])
            if len(outer) < 4:
                continue
            holes = [close_ring(ring) for ring in polygon[1:] if len(ring) >= 3]
            polygons.append({"outer": outer, "holes": holes})

    output = {
        "source": "Natural Earth 1:10m land; mapshaper topology-safe bbox clip",
        "license": "Public domain",
        "bounds": {
            "west": BOUNDS[0],
            "south": BOUNDS[1],
            "east": BOUNDS[2],
            "north": BOUNDS[3],
        },
        "polygons": polygons,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"{OUTPUT}: {len(polygons)} topology-safe polygons")


if __name__ == "__main__":
    main()
