#!/usr/bin/env python3
"""EQ B-Roll — fly a camera through EverQuest zones and render clean video clips.

    python broll.py extract gfaydark qeynos --eq "C:/EverQuest"   # once per zone
    python broll.py serve                                          # opens the app
    python broll.py zones                                          # what can I extract?

Standard library only. The zone art comes from YOUR EverQuest client via LanternExtractor
(downloaded automatically on first use); nothing from the game is shipped in this repo.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
import urllib.request
import webbrowser
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
ZONES = ROOT / "zones"
TAKES = ROOT / "takes"
RENDERS = ROOT / "renders"
TOOLS = ROOT / "tools"
LANTERN = TOOLS / "lantern"
CONFIG = ROOT / "config.json"
LANTERN_RELEASES = "https://api.github.com/repos/LanternEQ/LanternExtractor/releases/latest"

# A zone's archives are <zone>.s3d plus companions (<zone>_obj.s3d, <zone>_chr.s3d, <zone>_2_obj...).
# Anything with one of these suffixes is a companion, not a zone of its own.
COMPANION = re.compile(r"_(obj\d*|chr\d*|\d+_obj|2_chr|amb|lit|assets)$|^(gequip\d*|global\d*.*|sky)$")
VERSION = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").is_file() else "dev"
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\- ]{1,80}$")


# ─── config ────────────────────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, indent=2))


def eq_dir(arg: str | None) -> Path:
    """The EverQuest client folder: --eq if given (and remembered), else the remembered one."""
    cfg = load_config()
    raw = arg or cfg.get("eq_dir")
    if not raw:
        sys.exit("Where is your EverQuest folder? Pass it once with --eq \"C:/path/to/EverQuest\" "
                 "(it is remembered after that).")
    p = Path(raw).expanduser()
    if not p.is_dir() or not any(p.glob("*.s3d")):
        sys.exit(f"{p} does not look like an EverQuest folder (no .s3d files in it).")
    if arg:
        cfg["eq_dir"] = str(p)
        save_config(cfg)
    return p


def zone_info() -> dict:
    return json.loads((APP / "zoneinfo.json").read_text())


def configured_eq() -> Path | None:
    """The remembered EverQuest folder, or None. Unlike eq_dir(), never exits (used by the server)."""
    raw = load_config().get("eq_dir")
    p = Path(raw).expanduser() if raw else None
    return p if p and p.is_dir() else None


def client_zones(eq: Path) -> list[str]:
    # The client folder also holds equipment, character and UI archives (gequip, bmpwad, load...).
    # Anything that is not a zone in the baked zone table is one of those.
    known = zone_info()
    return sorted(z for z in (p.stem.lower() for p in eq.glob("*.s3d"))
                  if not COMPANION.search(z) and z in known)


def extracted_zones() -> list[str]:
    return sorted(p.name for p in ZONES.iterdir()
                  if not p.name.startswith("_") and (p / f"{p.name}.gltf").is_file()) \
        if ZONES.is_dir() else []


# ─── LanternExtractor ─────────────────────────────────────────────────────────────────────────

def lantern_exe() -> Path:
    for name in ("LanternExtractor.exe", "LanternExtractor"):
        for p in LANTERN.rglob(name):
            return p
    return install_lantern()


def install_lantern() -> Path:
    osname = {"Windows": "win", "Darwin": "osx", "Linux": "linux"}.get(platform.system())
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    if not osname:
        sys.exit(f"No LanternExtractor build for {platform.system()}.")
    want = f".{osname}-{arch}.zip"
    print(f"Downloading LanternExtractor ({osname}-{arch}) ...")
    req = urllib.request.Request(LANTERN_RELEASES, headers={"User-Agent": "eq-broll"})
    rel = json.load(urllib.request.urlopen(req, timeout=30))
    assets = [a for a in rel.get("assets", []) if a["name"].endswith(want)]
    if not assets:
        sys.exit(f"LanternExtractor release {rel.get('tag_name')} has no {want} build. Download it "
                 f"manually from https://github.com/LanternEQ/LanternExtractor/releases and unzip "
                 f"it into {LANTERN}")
    LANTERN.mkdir(parents=True, exist_ok=True)
    tmp = TOOLS / assets[0]["name"]
    with urllib.request.urlopen(assets[0]["browser_download_url"], timeout=120) as r, \
            open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    with zipfile.ZipFile(tmp) as z:
        z.extractall(LANTERN)
    tmp.unlink()
    for name in ("LanternExtractor.exe", "LanternExtractor"):
        for p in LANTERN.rglob(name):
            p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            print(f"  installed {rel.get('tag_name')} -> {p}")
            return p
    sys.exit("Downloaded LanternExtractor but could not find the executable inside the zip.")


# Lantern reads settings.txt from its own folder. These are the settings that matter for us;
# everything else is left at a harmless default. {fmt}: 2 = glTF (what the app draws),
# 0 = Lantern's text "intermediate" format, which we read only for texture-animation timing.
SETTINGS = """\
EverQuestDirectory = {eq}/
RawS3DExtract = false
ModelExportFormat = {fmt}
ExportZoneMeshGroups = false
ExportHiddenGeometry = false
ExportCharacterToSingleFolder = true
ExportEquipmentToSingleFolder = true
ExportSoundsToSingleFolder = true
ExportAllAnimationFrames = true
ExportZoneWithObjects = true
ExportGltfVertexColors = false
ExportGltfInGlbFormat = false
ClientDataToCopy =
CopyMusic = false
LoggerVerbosity = 2
"""

# Character models shared by every zone (the playable races, which most NPCs are).
SHARED_CHARACTERS = ["global_chr.s3d"]


def run_lantern(exe: Path, eq: Path, arg: str, fmt: int) -> subprocess.CompletedProcess:
    home = exe.parent
    (home / "settings.txt").write_text(SETTINGS.format(eq=eq.as_posix().rstrip("/"), fmt=fmt))
    return subprocess.run([str(exe), arg], cwd=home, capture_output=True, text=True)


def read_material_lists(folder: Path) -> dict:
    """Animated textures from Lantern's intermediate material lists.

    A line is  index,name:frame1:frame2...[;variant...],delayMs  — the glTF export keeps only
    frame 1 of each animated material, so this is the only place the other frames are named.
    """
    anim = {}
    for f in folder.rglob("MaterialLists/*.txt"):
        for line in f.read_text(errors="replace").splitlines():
            if line.startswith("#"):
                continue
            parts = line.split(",")
            if len(parts) < 3:
                continue
            first = parts[1].split(";")[0].split(":")
            if len(first) > 2:
                anim[first[0]] = {"frames": first[1:], "delay": int(parts[2] or 200)}
    return anim


def extract_shared(exe: Path, eq: Path) -> None:
    """Things every zone uses: sky textures and the global character models. Done once."""
    out = exe.parent / "Exports"
    sky = ZONES / "_sky"
    if not (sky / "Textures" / "normalsky.png").is_file():
        print("  sky: extracting ...", flush=True)
        run_lantern(exe, eq, "sky.s3d", 2)
        if (out / "sky" / "Textures").is_dir():
            shutil.rmtree(sky, ignore_errors=True)
            sky.mkdir(parents=True)
            shutil.move(str(out / "sky" / "Textures"), str(sky / "Textures"))
        shutil.rmtree(out / "sky", ignore_errors=True)
    glob_dir = ZONES / "_global" / "Characters"
    for arc in SHARED_CHARACTERS:
        name = arc[:-4].replace("_chr", "")        # Lantern writes global_chr.s3d to Exports/global
        stamp = ZONES / "_global" / f".{name}.done"
        if stamp.exists() or not (eq / arc).is_file():
            continue
        print(f"  {name}: extracting shared character models ...", flush=True)
        run_lantern(exe, eq, arc, 2)
        src = out / name / "Characters"
        if src.is_dir():
            glob_dir.mkdir(parents=True, exist_ok=True)
            for f in src.rglob("*"):
                if f.is_file():
                    t = glob_dir / f.relative_to(src)
                    t.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(f), str(t))
            stamp.write_text("ok")
        shutil.rmtree(out / name, ignore_errors=True)


def extract(zones: list[str], eq: Path, force: bool) -> tuple[list[str], list[str]]:
    exe = lantern_exe()
    out = exe.parent / "Exports"
    ZONES.mkdir(exist_ok=True)
    extract_shared(exe, eq)
    ok, failed = [], []
    for z in zones:
        dst = ZONES / z
        if (dst / f"{z}.gltf").is_file() and (dst / "materials.json").is_file() and not force:
            print(f"  {z}: already extracted (use --force to redo)")
            ok.append(z)
            continue
        if not (eq / f"{z}.s3d").is_file():
            print(f"  {z}: no {z}.s3d in {eq} — skipping")
            failed.append(z)
            continue
        print(f"  {z}: extracting ...", flush=True)
        shutil.rmtree(out / z, ignore_errors=True)
        run_lantern(exe, eq, z, 0)
        anim = read_material_lists(out / z)
        shutil.rmtree(out / z, ignore_errors=True)
        shutil.rmtree(out / "characters", ignore_errors=True)   # the text pass's creature dump
        r = run_lantern(exe, eq, z, 2)
        src = out / z / "Zone"
        if not (src / f"{z}.gltf").is_file():
            print(f"  {z}: FAILED\n{(r.stdout + r.stderr).strip()[-1500:]}")
            failed.append(z)
            continue
        shutil.rmtree(dst, ignore_errors=True)
        shutil.move(str(src), str(dst))
        # Objects/ holds door and gate models; Characters/ the zone's own creatures. A crash while
        # exporting characters (Lantern has a few) still leaves a usable zone.
        for sub in ("Objects", "Characters"):
            if (out / z / sub).is_dir():
                shutil.move(str(out / z / sub), str(dst / sub))
        (dst / "materials.json").write_text(json.dumps(anim, indent=0))
        shutil.rmtree(out / z, ignore_errors=True)
        mb = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file()) / 1e6
        chars = len(list((dst / "Characters").glob("*.gltf"))) if (dst / "Characters").is_dir() else 0
        print(f"  {z}: ok ({mb:.0f} MB, {len(anim)} animated textures, {chars} creature models)")
        ok.append(z)
    print(f"\n{len(ok)} ready, {len(failed)} failed." + (f"  Failed: {' '.join(failed)}" if failed else ""))
    return ok, failed


class ExtractJobs:
    """Background zone exports for the Studio's zone picker.

    One worker, one zone at a time: LanternExtractor writes to a single shared Exports folder, so
    two exports at once would trample each other. The page polls status() to show progress.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.queue: list[str] = []
        self.current: str | None = None
        self.done: list[str] = []
        self.failed: list[str] = []
        self.thread: threading.Thread | None = None

    def add(self, zones: list[str]) -> None:
        have = set(extracted_zones())
        with self.lock:
            for z in zones:
                if z not in have and z != self.current and z not in self.queue:
                    self.queue.append(z)
            if self.queue and not (self.thread and self.thread.is_alive()):
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()

    def cancel(self) -> None:
        with self.lock:
            self.queue.clear()

    def status(self) -> dict:
        with self.lock:
            return {"current": self.current, "queue": list(self.queue),
                    "done": list(self.done), "failed": list(self.failed)}

    def _run(self) -> None:
        while True:
            with self.lock:
                if not self.queue:
                    self.current = None
                    return
                self.current = self.queue.pop(0)
                z = self.current
            ok = False
            try:
                eq = configured_eq()
                if eq:
                    good, _ = extract([z], eq, force=False)
                    ok = z in good
            except BaseException as e:          # noqa: BLE001 - sys.exit inside extract, etc.
                print(f"  {z}: export failed: {e}", flush=True)
            with self.lock:
                (self.done if ok else self.failed).append(z)


