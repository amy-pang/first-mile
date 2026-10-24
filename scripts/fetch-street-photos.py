"""
Fetch real street-level photos along the Harvard -> MIT route from Mapillary (CC-BY-SA 4.0).

    python3 scripts/fetch-street-photos.py

Needs a free Mapillary client access token (https://www.mapillary.com/dashboard/developers) in the environment or in
.env.local as MAPILLARY_TOKEN=... . The token is only sent to graph.mapillary.com and never written anywhere.

For every 8 m of public/real-route.json it picks the closest photo that was taken facing our direction of travel,
downloads it to public/street/<id>.jpg, and writes public/street-route.json listing each frame with its distance
along the route, capture date and photographer (Mapillary's licence requires that attribution).
"""
import json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTE = os.path.join(ROOT, 'public', 'real-route.json')
OUT_DIR = os.path.join(ROOT, 'public', 'street')
MANIFEST = os.path.join(ROOT, 'public', 'street-route.json')
API = 'https://graph.mapillary.com/images'
STEP = 8          # metres between frames
MAX_DIST = 12     # metres from the route centreline
MAX_TURN = 40     # degrees between the photo's heading and our direction of travel


def token():
    t = os.environ.get('MAPILLARY_TOKEN')
    if not t:
        env = os.path.join(ROOT, '.env.local')
        if os.path.exists(env):
            for line in open(env):
                k, _, v = line.strip().partition('=')
                if k.strip() == 'MAPILLARY_TOKEN':
                    t = v.strip().strip('"').strip("'")
    if not t:
        sys.exit('MAPILLARY_TOKEN not set (environment or .env.local).')
    return t


def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'FirstMile-hackathon/0.1'}), timeout=60) as r:
                return r.read()
        except Exception as e:  # rate limits and flaky connections: back off and retry
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def main():
    tok = token()
    route = json.load(open(ROUTE))
    lat0, lon0 = route['origin']
    kx = 111320 * math.cos(math.radians(lat0))
    to_ll = lambda x, y: (lat0 - y / 110540, lon0 + x / kx)
    to_xy = lambda lat, lon: ((lon - lon0) * kx, -(lat - lat0) * 110540)
    pts = route['pts']
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(a, b))

    # 1. Every photo in small boxes along the route.
    photos = {}
    fields = 'id,computed_geometry,computed_compass_angle,captured_at,is_pano,creator,thumb_1024_url,quality_score'
    for i in range(0, len(pts), 60):
        x, y = pts[i]
        la1, lo1 = to_ll(x - 60, y + 60)
        la2, lo2 = to_ll(x + 60, y - 60)
        q = urllib.parse.urlencode({'access_token': tok, 'fields': fields, 'limit': 2000,
                                    'bbox': f'{min(lo1, lo2)},{min(la1, la2)},{max(lo1, lo2)},{max(la1, la2)}'})
        for p in json.loads(get(f'{API}?{q}')).get('data', []):
            if p.get('computed_geometry') and p.get('computed_compass_angle') is not None:
                photos[p['id']] = p
        print(f'\rsearching {cum[i]:.0f}/{cum[-1]:.0f} m: {len(photos)} photos', end='', flush=True)
    print()
    cand = []
    for p in photos.values():
        lon, lat = p['computed_geometry']['coordinates']
        cand.append((to_xy(lat, lon), p))

    # 2. For each frame position, the best photo: close to the line, facing our way, recent, not a panorama.
    frames = []
    s = 0.0
    j = 0
    while s < cum[-1]:
        while j < len(cum) - 2 and cum[j + 1] < s:
            j += 1
        (ax, ay), (bx, by) = pts[j], pts[min(j + 1, len(pts) - 1)]
        t = (s - cum[j]) / max(1e-6, cum[j + 1] - cum[j])
        px, py = ax + (bx - ax) * t, ay + (by - ay) * t
        heading = (90 + math.degrees(math.atan2(by - ay, bx - ax))) % 360  # compass: 0 north, clockwise
        best = None
        for (qx, qy), p in cand:
            d = math.hypot(qx - px, qy - py)
            if d > MAX_DIST:
                continue
            turn = (p['computed_compass_angle'] - heading + 540) % 360 - 180
            if abs(turn) > MAX_TURN and not p.get('is_pano'):
                continue
            age = (time.time() - p['captured_at'] / 1000) / (365 * 86400)
            # Daylight and sharp photos read best through a windshield (Boston is UTC-4/-5).
            hour = (time.gmtime(p['captured_at'] / 1000).tm_hour - 5) % 24
            night = 8 if hour < 7 or hour >= 19 else 0
            blur = (1 - p.get('quality_score', 0.6)) * 8
            score = d + abs(turn) / 6 + age * 1.5 + (14 if p.get('is_pano') else 0) + night + blur
            if best is None or score < best[0]:
                best = (score, p, turn)
        if best:
            _, p, turn = best
            frames.append({'s': round(s, 1), 'id': p['id'], 'pano': bool(p.get('is_pano')), 'turn': round(turn, 1),
                           'date': time.strftime('%Y-%m-%d', time.gmtime(p['captured_at'] / 1000)),
                           'by': (p.get('creator') or {}).get('username', 'Mapillary contributor'),
                           'url': p.get('thumb_1024_url')})
        s += STEP
    covered = len(frames) * STEP / cum[-1]
    print(f'{len(frames)} frames, about {covered:.0%} of the route has a photo within {MAX_DIST} m')

    # 3. Download each distinct photo once.
    os.makedirs(OUT_DIR, exist_ok=True)
    ids = {f['id']: f['url'] for f in frames}
    for k, (pid, url) in enumerate(ids.items()):
        path = os.path.join(OUT_DIR, f'{pid}.jpg')
        if not os.path.exists(path) and url:
            open(path, 'wb').write(get(url))
        print(f'\rdownloading {k + 1}/{len(ids)}', end='', flush=True)
    print()
    keep = {f'{pid}.jpg' for pid in ids}
    for name in os.listdir(OUT_DIR):
        if name.endswith('.jpg') and name not in keep:
            os.remove(os.path.join(OUT_DIR, name))
    for f in frames:
        del f['url']
    json.dump({'attribution': 'Street photos © Mapillary contributors, CC-BY-SA 4.0', 'step': STEP, 'frames': frames},
              open(MANIFEST, 'w'), separators=(',', ':'))
    print('wrote', MANIFEST)


if __name__ == '__main__':
    main()
