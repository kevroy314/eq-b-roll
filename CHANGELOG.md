# Changelog

## 1.1.0 (2026-09-29)

Studio:
- **Every zone in your client.** The zone list shows all of them. Zones you haven't used yet are
  exported from your EverQuest client the first time you pick one (about a minute), and "Export all
  zones" does the rest in the background while you keep working.
- **Day and night.** A time-of-day control with a time-lapse. The sun moves east to west, the moon
  and stars come out, and the sky, fog and scene are tinted. Fires and other glows stay bright at
  night. The time-lapse plays in previews and renders, exactly the same every time.
- **Speed.** One fly-speed control from 1 to 20,000 units/s, presets on keys 1-6 (walk, run, mount,
  griffon, fly-by, warp), and an adjustable Shift boost. Keyframe paths get the same range, for
  fly-by shots across a whole zone.
- **Staged fights.** Place a player (any classic race, gender, armour and helm) and any NPC from the
  zone, then press Fight: the NPC runs in and they trade blows, with flinches and an optional death
  at the end. The stage is saved with the shot and renders identically every time.
- **Version and updates.** The panel shows the version and says when a newer one is out.
  **Update.bat** updates in place and keeps your zones, takes, renders and settings.

Fixes:
- NPCs that borrow another model's animations could be left frozen in their default pose when a
  single bone name didn't match (all Qeynos guards were affected). They now animate.

## 1.0.0 (2026-09-27)

First release: one-click Windows setup for filming in the real game on a private EQMacEmu server
(fly, can't die, no aggro, weather, time of day, long view distance), and the Studio renderer with
keyframe and recorded camera paths, EQ skies, doors, NPCs with patrols, and frame-perfect MP4.
