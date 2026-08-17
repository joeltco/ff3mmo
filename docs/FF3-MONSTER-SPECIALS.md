# FF3 monster special attacks — byte 14 (`spAtkIdx`)

Swept from the running game: every monster spawned alone, `spAtkRate` forced to
`0xFF` and its HP raised so it survives to act, then the battle strip read.
232/232 fought. **45 distinct values** — the previous decode had 8.

⛔ Signature words are those seen in **≥40%** of the monsters sharing a value, so
per-monster names drop out. Groups of one keep their name; marked ⚠.
⛔ Battle-font glyph rows (`ABCD`, `DCBA`, `zyxwvu`) are filtered structurally.

| byte 14 | monsters | natural rates | behaviour (names stripped) | example |
|---|---|---|---|---|
| `0x00` | 131 | 0x50 0x46 0x5A | Miss. | Goblin |
| `0x02` | 5 | 0x32 0x46 0x5A | Thunder Miss. Back attack. | ChimeraMage |
| `0x04` | 1 | 0x1E | Miss. Earthquake | Aeon |
| `0x05` | 2 | 0x23 | Glare effect Miss. | Carbuncle |
| `0x06` | 2 | 0x64 0x63 | Back attack. Par cleBeam died New | C |
| `0x07` | 3 | 0x32 0x3C | Assessing Miss. | Bomb |
| `0x08` | 6 | 0x14 0x28 0x32 | Glare Miss. effect | CursdCopper |
| `0x09` | 6 | 0x1E 0x28 0x32 | Glare CNF. Miss. | Rust Bird |
| `0x0A` | 5 | 0x14 0x28 0x32 | Bad Breath effect Miss. | Mandrake |
| `0x0B` | 1 | 0x3C | Back attack. Mind Blast PRLZ. effect | Kunoichi |
| `0x0C` | 1 | 0x19 | Back attack. Summon Monster summoned. | Bluck |
| `0x0D` | 1 | never (0) | Bite Extended neck | Adamantoise |
| `0x0F` | 3 | 0x28 | **3/3 MULTIPLY 1→2** Multiply Called ally. Miss. | Azrael |
| `0x10` | 7 | never (0) | **7/7 MULTIPLY 1→3** Assessing Miss. Divided. | Silenus |
| `0x11` | 1 | 0x41 | Back attack. Zantetsuken Miss. | Odin |
| `0x12` | 1 | 0x46 | Back attack. Tidal Wave Miss. | Leviathan |
| `0x13` | 1 | 0x50 | Miss. Mega Flare died New Game | Bahamut |
| `0x14` | 1 | 0x14 | Summon Monster summoned. Miss. | Great Demon |
| `0x15` | 2 | 0x63 | Drain Miss. | Doga Clone |
| `0x16` | 2 | 0x63 | Reflect Barrier Miss. | Unei Clone |
| `0x17` | 2 | 0x50 0x32 | Thunder | Petit |
| `0x18` | 8 | 0x32 0x63 0x40 | Miss. ara | Vulcan |
| `0x19` | 1 | 0x2D | Miss. | Pugman |
| `0x1A` | 1 | 0x63 | Shade PRLZ. Enemy shadows Miss. | HelgaruMage |
| `0x1B` | 2 | 0x3C 0x55 | — | Firefly |
| `0x1C` | 2 | 0x3C 0x41 | zzard Miss. | Manticore |
| `0x1D` | 1 | 0x28 | Thunder Miss. | GoldWarrior |
| `0x1E` | 3 | 0x2D 0x28 0x1E | zzara Miss. | Far Darrig |
| `0x1F` | 1 | 0x2D | zzara Miss. | Petit Mage |
| `0x20` | 6 | 0x14 0x0F | Blind BLIND Miss. | Dark Eye |
| `0x21` | 1 | 0x14 | Poison effect | Mummy |
| `0x22` | 2 | 0x1E 0x50 | Break effect Slowly petrified Miss. | Gold Bear |
| `0x23` | 2 | 0x63 | Back attack. died New Game Battle | XandeClone |
| `0x24` | 3 | 0x1E 0x28 | Drain Miss. Back attack. | Dira |
| `0x25` | 1 | 0x14 | Back attack. Haste effect Miss. | Hydra |
| `0x26` | 2 | 0x14 0x1E | Back attack. Protect Defense up. Miss. | ShadwMaster |
| `0x28` | 1 | 0x50 | Fira Miss. | Gutsco |
| `0x29` | 1 | 0x5A | zzara Miss. | Frostfly |
| `0x2A` | 1 | 0x50 | Back attack. Breakga STONE Shattered. Miss. | Kum Kum |
| `0x2B` | 4 | 0x20 0x15 0x1A | Breakga Miss. effect STONE Shattered. | RokGargoyle |
| `0x2C` | 1 | 0x63 | Flare Miss. | Titan |
| `0x2D` | 1 | 0x63 | Back attack. Quake died New Game | Guardian |
| `0x2F` | 1 | 0x63 | Back attack. Flare Miss. | Echidna |
| `0x30` | 1 | 0x63 | Back attack. Thunder died New Game | Ahriman |
| `0x3E` | 1 | 0x63 | Back attack. Flare Miss. | Scylla |

