# EQ B-Roll

Film classic EverQuest for streams and edits, without a character to babysit.
**Step-by-step instructions: <https://kevroy314.github.io/eq-b-roll/>** · Version 1.1.0 ·
[what's new](CHANGELOG.md)

Two ways to shoot, both set up by one double-click:

- **The real game, on your own private server.** The actual 2002 TAKP client connects to an
  [EQMacEmu](https://github.com/EQMacEmu/Server) server running on your PC in Docker. Every
  character is automatically a GM who flies, can't die, and never gets aggro. Time of day, weather
  and view distance are all one command away. Capture with OBS.
- **The Studio.** A browser-based renderer for the same zones: keyframed camera moves, orbits and
  recorded flights, rendered frame-perfect to MP4 (up to 4K, with motion blur).

## Quick start (Windows)

1. [Download the zip](https://github.com/kevroy314/eq-b-roll/archive/refs/heads/main.zip). Right-click
   it → Properties → **Unblock**, then unzip it somewhere like `C:\eq-b-roll`.
2. Double-click **`Setup.bat`**. It installs or starts Docker Desktop, builds and starts the server,
   downloads and patches the game client, and exports Studio zones. Safe to re-run any time.
3. Use the **EQ B-Roll** (game) and **EQ B-Roll Studio** desktop shortcuts.

No game files are in this repo; everything is downloaded to your PC from the projects that
publish it. See the [instructions page](https://kevroy314.github.io/eq-b-roll/) for in-game
commands and troubleshooting, and [docs/LOCAL_SERVER.md](docs/LOCAL_SERVER.md) for why each piece
of the setup exists.

### Updating

- **From 1.1.0 on:** close the Studio window and double-click **`Update.bat`**. It downloads the
  latest version over your folder, keeps your zones, takes, renders and settings, and re-runs the
  setup (quick when nothing changed). The Studio panel tells you when an update is out.
- **From 1.0.0 (no Update.bat yet):** download the zip again, open it, and copy everything inside
  its `eq-b-roll-main` folder into your existing EQ B-Roll folder, replacing files. Your zones and
  takes aren't in the zip, so they're untouched. From then on, use `Update.bat`.

### What Setup.bat puts together

| Piece | Source | Our changes |
|---|---|---|
| Game server | [`eqmacemu/eqmacemu`](https://github.com/jcon321/EQMacEmuDockerHub) Docker image (pinned) | [`server/`](server/): `#set weather` bug fixed and compiled in; GM-on-creation triggers; long view distance. Ports bound to this PC only. |
| Game client | [TAKP PC v2.1c](https://wiki.takp.info/wiki/Getting_Started_on_Windows) (checksum-pinned) | [eqw_takp](https://github.com/CoastalRedwood/eqw_takp) + [eqgame_dll_takp](https://github.com/EQMacEmu/eqgame_dll_takp) DLLs (fix crashes on modern Windows); `eqhost.txt` → local server |
| Studio | this repo | a private embeddable Python in `tools\python`; zones exported with [LanternExtractor](https://github.com/LanternEQ/LanternExtractor) |

---

# The Studio in detail

Fly a camera through the zones and render clean, repeatable clips. No character, no deaths, no
UI, no trains. Just the zone, its sky, its NPCs and its doors.

- **Noclip flight** with smoothed, cinematic mouse-look and movement.
- **Keyframe shots**: place a few camera positions and the camera glides between them at an even
  speed, with ease-in/out. One-click **orbit** shots around whatever you're aiming at.
- **Flight recording**: fly the shot yourself and it's recorded, then smoothed to take out the
  mouse jitter.
- **Frame-perfect rendering** to MP4 (H.264) at 720p–4K, 24/30/60 fps, with optional film-style
  motion blur. Rendering is offline, so a busy PC makes the same clip as a fast one; it just
  takes longer.
- **Takes are saved as files**, so a shot can be re-rendered later at another size or shared with
  someone else who has the zone.
- **Go to `/loc`**: paste coordinates from the game to jump to an exact spot.
- **Every zone in your client**: pick any zone; ones you haven't used are exported on the spot
  (about a minute), or export them all in the background.
- **Day and night**: time of day with a time-lapse. The sun and moon move, stars come out, and sky,
  fog and scene tint while fires stay lit. Reproducible in renders.
- **Speed from a walk to a warp**: 1 to 20,000 units/s, presets on keys 1-6, adjustable Shift boost.
- **Staged fights**: place a player and any NPC from the zone and make them fight (charge, blows,
  flinches, an optional death). Saved with the shot, renders identically.

`Setup.bat` sets all of this up. The rest of this section is for running the Studio by hand, for
example on macOS or Linux, or against a different client.

## Running the Studio by hand

- **Python 3.8+** ([python.org](https://www.python.org/downloads/); on Windows tick *Add python.exe to PATH*).
  Nothing to `pip install`.
- **Chrome or Edge** to render video. Firefox can fly around but can't encode video.
- **An EverQuest client with classic `.s3d` zones**: Project 1999, TAKP, a Titanium-era install,
  or similar. Zones that the live game has since rebuilt use a newer `.eqg` format and aren't
  supported.

## Setup (once)

```bash
git clone <this repo> eq-broll
cd eq-broll

# Export a few zones from your client. The first run downloads LanternExtractor (~35 MB unpacked, into tools/).
python broll.py extract gfaydark qeynos befallen --eq "C:/Program Files/EverQuest"
```

The EverQuest folder is remembered after the first time, so afterwards it's just
`python broll.py extract commons nro`. Each zone takes 5–30 seconds and 10–60 MB.
`python broll.py zones` lists every zone in your client and marks the ones already exported.
`--all` exports everything (a few GB, slow).

## Run it

```bash
python broll.py serve
```

That opens `http://localhost:8631/` in your browser. On Windows you can double-click
**`B-Roll.bat`** instead.

> Use the `localhost` address. Browsers only allow video encoding on `localhost` or HTTPS, so
> opening the app by LAN IP (e.g. `192.168.x.x`) works for flying but not for rendering.

## Controls

| | |
|---|---|
| Click the view | Take the mouse to look around. **Esc** gives it back. |
| **W A S D** | Fly (you go where you look) |
| **E** / **Space**, **Q** / **C** | Straight up, straight down |
| **Shift**, mouse wheel | boost while held (set the multiplier under Camera); set flying speed |
| **1**–**6** | speed presets: walk, run, mount, griffon, fly-by, warp |
| **Z** **X**, **V** | Roll the camera (dutch angle); level it |
| **[** **]** | Zoom (field of view) |
| **K** | Add a keyframe at the current view |
| **R** | Start/stop recording a flight |
| **P** | Preview the take (again to stop) |
| **Tab** | Hide the panel for a clean, full view |
| **G** | Rule-of-thirds grid |
| **?** | Help |

Nothing drawn over the picture (panel, HUD, path line, grid) ends up in rendered video.

## Making a shot

**Keyframes** work best for most b-roll. Fly to the start, frame it, press **K**. Move, frame,
**K**, and so on. Press **P** to preview. The yellow line is the path the camera will take.
Speed sets how fast it travels; *Ease in/out* sets how gently it starts and stops. In the key
list, **go** jumps to a key and **set** replaces it with the current view.

**Orbit**: put the crosshair on something (a statue, a tower, a camp) and click *Make orbit*. It
builds a circle of keys around that point, starting from where you are. Use a negative number of
degrees to go the other way.

**Flight recording**: press **R**, fly the shot, press **R** again. *Smoothing* sets how much
of your hand shake is removed when it renders (0.3–0.6 s is a good range). It never changes where
the shot starts or ends.

Then **Render MP4**. Finished clips go into `renders/`, and a player opens so you can check the
clip before downloading it.

**Save take** writes the shot to `takes/<name>.json`, including the zone and look, so you can
reopen it and render it again at another size. *Export/Import* moves a take between machines.

### Tips for good-looking b-roll

- **Slow down.** A walking-pace dolly (20–40 units/s) reads as cinematic; a fast one reads as
  gameplay.
- **30 fps with Film motion blur** looks the most like camera footage. Use 60 fps without blur
  when you want it to look like the game.
- **Fog** is your friend. It hides the edge of the world and adds depth. Each zone starts with a
  fog colour taken from its original game settings.
- **Narrow FOV** (30–45°) with slow movement makes zones look bigger and more epic. Wide FOV
  (80°+) close to the ground feels fast.
- *Sunlit* adds directional sunlight to outdoor zones: nice for flyovers, less faithful.
  *Classic* is flat, full-bright texturing, closer to how the old client looked.
- Tone *Filmic* or *Soft* compresses highlights for a less "video game" look.

## Good to know

- **Holes and one-sided walls exist.** A noclip camera can go where no player could. The
  original art often has no geometry where it would never be seen, like the backs of walls or
  gaps above rooftops. Keep the camera where players could plausibly see.
- **Scale**: 10 EQ units is roughly 1 m. A human is about 6 units tall, so dungeon ceilings are
  closer than you'd expect.
- **Staged fights are mocked, not simulated**: animations and timing only, with no weapons in
  hand, no damage numbers and no spell effects. Stage them on open ground; a death animation can
  drop the body into a nearby wall.
- **Day and night is an emulation**, tuned to look right on video rather than to copy the client's
  exact lighting.
- **What's in the scene:** the zone, EQ's own sky layers, doors and gates from the server
  database, and NPCs at their spawn points using the client's models, animations and armour
  textures. Patrollers walk their real routes. Water, lava and fire textures animate, and water is
  translucent. **Not included:** particle effects (torch flames, spell effects), items held in NPCs'
  hands, dynamic lighting, and a few Planes of Power creature models that LanternExtractor can't
  export.
- **Performance**: zones are merged to one draw call per texture (Greater Faydark goes from 2,842
  meshes to 151), so flying is smooth even with OBS running.

## Troubleshooting

| | |
|---|---|
| "No zones extracted yet" | Run `python broll.py extract <zone> --eq "<EverQuest folder>"`, then reload. |
| Render button says it needs `localhost` | Open `http://localhost:8631/` rather than an IP address. |
| "Port 8631 is already in use" | It's already running in another window, or use `python broll.py serve --port 8632`. |
| Extraction FAILED for a zone | The zone might be `.eqg` in your client (not supported), or the name might be wrong. Check `python broll.py zones`. |
| macOS/Linux: extraction fails converting textures | LanternExtractor needs `libgdiplus` there (`brew install mono-libgdiplus` / `apt install libgdiplus`). |

## Files

```
Setup.bat       one-click Windows setup (runs windows/setup.ps1)
broll.py        CLI: extract zones, run the Studio (standard library only)
B-Roll.bat      Windows launcher for the Studio
server/         our game-server image: Dockerfile, source patches, SQL applied at start
windows/        setup.ps1 and check_mouse.ps1
app/            the browser app (three.js, vendored; nothing loads from the internet)
  main.js       flight controls, UI, takes, preview
  take.js       camera path maths: constant-speed splines, flight smoothing
  render.js     frame-by-frame WebCodecs → MP4, motion blur by sub-frame accumulation
  zone.js       loading and merging LanternExtractor's glTF; materials, fog and lighting
  sky.js        EQ sky layers on a camera-centred dome
  actors.js     doors and gates from the server database
  npcs.js       NPCs: model choice, armour/face textures, idle animation, patrol routes
  zoneinfo.json zone names, fog colours and zone-in points (from the EQMacEmu database)
  zonedata/     per-zone spawns, patrol grids and doors (baked from the database)
  race_models.json  race/gender -> client model code (see dev/race_models_SOURCES.md)
zones/          your exported zones (not committed)
takes/          saved shots
renders/        finished videos
dev/            tests (node dev/test_take.mjs) and the database bakers
```

## Credits

- [LanternExtractor](https://github.com/LanternEQ/LanternExtractor) turns the client's `.s3d`
  archives into glTF. It is downloaded at first use and not redistributed here.
- [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (all MIT), vendored in `app/vendor/`.
- The game server is [EQMacEmu](https://github.com/EQMacEmu/Server) (GPL), run from the community [Docker image](https://github.com/jcon321/EQMacEmuDockerHub). The client fixes are [eqw_takp](https://github.com/CoastalRedwood/eqw_takp) and [eqgame_dll_takp](https://github.com/EQMacEmu/eqgame_dll_takp).
- Zone metadata comes from the [EQMacEmu](https://github.com/EQMacEmu) (Alkabor) database.
- EverQuest is a trademark of Daybreak Game Company. This is a fan tool and isn't affiliated with or endorsed by them.
