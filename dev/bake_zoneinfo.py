#!/usr/bin/env python3
"""Bake app/zoneinfo.json from an EQMacEmu (Alkabor) database.

Only needed if you want to regenerate the file; the baked copy is committed. It pulls, per zone,
the name, the classic fog colour and clip distances, whether the zone is outdoors, and the "safe
point" players zone in at — which the app uses as the starting camera position.

    python dev/bake_zoneinfo.py --mysql "mysql -uroot -S /path/to/mysql.sock alkabor"
"""
import argparse
import json
import shlex
import subprocess
from pathlib import Path

COLS = ["short_name", "long_name", "fog_red", "fog_green", "fog_blue", "fog_minclip",
        "fog_maxclip", "maxclip", "sky", "castoutdoor", "safe_x", "safe_y", "safe_z",
        "safe_heading", "expansion"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mysql", required=True, help="mysql client command line, database included")
    args = ap.parse_args()
    q = f"SELECT {','.join(COLS)} FROM zone ORDER BY short_name"
    out = subprocess.run(shlex.split(args.mysql) + ["-B", "-N", "-e", q],
                         check=True, capture_output=True, text=True).stdout
    zones = {}
    for line in out.splitlines():
        r = dict(zip(COLS, line.split("\t")))
        f = lambda k: float(r[k])  # noqa: E731
        zones[r["short_name"]] = {
            "name": r["long_name"],
            "fog": [int(r["fog_red"]), int(r["fog_green"]), int(r["fog_blue"])],
            "fogNear": f("fog_minclip"), "fogFar": f("fog_maxclip"), "clip": f("maxclip"),
            "sky": int(r["sky"]), "outdoor": r["castoutdoor"] == "1",
            # EQ server coords (x, y, z). The app converts these to the glTF frame.
            "safe": [f("safe_x"), f("safe_y"), f("safe_z")], "heading": f("safe_heading"),
            "expansion": int(r["expansion"]),
        }
    dst = Path(__file__).resolve().parent.parent / "app" / "zoneinfo.json"
    dst.write_text(json.dumps(zones, indent=1, sort_keys=True))
    print(f"wrote {len(zones)} zones -> {dst}")


if __name__ == "__main__":
    main()
