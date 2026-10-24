"""
Build public/real-route.json: the real drive from Harvard's Lehman Hall to MIT Sloan, from OpenStreetMap.

    python3 scripts/build-real-route.py          # downloads OSM tiles into data/osm-route/ on first run

Everything in the output comes from OSM tags (ODbL, (c) OpenStreetMap contributors): the route itself (shortest
legal drive, respecting one-way streets), lane counts, speed limits, bike lanes, traffic signals, stop signs,
crosswalks, the railroad crossing, nearby streets and building footprints. Coordinates are metres from ORIGIN,
x east and y south (the simulator's convention).
"""
import glob, heapq, json, math, os, sys, time, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'osm-route')
OUT = os.path.join(ROOT, 'public', 'real-route.json')
START = (42.37296, -71.11882, 'Lehman Hall, Harvard Yard')
GOAL = (42.36145, -71.08263, 'MIT Sloan School of Management, 100 Main St')
ORIGIN = (42.3675, -71.1005)
UA = 'FirstMile-hackathon/0.1 (driving-practice prototype)'
DRIVE = {'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'primary_link',
         'secondary_link', 'tertiary_link', 'living_street'}
LANE_W = 3.2
BIKE_W = 1.6


def fetch_tiles():
    os.makedirs(CACHE, exist_ok=True)
    n = 0
    for lat in (42.358, 42.364, 42.370):
        for lon in (-71.124, -71.1155, -71.107, -71.0985, -71.090, -71.0815):
            n += 1
            path = os.path.join(CACHE, f't{n}.osm')
            if os.path.exists(path):
                continue
            url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lon},{lat},{lon + 0.0085:.4f},{lat + 0.006:.4f}'
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
                f.write(r.read())
            print('downloaded', path)
            time.sleep(1)


def load():
    nodes, ways = {}, {}
    for f in sorted(glob.glob(os.path.join(CACHE, 't*.osm'))):
        for el in ET.parse(f).getroot():
            if el.tag == 'node':
                i = int(el.get('id'))
                if i not in nodes:
                    nodes[i] = (float(el.get('lat')), float(el.get('lon')), {t.get('k'): t.get('v') for t in el.findall('tag')})
            elif el.tag == 'way':
                i = int(el.get('id'))
                if i not in ways:
                    ways[i] = ([int(x.get('ref')) for x in el.findall('nd')], {t.get('k'): t.get('v') for t in el.findall('tag')})
    return nodes, ways


def to_xy(lat, lon):
    return ((lon - ORIGIN[1]) * 111320 * math.cos(math.radians(ORIGIN[0])), -(lat - ORIGIN[0]) * 110540)


def drivable(tg):
    return tg.get('highway') in DRIVE and tg.get('access') not in ('no', 'private') and tg.get('motor_vehicle') != 'no'


