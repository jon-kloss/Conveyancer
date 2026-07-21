#!/usr/bin/env python3
"""Regenerate crates/gamedata/assets/world-nodes.json from the vendored
community node dataset (crates/gamedata/assets/vendor/nodes_vanilla.json,
MIT — github.com/Hirashi3630/satisfactory_node_heatmap, extracted in-game via
FicsIt-Networking; counts cross-confirmed against satisfactory-calculator.com's
1.1 mapData). Coordinates: UE cm → meters (/100), +Y = south, Z = up.

Included: every extractable site — solid + crude-oil `Node`s (miner/oil pump),
`Geyser`s (geothermal siting), and `Fracking Satellite`s (resource-well
extraction of nitrogen / water / oil). Each node carries a `nodeType`
("node" | "geyser" | "fracking-satellite"). Satellites additionally carry a
`well` id: the vendor dataset lists satellites as independent points with no
core grouping, so wells are reconstructed by clustering satellites of the same
resource within WELL_EPS_M of each other (satellites of one well sit tight
around their shared core; wells are far apart). Cave/entrance zoning isn't in
the dataset; the schema keeps supporting it (see worldnodes.rs unit tests)."""
import json, os
from collections import defaultdict

# Satellites within this many meters (same resource) belong to one well. 150 m
# cleanly separates the real wells (6 nitrogen / 8 water / 3 oil; 6-10 sats each)
# — wider values start merging adjacent water wells.
WELL_EPS_M = 150.0

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = json.load(open(f"{root}/crates/gamedata/assets/vendor/nodes_vanilla.json"))

REGIONS = [
    {"id": "grass-fields", "name": "GRASS FIELDS", "labelX": -700, "labelY": 2000},
    {"id": "rocky-desert", "name": "ROCKY DESERT", "labelX": -2200, "labelY": 400},
    {"id": "northern-forest", "name": "NORTHERN FOREST", "labelX": 900, "labelY": -1100},
    {"id": "dune-desert", "name": "DUNE DESERT", "labelX": 3000, "labelY": -2200},
]

# Vendor node_type → our nodeType tag.
NODE_TYPE = {
    "Node": "node",
    "Geyser": "geyser",
    "Fracking Satellite": "fracking-satellite",
}


def region_of(x, y):
    best, bd = None, None
    for r in REGIONS:
        d = (x - r["labelX"]) ** 2 + (y - r["labelY"]) ** 2
        if bd is None or d < bd:
            best, bd = r["id"], d
    return best


def reconstruct_wells(sats):
    """Assign each fracking satellite a `well` id by union-find clustering
    within-resource on WELL_EPS_M. Returns {satellite id -> well id}. Well ids
    are `well-<resource-slug>-<n>`, numbered by ascending (x, y) of the well's
    first satellite so the labeling is deterministic across runs."""
    by_res = defaultdict(list)
    for s in sats:
        by_res[s["class_name"]].append(s)
    assigned = {}
    for res, group in sorted(by_res.items()):
        n = len(group)
        parent = list(range(n))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for i in range(n):
            for j in range(i + 1, n):
                dx = group[i]["location"]["x"] - group[j]["location"]["x"]
                dy = group[i]["location"]["y"] - group[j]["location"]["y"]
                if (dx * dx + dy * dy) <= (WELL_EPS_M * 100.0) ** 2:  # cm
                    parent[find(i)] = find(j)
        clusters = defaultdict(list)
        for i in range(n):
            clusters[find(i)].append(i)
        # deterministic well ordering: by the min (x, y) satellite in each well
        slug = res.replace("Desc_", "").replace("_C", "").lower()
        ordered = sorted(
            clusters.values(),
            key=lambda idxs: min((group[i]["location"]["x"], group[i]["location"]["y"]) for i in idxs),
        )
        for wn, idxs in enumerate(ordered, start=1):
            for i in idxs:
                assigned[group[i]["id"]] = f"well-{slug}-{wn}"
    return assigned


sats = [n for n in src if n.get("node_type") == "Fracking Satellite"]
well_of = reconstruct_wells(sats)

nodes = []
for n in src:
    nt = NODE_TYPE.get(n.get("node_type"))
    if nt is None:
        continue
    x = round(n["location"]["x"] / 100.0, 1)
    y = round(n["location"]["y"] / 100.0, 1)
    z = round(n["location"]["z"] / 100.0, 1)
    node = {
        "id": n["id"].lower(),
        "item": n["class_name"],
        "purity": n["purity"].lower(),
        "nodeType": nt,
        "x": x, "y": y, "z": z,
        "region": region_of(x, y),
    }
    if nt == "fracking-satellite":
        node["well"] = well_of[n["id"]]
    nodes.append(node)
# Plain nodes stay FIRST, in their original (item, id) order — the v2 ordering is
# preserved byte-for-byte (bar the added nodeType field) so nothing that indexes
# the catalog shifts. Geysers then satellites follow, appended.
TYPE_RANK = {"node": 0, "geyser": 1, "fracking-satellite": 2}
nodes.sort(key=lambda n: (TYPE_RANK[n["nodeType"]], n["item"], n.get("well", ""), n["id"]))
xs = [n["x"] for n in nodes]; ys = [n["y"] for n in nodes]

out = {
    "version": 3,
    "source": "Generated by scripts/gen-world-nodes.py from the vendored community dataset (MIT, github.com/Hirashi3630/satisfactory_node_heatmap; cross-confirmed vs satisfactory-calculator.com 1.1 mapData). Game content © Coffee Stain Studios. See NOTICE.",
    "bounds": {"minX": -3247.0, "minY": -3750.0, "maxX": 4253.1, "maxY": 3750.0},
    "regions": REGIONS,
    "nodes": nodes,
}
dst = f"{root}/crates/gamedata/assets/world-nodes.json"
json.dump(out, open(dst, "w"), indent=1)

from collections import Counter
types = Counter(n["nodeType"] for n in nodes)
wells = len({n["well"] for n in nodes if "well" in n})
print(f"{len(nodes)} nodes -> {dst}; x [{min(xs)},{max(xs)}] y [{min(ys)},{max(ys)}]")
print(f"  by type: {dict(types)}; reconstructed wells: {wells}")
print(f"  by item: {dict(Counter(n['item'] for n in nodes))}")
