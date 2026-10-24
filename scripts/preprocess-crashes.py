"""
Preprocess Cambridge crash data into a 40x40 heatmap grid.
Output: public/crash-grid.json

Usage: python3 scripts/preprocess-crashes.py
"""

import csv
import json
import os

LAT_MIN, LAT_MAX = 42.353, 42.403
LON_MIN, LON_MAX = -71.159, -71.069
GRID = 40

def to_cell(lat: float, lon: float) -> tuple[int, int] | None:
    r = (lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * GRID
    c = (lon - LON_MIN) / (LON_MAX - LON_MIN) * GRID
    r, c = int(r), int(c)
    if 0 <= r < GRID and 0 <= c < GRID:
        return r, c
    return None

def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(script_dir)
    csv_path = os.path.join(root, "data", "cambridge-crashes", "data.csv")
    out_path = os.path.join(root, "public", "crash-grid.json")

    all_grid = [0] * (GRID * GRID)
    cyclist_grid = [0] * (GRID * GRID)
    ped_grid = [0] * (GRID * GRID)

    total = skipped = 0
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            lat_s = row.get("latitude", "").strip()
            lon_s = row.get("longitude", "").strip()
            if not lat_s or not lon_s:
                skipped += 1
                continue
            try:
                lat = float(lat_s)
                lon = float(lon_s)
            except ValueError:
                skipped += 1
                continue

            cell = to_cell(lat, lon)
            if cell is None:
                skipped += 1
                continue

            r, c = cell
            idx = r * GRID + c
            all_grid[idx] += 1
            if row.get("cyclist", "").strip() == "1":
                cyclist_grid[idx] += 1
            if row.get("pedestrian", "").strip() == "1":
                ped_grid[idx] += 1

    non_zero = sum(1 for v in all_grid if v > 0)
    print(f"Processed {total} rows, skipped {skipped} without coords")
    print(f"Non-zero cells: {non_zero}/{GRID*GRID}")
    print(f"Max crashes/cell: {max(all_grid)}, max cyclist: {max(cyclist_grid)}, max ped: {max(ped_grid)}")

    result = {
        "grid": GRID,
        "latMin": LAT_MIN,
        "latMax": LAT_MAX,
        "lonMin": LON_MIN,
        "lonMax": LON_MAX,
        "all": all_grid,
        "cyclist": cyclist_grid,
        "pedestrian": ped_grid,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))
    size_kb = os.path.getsize(out_path) / 1024
    print(f"Written to {out_path} ({size_kb:.1f} KB)")

if __name__ == "__main__":
    main()
