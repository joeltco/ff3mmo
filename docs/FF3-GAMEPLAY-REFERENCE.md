# FF3 gameplay reference for the audit

Research date: 2026-09-12. Scope: the original Famicom/NES Final Fantasy III.

## Project direction

Joel's explicit rule: bossless dungeons are completed by finding the end.
Keep the existing game's procedural exploration, Word Memory conversations,
personal story flags, and multiplayer adaptations as the design baseline.
Original-game references establish a location's purpose; they do not override
the project's deliberate changes, such as the early canoe reward.

## Reference library

- [NES walkthrough, first half](https://shrines.rpgclassics.com/nes/ff3/walk1.shtml): opening through Goldor.
- [NES walkthrough, second half](https://shrines.rpgclassics.com/nes/ff3/walk2.shtml): Saronia through the ending, including optional areas.
- [Map index](https://shrines.rpgclassics.com/nes/ff3/maps.shtml).
- [Jobs](https://shrines.rpgclassics.com/nes/ff3/jobs.shtml), [spells](https://shrines.rpgclassics.com/nes/ff3/spells.shtml), and [player reference](https://shrines.rpgclassics.com/nes/ff3/manual.shtml). These are community references, not proof of exact formulas.
- [Original Japanese manual scan index](https://www.gamingalexandria.com/wp/2019/11/final-fantasy-iii/): located; scan contents have not been reviewed in this pass.
- [Disassembly and ROM documentation](https://github.com/everything8215/ff3): assembly, field/battle RAM, ROM map, event commands, and Japanese/translated text. Consult the underlying routines for technical claims; this pass located the repository and inspected the event-document page, not every routine.
- Existing local evidence: [ROM catalogs](ROM-CATALOGS.md), [script catalog](FF3-SCRIPT.md), [items](FF3-ITEMS.md), [shops](FF3-SHOPS.md), [monsters](FF3-MONSTERS.md), [door graph](ROM-DOOR-GRAPH.json), and [tilemap measurements](ROM-LIVE-TILEMAPS.json).

Names differ between translations: Sasune/Sassoon, Canaan/Cannan,
Saronia/Salonia, Doga/Dorga, Unei/Unne, Hein/Hyne, and Crystal/Sylx Tower.
Bind implementation work to verified map/event/monster IDs.

## Original progression and dungeon purposes

Early route: Altar → Ur/Kazus/Sasune → Sealed Cave → Canaan →
Dragon's Peak → Tozas/Hidden Road → Vikings/Nepto → Owen →
Underground Lake/Flame Cave → Hein → flying Enterprise →
Shipwreck/Water Temple/Water Cave → Amur Sewers → Goldor.

Altar and Flame Cave culminate in crystal access. Sealed Cave, Nepto,
Owen, Underground Lake, Hein, Water Cave, and Goldor have boss objectives.
Hidden Road is a passage; Mythril Mine is a treasure excursion. Dragon's
Peak's early Bahamut encounter requires escape, not victory. Amur Sewers
leads to the shoes needed for the next route and contains a scripted Goblin
fight rather than a conventional final boss. Mini and Toad also act as
access requirements. [Source: first-half walkthrough](https://shrines.rpgclassics.com/nes/ff3/walk1.shtml).

Later route: Saronia/Garuda → Nautilus → Doga/Magic Circle →
Temple of Time → Unei → Ancient Ruins/Invincible → Cave of Darkness →
Doga's Cave and Ancient Labyrinth → Eureka/Crystal Tower → Dark World.

Bossless destinations include Dragon Spire (equipment), Magic Circle
(event), Temple of Time (lute), Ancient Ruins (airship), Underwater Cave
(treasure with guarded chests), and Falgabard's cave (equipment).
Optional summon bosses occupy Saronia Catacombs, Lake Dohr, and Bahamut's
Cave. Ancient Labyrinth combines Titan/crystal access with a through-route;
Eureka has multiple optional weapon guardians. These need more than a
universal final-room boss template. [Source: second-half walkthrough](https://shrines.rpgclassics.com/nes/ff3/walk2.shtml).

The location-purpose summary is a research baseline. It is not an exhaustive
event dependency graph or a verified balance table. Guarded treasure and
scripted encounters should be recorded separately from dungeon completion.

## Confirmed implementation gap

`src/data/dungeons.js` declares only `crystal` and `boss` ending kinds.
`isBossFloor()` unconditionally identifies the last floor as a boss floor;
the layout validator requires `floors - 1` ordinary floor layouts.
`src/dungeon-generator.js` uses that distinction to carve the final chamber.
Consequently, adding a bossless row alone cannot express Joel's rule.

The next implementation should explicitly model reaching an endpoint as a
completion condition. Its final map, exit destination, and any story reward
must be representable without spawning a boss or entering boss-death logic.
Existing Altar and Seals behavior should retain their current endings.

For the audit, exercise the complete walk: discover the lead, gain access,
navigate the generated route, reach its endpoint, receive the intended
transition, and reload the resulting save. Check optional treasure branches
independently. Passing a boss-kill test says nothing about a bossless run.

No gameplay code was changed during this reference pass.