def route(nodes, ways, xy):
    graph = {}
    for wid, (nds, tg) in ways.items():
        if not drivable(tg):
            continue
        ow = tg.get('oneway')
        fwd = ow != '-1'
        bwd = ow in ('-1', 'no', None) and not (tg.get('junction') == 'roundabout' and ow is None)
        for a, b in zip(nds, nds[1:]):
            if a not in xy or b not in xy:
                continue
            d = math.dist(xy[a], xy[b])
            # Prefer main roads, the way a navigation app would.
            hw = tg.get('highway')
            cost = d * (1.0 if hw in ('primary', 'secondary', 'trunk') else 1.25 if hw == 'tertiary' else 1.8)
            if fwd:
                graph.setdefault(a, []).append((b, cost, wid))
            if bwd:
                graph.setdefault(b, []).append((a, cost, wid))

    def nearest(lat, lon):
        p = to_xy(lat, lon)
        return min(graph, key=lambda n: math.dist(xy[n], p))

    s, g = nearest(*START[:2]), nearest(*GOAL[:2])
    dist, prev, pq = {s: 0}, {}, [(0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == g:
            break
        if d > dist[u]:
            continue
        for v, c, wid in graph.get(u, []):
            if d + c < dist.get(v, 1e18):
                dist[v] = d + c
                prev[v] = (u, wid)
                heapq.heappush(pq, (d + c, v))
    path, wpath = [g], []
    while path[-1] != s:
        u, wid = prev[path[-1]]
        path.append(u)
        wpath.append(wid)
    return path[::-1], wpath[::-1]


def mph(v):
    if not v:
        return None
    try:
        return int(v.split()[0])
    except ValueError:
        return None


def lane_attrs(tg, fwd):
    """Lanes and bike lane for the direction we drive, from a way's tags."""
    oneway = tg.get('oneway') in ('yes', '1', 'true', '-1')
    total = int(tg.get('lanes', '2' if not oneway else '1').split(';')[0])
    if oneway:
        mine, opp = total, 0
    else:
        f, b = tg.get('lanes:forward'), tg.get('lanes:backward')
        if f and b:
            mine, opp = (int(f), int(b)) if fwd else (int(b), int(f))
        else:
            mine = max(1, total // 2)
            opp = max(1, total - mine)
    side = 'right' if fwd else 'left'
    bike = tg.get(f'cycleway:{side}') or tg.get('cycleway:both') or tg.get('cycleway')
    bike = {'lane': 'lane', 'track': 'track', 'share_busway': 'bus', 'separate': 'track'}.get(bike)
    turns = tg.get('turn:lanes' if oneway else ('turn:lanes:forward' if fwd else 'turn:lanes:backward'))
    return {'mine': mine, 'opp': opp, 'oneway': oneway, 'bike': bike, 'turns': turns}


def main():
    fetch_tiles()
    nodes, ways = load()
    xy = {i: to_xy(la, lo) for i, (la, lo, _) in nodes.items()}
    rnodes, rways = route(nodes, ways, xy)

    # Per-edge attributes in our direction of travel.
    edges = []
    last_mph = 20
    for k, wid in enumerate(rways):
        nds, tg = ways[wid]
        a, b = rnodes[k], rnodes[k + 1]
        fwd = nds.index(b) > nds.index(a)
        sp = mph(tg.get('maxspeed')) or last_mph
        last_mph = sp
        edges.append({'way': wid, 'name': tg.get('name', ''), 'ref': tg.get('ref'), 'mph': sp, **lane_attrs(tg, fwd)})

    # Dense, gently smoothed centreline (1 m spacing) so turns become drivable curves.
    raw, edge_of = [], []
    for k in range(len(rnodes) - 1):
        (ax, ay), (bx, by) = xy[rnodes[k]], xy[rnodes[k + 1]]
        n = max(1, int(math.dist((ax, ay), (bx, by))))
        for j in range(n):
            t = j / n
            raw.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            edge_of.append(k)
    raw.append(xy[rnodes[-1]])
    edge_of.append(len(edges) - 1)
    W = 9
    pts = []
    for i in range(len(raw)):
        lo, hi = max(0, i - W), min(len(raw), i + W + 1)
        if i < W or i > len(raw) - 1 - W:
            pts.append(raw[i])
        else:
            pts.append((sum(p[0] for p in raw[lo:hi]) / (hi - lo), sum(p[1] for p in raw[lo:hi]) / (hi - lo)))
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(a, b))

    def s_of(p, near_i):
        lo, hi = max(0, near_i - 40), min(len(pts), near_i + 40)
        j = min(range(lo, hi), key=lambda i: math.dist(pts[i], p))
        return cum[j]

    node_i = {}
    i = 0
    for k, n in enumerate(rnodes):
        while i < len(raw) - 1 and edge_of[i] < k:
            i += 1
        node_i[n] = i

    # Segments: runs of identical driving attributes.
    segs = []
    for i, k in enumerate(edge_of):
        e = edges[k]
        key = (e['name'], e['mph'], e['mine'], e['opp'], e['oneway'], e['bike'])
        if segs and segs[-1]['key'] == key:
            segs[-1]['s1'] = round(cum[i], 1)
        else:
            segs.append({'key': key, 's0': round(cum[i], 1), 's1': round(cum[i], 1), 'name': e['name'], 'ref': e['ref'],
                         'mph': e['mph'], 'lanes': e['mine'], 'opp': e['opp'], 'oneway': e['oneway'], 'bike': e['bike'],
                         'turns': e['turns']})
    for sg in segs:
        del sg['key']

    # Events along the route.
    events = []
    on_route = []
    for k, n in enumerate(rnodes):
        tg = nodes[n][2]
        s = s_of(xy[n], node_i[n])
        if tg.get('highway') == 'traffic_signals':
            d = tg.get('traffic_signals:direction')
            if d in ('forward', 'backward') and k + 1 < len(rnodes):
                wnds = ways[rways[min(k, len(rways) - 1)]][0]
                a, b = (rnodes[k], rnodes[k + 1]) if k + 1 < len(rnodes) else (rnodes[k - 1], rnodes[k])
                ours = 'forward' if (a in wnds and b in wnds and wnds.index(b) > wnds.index(a)) else 'backward'
                if d != ours:
                    continue
            on_route.append(('signal', s, n))
        elif tg.get('highway') == 'crossing' or 'crossing' in tg:
            sig = tg.get('crossing') == 'traffic_signals' or tg.get('crossing:signals') == 'yes'
            on_route.append(('xsig' if sig else 'crosswalk', s, n))
        elif tg.get('highway') == 'stop':
            events.append({'kind': 'stop', 's': round(s - 2, 1)})
        elif tg.get('railway') == 'level_crossing':
            events.append({'kind': 'rail', 's': round(s, 1)})
        elif tg.get('cycleway') == 'asl':
            events.append({'kind': 'bikebox', 's': round(s, 1)})
    on_route.sort(key=lambda e: e[1])

    # Signalised intersections: a signal and the signalised crosswalks around it form one stop.
    used = set()
    for kind, s, n in on_route:
        if kind != 'signal':
            continue
        group = [(k2, s2, n2) for k2, s2, n2 in on_route if k2 in ('signal', 'xsig') and abs(s2 - s) < 22]
        if any(g[2] in used for g in group if g[0] == 'signal'):
            continue
        for g in group:
            used.add(g[2])
        first = min(g[1] for g in group)
        last = max(g[1] for g in group)
        events.append({'kind': 'signal', 's': round(first - 3, 1), 'end': round(last + 3, 1)})
    for kind, s, n in on_route:
        if kind == 'xsig' and n not in used:
            # A stand-alone pedestrian signal (push-button crossing).
            events.append({'kind': 'signal', 's': round(s - 3, 1), 'end': round(s + 3, 1), 'ped': True})
            used.add(n)
        elif kind == 'crosswalk':
            events.append({'kind': 'crosswalk', 's': round(s, 1)})

    # Turns and name changes.
    def heading_at(s, back):
        j = max(0, min(len(cum) - 1, next((i for i, c in enumerate(cum) if c >= s), len(cum) - 1)))
        j2 = max(0, min(len(pts) - 1, j + (-12 if back else 12)))
        (ax, ay), (bx, by) = (pts[j2], pts[j]) if back else (pts[j], pts[j2])
        return math.atan2(by - ay, bx - ax)

    for a, b in zip(segs, segs[1:]):
        if a['name'] != b['name']:
            s = b['s0']
            dh = (heading_at(s + 8, False) - heading_at(s - 8, True) + math.pi) % (2 * math.pi) - math.pi
            turn = 'left' if dh < -0.5 else 'right' if dh > 0.5 else 'bear-left' if dh < -0.2 else 'bear-right' if dh > 0.2 else 'straight'
            events.append({'kind': 'turn', 's': round(s, 1), 'dir': turn, 'onto': b['name'], 'from': a['name']})
        if a['mph'] != b['mph']:
            events.append({'kind': 'speed', 's': b['s0'], 'mph': b['mph']})
    events.sort(key=lambda e: e['s'])

    # Context: other streets, buildings and green space near the route.
    rx = pts[::10]
    def near(p, r):
        return any(abs(p[0] - q[0]) < r and abs(p[1] - q[1]) < r and math.dist(p, q) < r for q in rx)

    route_ways = set(rways)
    roads, buildings, green = [], [], []
    for wid, (nds, tg) in ways.items():
        if any(n not in xy for n in nds):
            continue
        ps = [xy[n] for n in nds]
        if drivable(tg) and wid not in route_ways and any(near(p, 160) for p in ps[::2] + [ps[-1]]):
            oneway = tg.get('oneway') in ('yes', '1', '-1')
            lanes = int(tg.get('lanes', '1' if oneway else '2').split(';')[0])
            roads.append({'pts': [[round(x, 1), round(y, 1)] for x, y in ps], 'w': round(lanes * LANE_W + (1 if oneway else 0), 1),
                          'oneway': oneway, 'name': tg.get('name', '')})
        elif 'building' in tg and len(nds) > 3:
            c = (sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps))
            if near(c, 110):
                h = None
                try:
                    h = float(tg['height'].split()[0]) if 'height' in tg else float(tg['building:levels']) * 3.3 + 1 if 'building:levels' in tg else None
                except ValueError:
                    pass
                buildings.append({'pts': [[round(x, 1), round(y, 1)] for x, y in ps[:-1]], 'h': round(h or (8 + (wid % 5) * 2.5), 1)})
        elif (tg.get('leisure') in ('park', 'garden', 'pitch') or tg.get('landuse') in ('grass', 'recreation_ground')) and len(nds) > 3:
            if any(near(p, 140) for p in ps[::3]):
                green.append([[round(x, 1), round(y, 1)] for x, y in ps[:-1]])

    out = {
        'attribution': '© OpenStreetMap contributors, ODbL 1.0',
        'origin': ORIGIN,
        'start': START[2],
        'goal': GOAL[2],
        'length': round(cum[-1], 1),
        'pts': [[round(x, 2), round(y, 2)] for x, y in pts],
        'segs': segs,
        'events': events,
        'roads': roads,
        'buildings': buildings,
        'green': green,
        'laneW': LANE_W,
        'bikeW': BIKE_W,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    kinds = {}
    for e in events:
        kinds[e['kind']] = kinds.get(e['kind'], 0) + 1
    print(f"route {cum[-1]:.0f} m, {len(segs)} segments, events {kinds}, {len(roads)} roads, {len(buildings)} buildings,"
          f" {len(green)} green areas -> {OUT} ({os.path.getsize(OUT) // 1024} kB)")
    for e in events:
        if e['kind'] in ('turn', 'speed', 'stop', 'rail'):
            print('  ', e)


if __name__ == '__main__':
    sys.exit(main())
