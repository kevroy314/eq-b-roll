#!/usr/bin/env python3
"""Bake app/zonedata/<zone>.json (NPC spawns, patrol grids, doors) from an EQMacEmu database.

The baked files are committed, so users never need the database. Coordinates are converted here to
the app's world frame (Lantern glTF metres): world = (-eqY, eqZ, eqX) / 10.

    python dev/bake_zonedata.py --mysql "mysql -uroot -S /path/to/mysql.sock alkabor"

Headings: spawn2 and grid headings use 0..256 per turn in this database; doors use 0..512. Both
are converted to radians here, in EQ's convention (0 = north, increasing counter-clockwise when
seen from above); the app turns that into a world rotation in one place.
"""
import argparse
import json
import math
import shlex
import subprocess
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "zonedata"
# Races that exist for game mechanics, not to be seen.
INVISIBLE = {127, 240}


def query(mysql, sql):
    out = subprocess.run(shlex.split(mysql) + ["-B", "-N", "-e", sql],
                         check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines()]


def w(x, y, z):
    return [round(-float(y) / 10, 3), round(float(z) / 10, 3), round(float(x) / 10, 3)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mysql", required=True)
    ap.add_argument("zones", nargs="*", help="default: every zone in app/zoneinfo.json")
    a = ap.parse_args()
    zones = a.zones or sorted(json.loads((OUT.parent / "zoneinfo.json").read_text()))
    OUT.mkdir(exist_ok=True)
    zid = {r[0]: int(r[1]) for r in query(a.mysql, "SELECT short_name, zoneidnumber FROM zone")}

    # A race's most common size is its normal size: models are drawn at 1x for that, and an NPC
    # of size 12 in a race whose normal is 6 is drawn twice as big.
    mode = {}
    for race, size, _ in query(a.mysql, """SELECT race, size, COUNT(*) c FROM npc_types
                                         WHERE size > 0 GROUP BY race, size ORDER BY race, c DESC"""):
        mode.setdefault(race, float(size))
    (OUT / "_races.json").write_text(json.dumps(mode, separators=(",", ":")))

    for zone in zones:
        # Most likely NPC per spawn point (ties broken by npc id, so a re-bake is stable).
        rows = query(a.mysql, f"""
            SELECT s.id, s.x, s.y, s.z, s.heading, s.pathgrid, se.chance,
                   n.id, n.name, n.lastname, n.race, n.gender, n.texture, n.helmtexture, n.size,
                   n.face, n.level, n.class, n.runspeed, n.walkspeed
            FROM spawn2 s
            JOIN spawnentry se ON se.spawngroupID = s.spawngroupID
            JOIN npc_types n ON n.id = se.npcID
            WHERE s.zone = '{zone}' AND s.enabled = 1
            ORDER BY s.id, se.chance DESC, n.id""")
        spawns, seen = [], set()
        for r in rows:
            sid = int(r[0])
            if sid in seen:
                continue
            seen.add(sid)
            race = int(r[10])
            if race in INVISIBLE:
                continue
            spawns.append({
                "p": w(r[1], r[2], r[3]),
                "h": round(float(r[4]) / 256 * 2 * math.pi, 4),
                "grid": int(r[5] or 0),
                "name": r[8].replace("_", " ").strip("# ").strip(),
                "race": race, "gender": int(r[11]), "tex": int(r[12]), "helm": int(r[13]),
                "size": float(r[14]), "face": int(r[15]), "level": int(r[16]), "class": int(r[17]),
                "walk": float(r[19] or 0) or None, "run": float(r[18] or 0) or None,
            })

        grids = defaultdict(lambda: {"wp": [], "pause": []})
        if zone in zid:
            for g in query(a.mysql, f"""
                    SELECT ge.gridid, ge.x, ge.y, ge.z, ge.pause, g.type, g.type2
                    FROM grid_entries ge LEFT JOIN grid g ON g.id = ge.gridid AND g.zoneid = ge.zoneid
                    WHERE ge.zoneid = {zid[zone]} ORDER BY ge.gridid, ge.number"""):
                e = grids[int(g[0])]
                e["type"], e["type2"] = int(g[5] if g[5] != "NULL" else 0), int(g[6] if g[6] != "NULL" else 0)
                e["wp"].append(w(g[1], g[2], g[3]))
                e["pause"].append(int(g[4] or 0))
        used = {s["grid"] for s in spawns if s["grid"]}
        grids = {str(k): v for k, v in grids.items() if k in used}

        doors = [{"name": r[0].lower(), "p": w(r[1], r[2], r[3]),
                  "h": round(float(r[4]) / 512 * 2 * math.pi, 4),
                  "incline": float(r[5]), "size": float(r[6]) / 100, "open": int(r[7])}
                 for r in query(a.mysql, f"""
                    SELECT name, pos_x, pos_y, pos_z, heading, incline, size, opentype
                    FROM doors WHERE zone = '{zone}'""")]

        (OUT / f"{zone}.json").write_text(json.dumps(
            {"zone": zone, "spawns": spawns, "grids": grids, "doors": doors}, separators=(",", ":")))
        print(f"{zone:<14} {len(spawns):4} spawns  {len(grids):3} grids  {len(doors):3} doors")


if __name__ == "__main__":
    main()