232 monsters, 45 distinct values.

## Confirmed behaviours

- `0x10` — **Divided.** the monster SPLITS (1→2, some 1→3), natural rate 0
- `0x0F` — **Called ally.** summons reinforcements, natural rate `0x28` (fires in normal play)
- `0x20` — **BLIND** · `0x22`/`0x2A`/`0x2B` — **STONE / petrified / Shattered.**
- `0x0B`/`0x1A` — **PRLZ.** · `0x09` — **CNF.** · `0x30` — **died**
- `0x15`/`0x16` — **Doga's / Unei's** named summons
- No monster self-heals: 0 of 232.

## `0x00` re-swept at 24 rounds — it really is the default

The 131 monsters on `0x00` were re-run with **4x the observation window** (24 rounds
instead of 6), because "shows nothing" and "we didn't watch long enough" look
identical. Result:

- **0 multiply, 0 self-heal** — no hidden splits, summons or regen
- only **4 of 131** showed nothing at all beyond baseline
- but almost every surfaced word is a **monster NAME fragment** (Dragon, Sea, Dark,
  Twin, Liger, King, Wisp, Were, Zomb, Bat, Blood, Worm, Demon...), not a behaviour

The one recurring non-name word is **`Back attack.` (17 monsters)** — and that is a
battle-START condition, not a special: it also appears across `0x02`, `0x06`, `0x0B`,
`0x11`, `0x12`, `0x23`, `0x24`, `0x25`, `0x26`, `0x2A`, `0x2D`, `0x2F`, `0x30`.

⭐ So `0x00` is the genuine **no-special default**, and the negative is trustworthy
because the same harness at the same settings found `Divided.`, `Called ally.`,
`Zantetsuken`, `Mega Flare` and `Breakga` in the other buckets.

### Names cross-referenced — `Poison` settled, and one correction

Every beyond-baseline word was checked against the monster's OWN decoded name:
**248 of 295 are name fragments; only 47 are not.**

⭐ `Poison` is a NAME, not a status — id `0x1B` **Poison Bat**, id `0x4C`
**Poison Toad**. Settled.

⛔ **CORRECTION to the paragraph above.** With names stripped, the `0x00` bucket is
NOT entirely behaviour-free: one monster shows **`BarrierShift` / `Weakness
changed.`** — an elemental-weakness shift. My "genuine no-special default" claim
was drawn from a word list still full of monster names, and the name
cross-reference is what exposed it. `0x00` is the default for ~130 of 131, with at
least one real exception.

⛔ The remaining non-name words are battle framing, not specials: `Back attack.`
(17, a battle-START condition), and `died` / `New Game` / `Battle` (end-of-battle
text).
