# race_models.json: sources and caveats

`race_models.json` maps EQEmu `npc_types.race` (1-330) and `npc_types.gender` (0/1/2) to the
client actor code (`<CODE>_ACTORDEF` in `*_chr.s3d`). Every race has all three gender keys.
When a gender's own model does not exist, it falls back to male, then neutral, then female.
Races 127 and 240 are `null` because they are not drawn.

## Sources (three agree)

1. **The TAKP client's own `eqgame.exe`**, used as ground truth
   (`eqgame.exe` from the TAKP PC V2.1 client, 2,863,104 bytes, dated 2024-03-11).
   The function that builds race codes is at VA `0x50845d`. It uses a `switch(race)` over races
   13-330 (jump table at `0x50914e`) that pushes either a 3-letter code (neutral) or a
   2-letter prefix. The common tail then appends `M` for gender 0 or `F` for gender 1. For
   gender 2 it calls a helper at `0x50839c` that appends a suffix for certain races (for example
   AV+I gives AVI, WO+L gives WOL, CO+K gives COK, ST+G gives STG, and GO+L, CE+N, VR+M and TP+N
   follow the same pattern). Playable races 1-12, 128, 130 and 330 go through `0x509646`.
   Races above 330 are unknown to this client and render as HUM/HUF, which is why the JSON stops
   at 330.
   I recovered the table by disassembling with capstone. The extraction was a one-off script (not included).
2. **Shendare/EQRaceInventory**: https://github.com/Shendare/EQRaceInventory. It parses the same
   hard-coded table out of the Titanium `eqgame.exe`. I used its generated
   `Titanium_EQRaces.htm` (release asset,
   https://github.com/Shendare/EQRaceInventory/releases/latest/download/Titanium_EQRaces.htm).
   It matches the TAKP exe for every race 1-330 except two:
   - 71 (QC Human) female: Titanium says QCN, but the TAKP exe and eqsage say QCF. QCF exists in
     the client.
   - 147 (Iksar Spirit) neutral: Titanium says SIN, but the TAKP exe gives "SI", which is not a
     model. Mapped to SIM.
3. **knervous/eqsage** `src/viewer/common/raceData.json`:
   https://github.com/knervous/eqsage/blob/master/src/viewer/common/raceData.json. It
   disagrees with Titanium on only 6 of races 1-400: 71, 72, 73, 141, 252 and 367. These are
   ship, boat and launch object models and a Titanium-only race.

**Existence check:** I parsed all 263 `*_chr*.s3d` / `global*.s3d` archives in the TAKP client
directly (PFS directory, then the WLD string hash, then `*_ACTORDEF` names). That gave 364
actor codes. The choice for each (race, gender) is the first candidate that exists in the client.
The results were then checked against the Lantern export at `/mnt/c/temp/lantern-chars/Exports`
(356 codes after it finished at 14:40).

## Coverage of races_used.tsv (122,239 spawns)
- 3,639 spawns are race 127 (Invisible Man) and map to null.
- 118,600 spawns, which is 100% of the drawable spawns, map to a code that exists in the client s3d files.
- 116,349 spawns (98.1% of the drawable spawns) map to a code that exists in the Lantern export.
  The 2,251 missing spawns all come from 9 archives that Lantern failed to export (`fails.txt`:
  bothunder, hollowshade, jaggedpine, pofire, poinnovation, postorms, powater, solrotower,
  twilight).

## Mapped codes missing from the Lantern export (they exist in the client)
The spawn count follows each code.

| Code | Race | Spawns |
|---|---|---|
| SRG | Solusek Ro Guard (254) | 572 |
| SSA | Giant (307) | 419 |
| BRC | Broken Clockwork (274) | 316 |
| SVO | Giant (309) | 295 |
| CLG | Clockwork Golem (248) | 190 |
| TIN | Tin Soldier (263) | 173 |
| SKR | Giant (308) | 155 |
| WMP | Water Mephit (271) | 74 |
| STF | Giant (311) | 33 |
| CWB | Clockwork Beetle (276) | 14 |
| CLB | Clockwork Brain (249) | 3 |
| JUB | Junk Beast (273) | 2 |
| TMR | Tarew Marr (246) | 1 |
| SRO | Solusek Ro (247) | 1 |
| KAR | Karana (278) | 1 |
| GLC | Giant Clockwork (275) | 1 |
| SCE | Giant (312) | 1 |

Fixing the export of the 9 failed archives, or pulling these codes from another archive that
has them, would close the gap.

Export naming quirks:
- Lantern writes race 154 FDR as `fdf.gltf` in airplane. FDR itself is present elsewhere in the export.
- Some archives export skeleton-only names: ELS, OGS and GNS.
- Some static object actors are exported: CBGOND101, ERLAUNCH, HFERRY and similar.

## Races I could not map with confidence (no model in the TAKP client)
None of these appear in races_used.tsv. The JSON keeps the exe/Titanium code as a placeholder:
32 Ghost (GHM/GHF), 84 Snake Elemental (SNE), 97 Daisy Man (DIA), 115 Clam (CLA),
132 Draglock (DLK), 152 Bertoxxulous (BER), 182 Faun (FAN), 186 Hippogriff (HIP),
197 Ronnie Test (RON), 204 Evan Test (ECS), 252 Mini POM (MINIPOM200), 262 Tranquilion (TRQ),
282 Skeletal Horse (HSS), 301 Test Object (ONT), and 330 Froglok (FRM/FRF). For 330,
globalfroglok_chr only has FRG/FRO, so FRG is the likely practical substitute.

## Lower-confidence mappings
- 72 Ship, 73 Launch and 141 Boat map to SHIP/PRE, LAUNCHM/LAUNCH and BOAT. These are static
  actors with no skeleton, and together they account for 72 spawns. Consider not drawing them.
- Gendered fallbacks where the gender's model doesn't exist: 42 Wolf male uses WOL (no WOM),
  147 Iksar Spirit uses SIM, and 16/17/56/25 fall back to their neutral or other-gender model.
- Races forced to null: 127 Invisible Man (IVM, a real but invisible actor) and 240 Teleport
  Man (TPM/TPF/TPN). Race 240 is "Teleport Man", not "Zone Controller", and it does not appear
  in races_used. I found no other controller-type races among races 1-330. Race 329 "BoT Portal"
  (BTP) is a visible portal model and is kept.

## Default sizes (playable races)
From EQMacEmu/Server `common/races.cpp` `GetRaceGenderDefaultHeight()`
(https://github.com/EQMacEmu/Server/blob/main/common/races.cpp). EQEmu/Server has the same table.
It is indexed by race id, covers ids 0-731, and races above that default to 6.0. Male and female
values are identical for playable races.

Human 6.0, Barbarian 7.0, Erudite 6.0, Wood Elf 5.0, High Elf 6.0, Dark Elf 5.0, Half Elf 5.5,
Dwarf 4.0, Troll 8.0, Ogre 9.0, Halfling 3.5, Gnome 3.0, Iksar (128) 6.0, Vah Shir (130) 7.0.
The same function gives the default for every NPC race, which is useful when `npc_types.size` is 0.
