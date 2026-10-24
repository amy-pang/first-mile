"""
Preprocess the Cambridge Street Centerline GeoJSON into a compact polyline file
for the crash map. Output: public/streets.json

Source: data/Street_Centerline_20261024.geojson (City of Cambridge open data).
The raw file is ~2 MB with 2,628 MultiLineString features and lots of unused
properties. This reduces it to just the geometry (clipped to the map's bounding
box, lightly simplified) plus a label and a major/minor flag.

Output shape:
  {
    "roads": [
      { "label": "Massachusetts Ave", "major": true, "pts": [[lon, lat], ...] },
      ...
    ]
  }

Usage: python3 scripts/preprocess-streets.py
"""

import json
import os

# Map view bounding box (matches the crash grid and drawCityMap).
LAT_MIN, LAT_MAX = 42.353, 42.403
LON_MIN, LON_MAX = -71.159, -71.069

# Keep a point if it deviates from the straight line between its neighbours by
# more than this (in degrees ~ a few metres). Thins dense vertices without
# visibly changing the shape at map scale.
SIMPLIFY_EPS = 0.00008


def in_bounds(lon: float, lat: float) -> bool:
    return LON_MIN <= lon <= LON_MAX and LAT_MIN <= lat <= LAT_MAX


def perp_dist(p, a, b) -> float:
    """Perpendicular distance from point p to segment a-b (degrees)."""
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def simplify(points, eps=SIMPLIFY_EPS):
    """Iterative Douglas-Peucker simplification."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        dmax, idx = 0.0, -1
        for i in range(lo + 1, hi):
            d = perp_dist(points[i], points[lo], points[hi])
            if d > dmax:
                dmax, idx = d, i
        if idx != -1 and dmax > eps:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [p for p, k in zip(points, keep) if k]


def round_pt(p):
    return [round(p[0], 5), round(p[1], 5)]


def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(script_dir)
    src = os.path.join(root, "data", "Street_Centerline_20261024.geojson")
    out_path = os.path.join(root, "public", "streets.json")

    with open(src, encoding="utf-8") as f:
        gj = json.load(f)

    roads = []
    kept = dropped = 0
    for feat in gj.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        if gtype == "MultiLineString":
            lines = geom.get("coordinates", [])
        elif gtype == "LineString":
            lines = [geom.get("coordinates", [])]
        else:
            continue

        # majorroad: 1 or 2 => arterial/major; 0 => local street.
        major = str(props.get("majorroad")) in ("1", "2")
        label = (props.get("street") or props.get("label") or "").strip() or None

        for line in lines:
            # Clip: keep the line only if at least one vertex is in view, then
            # keep the vertices that are in bounds (plus immediate neighbours so
            # roads reach the edge cleanly).
            pts = [[float(x), float(y)] for x, y in line]
            if not any(in_bounds(x, y) for x, y in pts):
                dropped += 1
                continue
            simp = simplify(pts)
            if len(simp) < 2:
                continue
            roads.append({
                "label": label if major else None,  # only label arterials to avoid clutter
                "major": major,
                "pts": [round_pt(p) for p in simp],
            })
            kept += 1

    out = {"roads": roads}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    majors = sum(1 for r in roads if r["major"])
    print(f"kept {kept} polylines ({majors} major), dropped {dropped} out-of-view")
    print(f"wrote {out_path} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