JOBS = ExtractJobs()


# ─── server ───────────────────────────────────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    """Static files from the repo root, plus a tiny JSON API for takes and renders.

    Everything is served no-store: this is a local creative tool and stale caches after an edit
    are the one thing that would make it feel broken.
    """

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/app/")
            self.end_headers()
            return
        if path == "/api/zones":
            # "zones": ready to load. "client": everything in the EverQuest client, which the page
            # offers to export on first use.
            eq = configured_eq()
            try:
                client = client_zones(eq) if eq else []
            except OSError:
                client = []
            return self._json({"zones": extracted_zones(), "client": client, "version": VERSION,
                               "extract": JOBS.status()})
        if path == "/api/extract":
            return self._json(JOBS.status())
        if path.startswith("/api/characters/"):
            # Which creature models and textures exist, for the zone and the shared set. Lets the
            # app pick armour/face texture variants without probing for files that aren't there.
            zone = path.rsplit("/", 1)[-1]
            out = {}
            for key, d in (("zone", ZONES / zone / "Characters"), ("global", ZONES / "_global" / "Characters")):
                if SAFE_NAME.match(zone) and d.is_dir():
                    out[key] = {"models": sorted(p.stem for p in d.glob("*.gltf")),
                                "textures": sorted(p.stem for p in (d / "Textures").glob("*.png"))}
                else:
                    out[key] = {"models": [], "textures": []}
            return self._json(out)
        if path == "/api/takes":
            TAKES.mkdir(exist_ok=True)
            takes = []
            for p in sorted(TAKES.glob("*.json"), key=lambda p: -p.stat().st_mtime):
                try:
                    d = json.loads(p.read_text())
                    takes.append({"name": p.stem, "zone": d.get("zone"), "kind": d.get("kind"),
                                  "duration": d.get("duration")})
                except ValueError:
                    pass
            return self._json({"takes": takes})
        # Only the app, the extracted zones and saved takes are served — not config.json, tools/.
        top = path.lstrip("/").split("/", 1)[0]
        if top not in ("app", "zones", "takes"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path in ("/api/extract", "/api/extract/cancel"):
            n = int(self.headers.get("Content-Length", 0) or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                body = {}
            if path.endswith("/cancel"):
                JOBS.cancel()
                return self._json(JOBS.status())
            eq = configured_eq()
            if not eq:
                return self._json({"error": "No EverQuest folder configured. Run Setup.bat, or "
                                            "`broll.py extract <zone> --eq <folder>` once."}, 400)
            known = set(client_zones(eq))
            want = sorted(known) if body.get("all") else [z for z in body.get("zones", []) if z in known]
            JOBS.add(want)
            return self._json(JOBS.status())
        m = re.match(r"^/api/(takes|renders)/(.+)$", path)
        if not m:
            return self._json({"error": "not found"}, 404)
        kind, name = m.group(1), urllib.request.unquote(m.group(2))
        if not SAFE_NAME.match(name) or name.startswith("."):
            return self._json({"error": "bad name"}, 400)
        n = int(self.headers.get("Content-Length", 0))
        folder = TAKES if kind == "takes" else RENDERS
        folder.mkdir(exist_ok=True)
        dst = folder / (name if kind == "renders" else f"{name}.json")
        with open(dst, "wb") as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        print(f"  saved {dst.relative_to(ROOT)} ({n / 1e6:.1f} MB)", flush=True)
        return self._json({"ok": True, "path": str(dst)})


def serve(port: int, host: str, open_browser: bool) -> None:
    have = extracted_zones()
    if not have:
        print("No zones extracted yet. Run:  python broll.py extract <zone> --eq <EverQuest folder>")
    try:
        srv = ThreadingHTTPServer((host, port), Handler)
    except OSError:
        sys.exit(f"Port {port} is already in use (is B-Roll already running?). Try --port {port + 1}")
    url = f"http://localhost:{port}/"
    print(f"EQ B-Roll {VERSION} on {url}  ({len(have)} zones: {' '.join(have)})\nCtrl+C to stop.")
    if open_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


# ─── CLI ──────────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extract", help="export zones from your EverQuest client")
    e.add_argument("zones", nargs="*", help="zone short names, e.g. gfaydark qeynos befallen")
    e.add_argument("--eq", help="EverQuest client folder (remembered)")
    e.add_argument("--all", action="store_true", help="every zone in the client (slow, several GB)")
    e.add_argument("--force", action="store_true", help="re-extract zones already present")

    s = sub.add_parser("serve", help="run the app")
    s.add_argument("--port", type=int, default=8631)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--no-browser", action="store_true")

    z = sub.add_parser("zones", help="list zones in your client and which are extracted")
    z.add_argument("--eq", help="EverQuest client folder (remembered)")

    a = ap.parse_args()
    if a.cmd == "extract":
        eq = eq_dir(a.eq)
        zones = client_zones(eq) if a.all else [x.lower() for x in a.zones]
        if not zones:
            sys.exit("Name at least one zone (see `python broll.py zones`), or pass --all.")
        extract(zones, eq, force=a.force)
    elif a.cmd == "serve":
        serve(a.port, a.host, not a.no_browser)
    elif a.cmd == "zones":
        info = zone_info()
        have = set(extracted_zones())
        for zname in client_zones(eq_dir(a.eq)):
            mark = "*" if zname in have else " "
            print(f" {mark} {zname:<14} {info.get(zname, {}).get('name', '')}")
        print("\n * = extracted")


if __name__ == "__main__":
    main()
