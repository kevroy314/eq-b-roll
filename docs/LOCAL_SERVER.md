# Local server setup (living document)

**Goal:** a private EverQuest server on your own PC, so you can film b-roll inside the real game
client. Your character can't die, nothing aggroes it, it can fly, and it can teleport to exact
coordinates.

**Status key:** ✅ verified on the development PC · 🟡 done, not yet verified · ❌ known broken ·
⬜ not started.

These are the engineering notes behind `Setup.bat`. The development PC already had most tools
installed, so each step also records what a **clean Windows PC** needs; `Setup.bat` now does
all of it.

---

## How it fits together

```
 EverQuest client (TAKP, Dec-2002 era)  ──UDP 6000──▶  login server ┐
   C:\TAKP-broll\eqgame.exe             ──UDP 9000──▶  world server ├─ Docker container
   eqhost.txt → 127.0.0.1:6000          ──UDP 7000-7400▶ zone servers┘  "eq-broll-server"
                                                        MariaDB (database "peq")
```

- **Server:** [EQMacEmu](https://github.com/EQMacEmu/Server) (open source; GPL). It's the server
  behind The Al'Kabor Project (TAKP), a Luclin-era classic EverQuest server. We run the community's
  ready-made Docker image, [`eqmacemu/eqmacemu`](https://github.com/jcon321/EQMacEmuDockerHub), which
  builds the server from source and loads the full Alkabor game database.
- **Client:** the TAKP Windows client v2.1, plus two community DLL updates (step 3).

---

## Steps

### 1. Docker ✅ · clean PC: handled by Setup.bat
- **Dev PC:** Docker Desktop was already installed. The WSL `docker` command talks to it
  (`docker info` reports "Docker Desktop").
- **Clean PC needs:** [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/),
  which in turn needs:
  - WSL2 (Docker's installer offers to enable it)
  - hardware virtualization enabled in the BIOS
  - a reboot
  - Docker Desktop running whenever the server runs

  This is the heaviest step for a non-developer. Alternative still to evaluate: a native Windows
  build of the server with no Docker.

### 2. Start the server ✅
`Setup.bat` does this. It builds `eq-broll-server` from [`server/`](../server/): the pinned
upstream image, plus the weather patch compiled in, plus our SQL applied at every start. It then
runs the container as below, with `--restart unless-stopped`. The manual equivalent, using the
upstream image:
```bash
docker volume create eq-broll-data
docker run -d --name eq-broll-server -v eq-broll-data:/var/lib/mysql \
  -p 127.0.0.1:6000:6000/udp -p 127.0.0.1:5998:5998 \
  -p 127.0.0.1:9000:9000/udp -p 127.0.0.1:7778:7778/udp \
  -p 127.0.0.1:7375-7400:7375-7400/udp -p 127.0.0.1:7375-7400:7375-7400 \
  -p 127.0.0.1:7000-7374:7000-7374/udp -p 127.0.0.1:7000-7374:7000-7374 \
  eqmacemu/eqmacemu:latest     # Setup.bat uses its own eq-broll-server image here
```
- The image is 5.5 GB; the first pull took about 6.5 minutes here.
- **Differences from the upstream README:**
  - Every port is bound to `127.0.0.1`, so the server isn't reachable from the network.
  - MySQL (3306) isn't published; use `docker exec eq-broll-server mysql peq` instead.
  - **TCP 9000 is dropped** (see problem log #1). It's the world server's admin console, which the
    game client doesn't use.
- **Verify:** `docker logs eq-broll-server` should show `Connected to Loginserver` and several
  `Zone started` lines.
- **Stop / start later:** `docker stop eq-broll-server` / `docker start eq-broll-server`. The database
  lives in the `eq-broll-data` volume and survives both.

### 3. Client ✅ (login works) · 🟡 (Play crash on a VNC-only PC fixed with a virtual mouse; entering the world not yet re-tested; see problem log #2)
- **Dev PC:** used a separate copy of an existing TAKP install, so the normal install stays pointed
  at the live servers.
- **Clean PC needs:** the TAKP PC client v2.1 zip from the
  [TAKP Windows guide](https://wiki.takp.info/wiki/Getting_Started_on_Windows), unzipped to a folder
  such as `C:\TAKP`. Don't use `Program Files`. The guide warns antivirus sometimes deletes a
  client file, and recommends a Defender exclusion for the folder.
- **Point the client at the local server:** `eqhost.txt` in the client folder:
  ```
  [Registration Servers]
  {
  "127.0.0.1:6000"
  }
  [Login Servers]
  {
  "127.0.0.1:6000"
  }
  ```
- **Update two DLLs** 🟡. The TAKP guide now says to replace these two files, which "fix some long
  standing crash bugs" (see problem log #2):
  - `eqw.dll` from [CoastalRedwood/eqw_takp](https://github.com/CoastalRedwood/eqw_takp/releases/latest)
    (installed v1.0.2)
  - `eqgame.dll` from [EQMacEmu/eqgame_dll_takp](https://github.com/EQMacEmu/eqgame_dll_takp/releases/latest)
    (installed v0.0.0.3)

  The originals are backed up in `<client folder>\_orig\`.
- **High-DPI displays** (from the eqgame_dll_takp README): if the window is scaled wrong, open
  `eqgame.exe` Properties → Compatibility → Change high DPI settings → Override → "Application".

### 4. Log in ✅
- Run `eqgame.exe`. Log in with **any** username and password; the first time, you're asked twice
  and the account is created automatically.
- **Verified:** login, server list, and the login server's play response (server logs 15:41).

### 5. Automatic GM powers ✅ (flags set; in-game behaviour still being tested)
[`server/broll_gm.sql`](../server/broll_gm.sql) adds two database triggers:
- **New accounts:** status 255 (full GM) and god-mode flags (fly, GM run speed, invulnerable,
  hidden from other players).
- **New characters:** the GM flag. The server's NPC aggro checks skip GM characters, so nothing
  ever attacks you, and no faction editing is needed.

Apply with:
```bash
docker exec -i eq-broll-server mysql peq < server/broll_gm.sql
```
- **Verified 2026-09-27:** the first account (`test`) was created with status 255 and all four
  god-mode flags, and its first character (`Waan`) has `gm = 1`. Both triggers work.
- GM speed only takes effect after zoning once.
- **Accounts made before the triggers existed:**
  ```bash
  docker exec eq-broll-server mysql -e "UPDATE account SET status=255, flymode=1, gmspeed=1, gminvul=1, hideme=1 WHERE name='NAME'" peq
  ```
  Then log out and back in.

### 6. In-game test checklist ⬜
After creating a character and entering the world:

| Test | How | Result |
|---|---|---|
| GM flag on | `#set gm on` (should already be on) | ⬜ |
| God mode | `#set god_mode on`, then zone once so GM speed applies | ⬜ |
| Fly | look up/down (PgUp/PgDn or right-drag) + forward | ✅ works (2026-09-27) |
| No aggro | walk up to a hostile NPC | ⬜ |
| Invulnerable | take a hit | ⬜ |
| Teleport | `#zone gfaydark`, `#goto <x> <y> <z>` | ⬜ |
| Time / weather | `#set time <hour>`; `#set weather 1 0 30` | time ✅; weather ❌ server bug, patched (problem #3), re-test ⬜ |
| Hide UI for capture | ⬜ still to find the client's hide-UI toggle | ⬜ |

### Window vs. full screen
- `eqw.dll` has no hotkey for this (the old ReleaseMouse/EQWSwitch hotkeys are gone).
- The mode follows the game resolution:
  - **Resolution = monitor resolution** (e.g. 1920×1080): borderless, fills the screen.
    That's the best setup for OBS capture.
  - **Resolution smaller than the monitor:** a normal movable window.
- Change it in game: **Options window (Alt+O) → Display → resolution**. `eqw_takp` supports
  in-game mode changes without crashing.
- Or change `[VideoMode] Width/Height` in `eqclient.ini` while the game is closed. The client
  rewrites the file on exit.

### Draw distance (clip plane) 🟡
- **The problem:** classic zones set tiny view distances. Greater Faydark is `maxclip` 325 units with
  fog at 10–300, so while flying you see almost nothing.
- **Why the client slider can't fix it:** Options → Display → Clip Plane only moves between the
  zone's server-sent `minclip` and `maxclip`.
- **Where the values come from:** the server sends `minclip`/`maxclip` and fog distances in
  `OP_NewZone`, from the `zone` table (`zone/zone.cpp`).
- **Live test:** `#set zone clipping <min> <max> <fog min> <fog max>`. It re-sends `OP_NewZone`
  to everyone in the zone, so it applies without zoning. Add a trailing `1` to save it to the DB.
- **Catch:** the server's NPC update range (`maxclip + 50`) is only computed when the zone
  process boots. Distant NPCs keep moving only after the zone restarts with the new values.
- **Also turn off** Options → Display → Level of Detail. The updated `eqgame.dll` makes the game
  honour that choice instead of re-enabling it on every zone.
- **Test in gfaydark:** `#set zone clipping 500 10000 2000 9500`, slider at max, LOD off.
  Result: ⬜. Open question: does the 2002 client cap the far plane, or does its region
  visibility (BSP) cull distant areas anyway?

### Test zones
Picked from the server `zone` table. The sky number is the zone's sky type (1 = classic Norrath
blue); clip is the current `maxclip`. Get there with `#zone <short name>`.

| Test | Zone (`#zone …`) | Why | Sky / clip |
|---|---|---|---|
| Sky + ocean + boats | `erudsxing` Erud's Crossing | open ocean, boats sailing through | 1 / 1400 |
| Sky + ocean + islands | `oot` Ocean of Tears | islands, lots of water | 1 / 1400 |
| Draw distance, open land | `northkarana` N. Karana | huge flat plains; roaming animals | 1 / 1400 |
| Water + sky | `lakerathe` Lake Rathetear | big lake | 1 / 1400 |
| City NPCs + torches + water | `qeynos` South Qeynos | guards, merchants, harbour, canals; tiny clip (450) makes it a good before/after | 1 / 450 |
| Fire / lava | `lavastorm` Lavastorm | lava rivers, volcano, red fog | 1 / 1400 |
| Fire indoors | `soltemple` Temple of Solusek Ro | fire-themed dungeon | 0 / 1500 |
| Desert sky + water | `oasis` Oasis of Marr | desert sky, oasis lake | 2 / 1400 |
| Kunark sky, big terrain | `dreadlands` Dreadlands | very large open zone | 4 / 1800 |
| Velious sky + ocean + snow | `iceclad` Iceclad Ocean | frozen ocean; good snow test | 4 / 1800 |
| Luclin sky | `maiden` Maiden's Eye | Luclin skybox | 6 / 1000 |
| Luclin dark side | `twilight` Twilight | dark sky type | 7 / 1000 |
| Flying + distance | `airplane` Plane of Sky | floating islands | 3 / 2000 |
| Red sky | `fearplane` Plane of Fear | red sky type | 5 / 1400 |

**Day/night:** `#set time <hour> [minute]`, in any outdoor zone. Suggested stops: 6 (dawn),
12 (noon), 19 (dusk), 23 (night).

**Weather:** `#set weather <0|1|2> <0|1> <minutes>`. The first argument is off/rain/snow; the
second applies it server-wide. Try rain in `northkarana`, snow in `iceclad`. Only outdoor zones
show weather.

**NPC checks:**
- Walk straight into a guard in `qeynos`; it shouldn't react.
- In `northkarana`, watch whether distant roamers keep moving. That's the NPC update-range
  question from "Draw distance".

### 7. Recording ⬜
Planned: OBS "Window Capture" of the client at 1920×1080. `eqw.dll` goes borderless when the
`eqclient.ini` resolution matches the monitor.

---

## Useful GM commands (from the server source, `zone/gm_commands/`)

| Command | Does |
|---|---|
| `#set god_mode on\|off` | fly + GM speed + invulnerable + hidden, saved on the account |
| `#set gm on\|off` | GM flag; NPCs ignore you |
| `#set flymode 0-3` | 0 ground, 1 flying, 2 levitating, 3 water |
| `#set invulnerable on\|off` | can't take damage |
| `#set hide_me on\|off` | invisible to lower-status players |
| `#set gm_speed on\|off` | fast movement (zone to apply) |
| `#zone <short name> [x y z]` | go to a zone, optionally to a spot |
| `#goto x y z` | teleport within the zone (or to your target) |
| `#set time`, `#set weather` | lighting and weather for the shot |
| `#size`, `#set race`, `#set texture` | change your own look (illusions) |
| `#depop`, `#repop`, `#kill` | clear or respawn NPCs in the shot |

---

## Problem log

**#1 · "Bind for 127.0.0.1:9000 failed: port is already allocated"** (dev PC, 2026-09-27)
- **Symptom:** the upstream `docker run` publishes 9000 for both TCP and UDP.
- **What we ruled out:** nothing was listening on 9000 (Windows `netstat`, WSL `ss`, other
  containers), and it isn't in a Windows reserved port range.
- **Fix:** don't publish TCP 9000. It's the world's telnet/admin console; the client only needs
  UDP 9000.
- **Clean PC:** may not hit this at all, but dropping the port costs nothing.

**#2 · Client "memory error" crash when clicking Play at server select** (dev PC, 2026-09-27)
- **Server side, fine:** the login server authenticated the account, sent the server list, and sent
  the play response. The world server never saw a connection.
- **Client side:** `dbg.txt` stops at `Execute point A...`. A successful session continues
  `B... C... Display init... net_connect`, so the client died in the hand-off from the login
  screens to the game, before graphics or networking.
- **Likely cause:** outdated client DLLs. The TAKP guide's Nov-2025 `eqw.dll` + `eqgame.dll`
  update fixes known crash bugs on modern Windows, including a fast-CPU timing bug. the dev PC's client
  predates it (files dated 2024-03-11).
- **Also noted:** this install last connected to Project Quarm, not TAKP (`dbg.txt`, July 2024).
  Quarm uses the same client, but that history is worth keeping in mind.
- **Fix applied:** new DLLs copied into the client folder (step 3).
- **Re-test with the new DLLs: same crash.** Windows reports "instruction at 0x0055A01E referenced
  memory at 0x00000000", and `dbg.txt` again stops at `Execute point A`.
- **What the crash actually is:** from disassembling `eqgame.exe`:
  - Right after `Execute point A`, the client creates its DirectInput devices: the keyboard via
    `0x55b7bc`, stored at `0x8092e0`, and the mouse via `0x55b60c`, stored at `0x8092e4`.
  - It ignores both functions' error codes, then calls `Acquire()` (vtable `+0x1c`) on each.
  - The keyboard `Acquire` at `0x55a013` succeeds.
  - The mouse pointer is **null**, so `IDirectInput::CreateDevice(GUID_SysMouse)` failed.
    If a later mouse-setup step had failed instead, the pointer would be non-null.
- **So:** a client ↔ Windows DirectInput problem. The server isn't involved, and no networking
  has happened yet at this point.
- **Test: original install against the live TAKP server → same crash.** A machine-level cause,
  not our setup.
- **Fresh client download (v2.1c zip, 2,637 files / 96 folders):** its `eqgame.exe`, `eqgame.dll`,
  `eqw.dll`, `eqmain.dll`, `eqgfx_dx8.dll`, `D3D8.dll` and `dgVoodoo.conf` are all byte-identical to
  the existing install, so reinstalling can't fix it.
- **Root cause (probable): no physical mouse attached.**
  - Windows lists three "HID-compliant mouse" devices, all *not present*.
  - There's no pointing device at all (`Win32_PointingDevice` is empty) and no keyboard-class
    device either.
  - The dev PC is driven remotely over VNC with no mouse plugged in. VNC injects
    cursor input and needs no mouse device. DirectInput's `GUID_SysMouse` needs a real one.
- **Fix to try:** plug any USB mouse (or wireless dongle) into the PC, even if it's never used,
  then re-test. If there's truly no way to attach hardware, a virtual HID mouse driver is the
  software equivalent.
- **Confirmed and fixed (2026-09-27):**
  - [`server/windows/check_mouse.ps1`](../server/windows/check_mouse.ps1) reproduces the failing call
    outside the game. Before the fix: `SM_MOUSEPRESENT=0`, `SysMouse: CreateDevice hr=0x80040154`.
  - **Fix:** a virtual mouse, the *Unified Virtual HID* driver. It's WHQL-signed by Microsoft's
    Windows Hardware Compatibility Publisher, so no test-signing mode is needed.
  - Only the driver was installed, not the Unified Remote server app (which listens on the network).
    The files came out of the Unified Remote Server 3.13.0 installer via `innoextract`:
    `uvhid.inf/.sys/.cat` plus their `uvhid.exe` install tool, kept in `C:\temp\uvhid\`.
  - Installed with an elevated `uvhid.exe install uvhid.inf`: one UAC prompt, approved over VNC.
  - After the fix: two present "HID-compliant mouse" devices, `SM_MOUSEPRESENT=1`,
    `CreateDevice hr=0x00000000`.
  - **Uninstall:** elevated `C:\temp\uvhid\uvhid.exe remove`.
- **Delivery impact:** probably none. Someone playing at the PC has a mouse plugged in. Worth a
  line in troubleshooting: "remote desktop / VNC-only PCs crash on Play".
- **Earlier tests (kept for the record):**
  1. Launch `eqgame.exe` by double-clicking it in Explorer. Both crashes so far were launched from
     WSL through PowerShell `Start-Process`.
  2. If it still crashes, run the original install against the
     live TAKP login server. A crash at the same point there means a machine-level cause (Windows
     update, input drivers), not our setup.
- **Other things to try:**
  1. Try without the `D3D8.dll` wrapper (dgVoodoo), or with `d3d8to9` instead.
  2. Check the high-DPI setting in step 3.
  3. Try the TAKP v2.2 client package.
  4. Rebuild the image with `--build-arg DISABLE_CHECKSUM=true`. The upstream Dockerfile offers
     this for Quarm-flavoured clients.

**#3 · `#set weather` always says "Turning off weather"** (2026-09-27)
- **Cause:** a server bug. The command moved from `#weather` to `#set weather`, which shifts every
  argument right by one, but `zone/gm_commands/set/weather.cpp` still checks the old positions.
  - `IsNumber(1)` now looks at the word `weather`, so the weather type always stays 0 (off).
  - The server-wide and duration arguments are off by one in the same way.
- **Fix:** [`server/patches_set_weather.diff`](../server/patches_set_weather.diff), three index
  changes. Applied inside the container, then only the zone server was rebuilt
  (`cd /src/build && ninja zone`, about 2 minutes) and the container restarted.
- **Persistence:** the patch lives in the container's filesystem. It survives
  `docker restart`/`stop`/`start`, but **not** recreating the container from the image. The
  delivery build should bake it into our own image. Also worth sending upstream to EQMacEmu.
- **Usage after the fix:** `#set weather 1 0 30` rain for 30 minutes (this zone),
  `#set weather 2 0 30` snow, `#set weather 0` off. To switch between rain and snow, turn it off
  first; the server refuses to change weather type directly.

---

## Open decisions
- **Delivery:** Docker Desktop (heavy prerequisites) vs. a native Windows server build vs. a
  bundled installer that hides all of this.
- **Which client your friend has:** the TAKP client is a free download; whether a P99 client works
  hasn't been checked.
- **Admin tools:** probably a small panel of saved commands (teleport to a saved spot, time of day,
  weather, clear NPCs). Camera moves stay manual in the real client.
