# Shrines Renaming — Status & Source Data

Working doc for the multi-session item/monster rename project. Source
of truth is `shrines.rpgclassics.com/nes/ff3/{spells,items,weapons,armor,enemies}.shtml`.
Raw fetched content cached here so future sessions don't need to re-fetch.

## Status

| Surface | Shrines override | Icons rendered | Deploy |
|---|---|---|---|
| Spells (56 player-castable) | ✅ shipped | ✅ shipped | v1.7.241–242 |
| Items (200 ROM entries) | ✅ shipped v1.7.246 (`ITEM_NAMES_SHRINES`, 159 entries) | ✅ shipped v1.7.245 (font atlas extended to load $60–$6F icon tiles + `getItemNameWithIcon` at 9 render sites) | v1.7.245–246 |
| Monsters (~231 bestiary entries) | ✅ shipped v1.7.247 (`MONSTER_NAMES_SHRINES`, 184 entries) | n/a (no icons in monster names) | v1.7.247 |
| Jobs (22 entries) | ✅ shipped v1.7.248 (`JOB_NAMES_SHRINES`, 22 entries) | n/a (no icon, no ROM fall-through) | v1.7.248 |

## Pattern (proven on spells, replicate for items/monsters)

1. **Build override map** in `src/data/<thing>.js`: `Map<romId, shortName>`.
   Cap at 5 chars where possible (matches Shrines' display constraint).
2. **Add helper** in `src/text-decoder.js`: `get<Thing>NameShrines(id)`
   returns `[romIconByte] + [encodedAsciiBytes]` when override present,
   falls through to `get<Thing>NameWithIcon(id)` for the enemy-only tail.
3. **Wire into render sites** — only the player-facing list/inventory
   rows. Battle-log strings, message-strip lines, chat, and any
   mid-sentence usages stay on the `Clean` path so the name renders as
   plain ASCII without the icon glyph mid-text.
4. **Don't tighten layouts in the same conversation** — the
   width-saving rename frees real-estate; user reaction in v1.7.243→244
   was "way too tight" when we 2-col'd the pause Magic grid and pulled
   the MP cost flush against the name. Leave the breathing room.

## ROM icon byte ranges

| Range | Used by | First-byte distribution (from histogram scan) |
|---|---|---|
| `$60` | Shield | 10 items (Leather Sh / Onion Sh / Mythril Sh / Ice Shield ...) |
| `$61` | Body armor | 25 items (Vest / Leather Armor / Onion Armor / Mythril ...) |
| `$62` | Helm | 16 items (Leather Cap / Onion Helm / Mythril Helm ...) |
| `$63` | Bracer / Gloves | 13 items (Bronze Bracer / Iron Gloves / Mythril Glv ...) |
| `$64` | Claw | 8 items (Kaizer / Cat Claws / Wyvern / Faerie Claws ...) |
| `$65` | Book | 6 items (Fire Book / Ice Book / Fire Tome / Light Book ...) |
| `$66` | Rod | 12 items (Mythril Rod / Flame Rod / Ice Rod / Light Rod ...) |
| `$67` | Hammer | 2 items (Mjolnir / Triton Hammer) |
| `$68` | Spear | 4 items (Thunder Spear / Wind Spear / Blood Lance / Holy Lance) |
| `$69` | Dagger / Knife | 6 items (Knife / Dagger / Mythril Knife / Main Gauche / Air Knife / Orialcon) |
| `$6a` | Axe | 4 items (Battleaxe / Dual Haken / Sharur / Dual Tomohawk) |
| `$6b` | Sword | 16 items (Longsword / Wightslayer / Gold Sword / Mythril Swd ...) |
| `$6c` | Katana | 4 items (Ashura / Kotetsu / Chrysanthemum / Masamune) |
| `$6d` | Harp | 3 items (Madhra Harp / Lamia Harp / Loki Harp) |
| `$6e` | Bow | 13 items (Bow / Great Bow / Killer Bow / Rune Bow / Yoichi ... + arrows) |
| `$6f` | Bell | 3 items (Diamond Bell / Earthen Bell / Rune Bell) |
| `$70` | (overlap with font atlas) | 2 — Boomerang, Moonring |
| `$71` | (overlap with font atlas) | 1 — Shuriken |
| `$72` | Summon (magic) | 8 spells |
| `$74` | White Magic | 24 spells |
| `$75` | Black Magic | 24 spells |
| `$7b` | Consumable (potion bottle) | 10 items (Potion / HiPotion / Elixir / PhoenixDown / Antidote ...) |
| `$ff` | No icon (leading space) | 35 items — Magic Key, Gysahl Greens, Dwarf Horn, etc. |

v1.7.245 extended `FONT_TILE_START` from `$70` to `$60` (count 144→160)
so all of `$60`–`$7B` icon graphics now load into the font atlas.

## A.W. Jackson icon overrides (v1.7.278–v1.7.282)

Chaos Rush packs visually-distinct item families under one icon byte
in six places. Lifted tile bytes from the A.W. Jackson translation
(local cache: `/tmp/ff3-aw/FF3E.IPS`) and parked them at unused
Chaos Rush slots; `text-decoder.js` reroutes the affected item IDs.

| Slot | Used by | Source | Items |
|---|---|---|---|
| `$73` | Spear (with head) | A.W. `$EC` | #1A-#1D (Thunder/Wind Spear, Blood/Holy Lance) — replaces generic `$68` |
| `$76` | Claw | A.W. `$E6` | #01-#05 (Kaizer / Cat / Wyvern / Faerie / Hellish) — split from nunchaku `$64` |
| `$77` | Arrow | A.W. `$F3` | #4F-#56 (Wooden / Holy / Iron / Bolt / Fire / Ice / Medusa / Yoichi) — split from bow `$6E` |
| `$78` | Bracer / Ring | A.W. `$E5` | #8B, #8E, #91-#93, #95 (Bronze/Mithril/Power/Rune/Diamond Brc + Protect Ring) — split from gauntlet `$63` |
| `$79` | Staff | A.W. `$EA` | #0E-#14 (Staff / FlameStaff / IceStaff / LightStaff / GolemStaff / RuneStaff / ElderStaff) — split from rod `$66` |
| `$7A` | Mail (heavy armor) | A.W. `$E2` | #74-#78, #7C, #7E, #7F, #83-#85, #88-#8A — split from robe-style `$61` |

Each override is a 4-step plumbing change: drop 16 tile bytes in
`font-renderer.js`, register the slot, add `XXX_ITEM_IDS` +
`XXX_ICON_BYTE` to `text-decoder.js`, and branch in both
`getItemNameWithIcon` and `getItemNameShrines`. Untouched
single-subtype icons (shield / helm / book / hammer / knife / axe /
sword / katana / harp / bell / boomerang / shuriken / consumable /
gauntlet) were confirmed visually clean against A.W. Jackson and
need no swap.

## Cached Shrines data (fetched 2026-05-11)

### Spells — already shipped, see `src/data/spells.js#SPELL_NAMES_SHRINES`

WM L1: Pure / Cure / Sight  · L2: Aero / Toad / Mini  · L3: Cure2 / Wash / Exit
   L4: Libra / Confu / Mute  · L5: Cure3 / Life / Safe  · L6: Aero2 / Soft / Haste
   L7: Cure4 / Wall / Heal  · L8: WWind / Life2 / Holy

BM L1: Sleep / Fire / Ice  · L2: Bolt / Venom / Blind  · L3: Fire2 / Ice2 / Bolt2
   L4: Ice3 / Shade / Break  · L5: Bolt3 / Erase / Kill  · L6: Fire3 / Bio / Warp
   L7: Brak2 / Quake / Drain  · L8: Flare / Death / Meteo

SUM: Chocb / Shiva / Ramuh / Ifrit / Titan / Odin / Levia / Baham

### Consumables (Shrines names)

| Name | Price | Effect |
|---|---|---|
| Potion | 75 | Restores up to 300 HP |
| HiPotion | 600 | Restores up to 500 HP |
| Elixir | 1500 | Restores all HP and MP |
| FenixDown | 1500 | Cures Dead status |
| Antidote | 40 | Cures Poison |
| Eyedrop | 20 | Cures Blind |
| EchoHerb | 50 | Cures Mute |
| Soft | 150 | Cures Stone |
| LuckMallet | 50 | Toggles Mini |
| MaidKiss | 50 | Toggles Toad |

### Battle-Only Items (Shrines names)

BombShard / SouthWind / Zeus'Rage / BombR.Arm / NorthWind / Gods'Rage
BombHead / MuteCharm / Pillow / OtterHead / BlackHole / ChocoRage
DarkScent / WhiteScent / Barrier / TurtlShell / Gods'Wine / LilithKiss
LamiaScl. / Imp'sYawn / Paralyzer / SplitShell / Devil'sSigh

### Field Items
Magic Key / MidgBread / Carrot

### Key Items (Story)
EarthFang / Eye / EurekaKey / FireFang / Horn / Lute / SylxKey / TimeGear /
WaterFang / WindFang

### Weapons (Shrines names, by type)

- **Swords (16):** Ancient / Blood / Break / Defender / Excalibur / IceBlade /
  King / Long / Mithril / Onion / Ragnarok / Salamand / Serpent / Shiny /
  Tyrving / W.Slayer
- **Knives (6):** AirKnife / Dagger / Knife / M.Gauche / Mithril / Orialcon
- **Axes (4):** Battle / GreatAxe / M.Star / Tomohawk
- **Hammers (3):** Hammer / Thor / Triton
- **Spears (4):** Blood / Holy / Thunder / Wind
- **Bows (5):** Bow / GreatBow / Killer / Rune / Yoichi
- **Arrows (8):** Bolt / Fire / Holy / Ice / Iron / Medusa / Wooden / Yoichi
- **Claws (5):** CatClaw / Dragon / Elven / HellClaw / Kaiser
- **Staves (7):** Burning / Eldest / Freezing / Golem / Rune / Shining / Staff
- **Rods (5):** Flame / Ice / Light / Mithril / Ultimate
- **Harps (4):** Dream / Lamia / Loki / Madora
- **Bells (3):** Earth / Giyaman / Rune
- **Katanas (4):** Ashura / Kiku / Kotetsu / Masamune
- **Boomerangs (2):** Boomerang / FullMoon
- **Books (6):** Blizzard / Flame / Ice / Illumina / Inferno / Light
- **Nunchuku (3):** 3-Part / Nunchuck / Tonfa
- **Shuriken (1):** Shuriken

### Armor (Shrines names, by slot)

- **Shields (10):** Aegis / Crystal / Demon / Diamond / Genji / Hero / Ice /
  Leather / Mithril / Onion
- **Headgear (16):** Carapace / Chakra / Crystal / DarkHood / Diamond / Dragon /
  Feather / Genji / Headband / Ice / Leather / Mithril / Onion / Ribbon /
  Scholar / Viking
- **Body Armor (14):** Carapace / Crystal / Demon / Diamond / Dragon / FlameMail /
  Genji / Ice / Knight / Mithril / Onion / Reflect / Rusted / Viking
- **Robes (11):** Bard / BlackBelt / BlackRobe / Cloth / DarkSuit / Gaia / Kenpo /
  Leather / Scholar / WhiteRobe / Wizard
- **Gloves (7):** Crystal / Diamond / Gauntlet / Genji / Mithril / Onion / Thief
- **Rings (6):** Copper / Diamond / Mithril / Power / Protect / Rune

## Next-session todo

All four name surfaces (spells, items, monsters, jobs) shipped. Future
follow-ups, if requested:

- Add punctuation tile mappings to `_asciiToTileByte` so Shrines names
  with `'` (Zeus'Rage / Imp'sYawn / Devil'sSigh) and `.` (M.Gauche /
  BombR.Arm) round-trip cleanly through the spell/item override path.
- Re-audit the omitted battle items + 40 omitted monsters once we have
  authoritative Shrines pairings (Larva, Helldiver, Parademon, etc.).
- If user wants Shrines variant in `/job` console output and the debug
  sprites tab too, swap those callers to `JOB_NAMES_SHRINES`.

## Monsters shipped notes (v1.7.247)

- 224 ROM entries (in `MONSTERS` Map) → 184 overrides. Skipped 40
  where the Shrines name was ambiguous or absent (Larva, Helldiver,
  Parademon, Far Darrig, Hellgaroo, Dracrocotta, HelgaruMage, Noggle,
  Kagura, KierHermit, Gaap, Aeon, Drake, Azer, ShadwMaster,
  GlasLabolas, Demon Xande, duplicate Bahamut at 0xD6, two unused
  dummies). Those fall through to ROM bytes.
- Periods in Shrines names ("Bone D.", "K. Lizard", "Liger S.",
  "Q.Lamia") are dropped on render — `_asciiToTileByte` collapses
  punctuation to space ($FF). Mostly invisible because punctuation is
  trailing.
- Only the in-battle name box (`_battleEnemyName` +
  `_battleEnemyNames`) was switched. Battle-log message queue stays on
  `getMonsterName` so sentences like "Goblin attacks!" still read
  cleanly with the longer Shrines variant.

## Items shipped notes (v1.7.246)

- 200 ROM entries → 159 overrides. Skipped: unused ROM IDs in `ITEMS`
  Map (0x00, 0x47, 0x57, 0xa5, 0xb0, 0xb7, 0xbd, 0xc0, 0xc1, 0xc2,
  0xc4) and battle items where the Shrines pairing was ambiguous
  (Oershroom / Earth Drum / Black Musk / Tranquilizer).
- Same-name collisions on shared icons (e.g., two "Mithril" gloves
  $63 — one bracer, one gauntlet) are intentional and match Shrines
  list convention. If the user wants disambiguation, suffix the
  override values with " G" / " R" in `ITEM_NAMES_SHRINES`.
- Punctuation in Shrines names (apostrophes, periods) was stripped
  because `_asciiToTileByte` only encodes A-Z/a-z/0-9. If we add
  punctuation tile mappings later, revisit "Zeus'Rage" / "Imp'sYawn"
  / "Devil'sSigh" / "M.Gauche" / "BombR.Arm".
