# FF1 monster special attacks — stat byte 7

Swept from the running game: every monster spawned alone, evade forced to
`0xFF` and current HP pinned every sample so it survives to act, then the battle
text read for up to 20 rounds on the 46 monsters that carry a special.
**128/128 fought.**

Byte 7 is the special id; `0xFF` means the monster has none.

⛔ Signature words are those seen in **≥40%** of the monsters sharing a value, so
per-monster noise drops out. Groups of one keep everything they showed; marked ⚠.
⛔ The baseline subtracted is a **measured** control fight (a `0xFF` monster), and
monster names come from the ROM's own name table — neither list is hand-written.

⛔ **Coverage limit.** The monster is unkillable during the sweep (evade `0xFF`,
HP pinned). A special gated on low HP, or on a party member dying, cannot fire
under these conditions — so an empty row means *nothing observed while healthy*,
not *no special exists*. The FF3 sweep has the same property.

## What byte 7 actually selects

Byte 7 is **not** an attack — it indexes a 16-byte pool entry at
`$9020 + byte7*16` (bank 12, file `$31030`), and the monster picks from a list:

```
  +0        chance for list A     +1        chance for list B
  +2..+9    list A: 8 entries      +11..+14  list B: 4 entries
  +10       $FF separator          +15       $FF separator

  pool $22 (LICH):  60 00 | 1F 1C 1D 16 15 14 0F 05 | FF x6
```

The gate, disassembled in the bank the CPU actually had mapped:

```
  B2A8  LDA ($9C),Y  Y=7      ; byte 7; $FF -> no special
  B2B3  JSR $AE09    X=$10    ; id * 16
  B2B7  ADC #$20 / ADC #$90   ; pointer = $9020 + id*16
  B2C2  LDA ($9E),Y  Y=0      ; byte 0 = the chance
  B2C4  JSR $B294             ; random(0..128); CMP chance
  B2C7  BCS $B2EF             ; random >= chance -> skip
  B2CB  LDA ($9A),Y / AND #$07 / ADC #$02   ; counter mod 8 -> list index
```

`$AE5D` scales the roll: `value = floor(rand * 129 / 256)`, fired when
`value < chance`. And `rand` is not computed — FF1's RNG is a **fixed 256-byte
table at `$FCF1`** indexed by a counter at `$688A` (`$FCE7: LDX $688A / INC
$688A / LDA $FCF1,X`). So the exact rate is countable from the ROM, and the
table is uniform enough that it reduces to **chance / 128**.

Measured by counting the branch outcome directly — a read of `+0` is one roll,
a read of `+2..+9` is a pass — over 14 independent battles per row:

| byte 0 | n rolls | fires | measured | exact from the ROM table |
|---|---|---|---|---|
| `$00` | 111 | 0 | 0.0% | 0.0% |
| `$10` | 108 | 15 | 13.9% | 12.9% |
| `$20` | 96 | 18 | 18.8% | 25.4% |
| `$40` | 87 | 44 | 50.6% | 50.4% |
| `$60` | 113 | 88 | 77.9% | 74.6% |
| `$7F` | 110 | 109 | 99.1% | 98.8% |

Five of six rows land within ~3 points of the value computed from the ROM table;
`$20` sits 1.5 sigma low on n=96. **The rate is `chance / 128`.**

⛔ **An earlier version of this table was wrong and is retracted.** It reported
0 / 38 / 71 / 89 / 100% off 4-9 rolls per row. Those were not independent
samples: the RNG table above is not seeded from frames or input, so every battle
replayed the SAME stream and repeated runs came out byte-identical. Independent
samples require seeding `$688A` per battle, which is what `ff1-rate-curve.mjs`
now does. Any harness that restarts from a savestate has this problem.
⛔ `$FF` in byte 0 yields 0%, matching the table's use of `$FF` as "empty"
rather than "always".
⭐ The `AND #$07` is why a pool cycles: LICH cast `1F 1C 1D` — the first three
entries of its own list, in order — rather than repeating one attack.

### Byte 1 — the second list

The entry holds **two parallel lists**, each with its own chance byte. Byte 1
gates a 4-entry list at `+11..+14`, reached only when list A's roll FAILS:

```
  B2EF  LDY #$01 / LDA ($9E),Y   ; byte 1 = chance for list B
  B2F3  JSR $B294                ; the SAME roll routine as list A
  B2F6  BCS $B319                ; fail -> no attack at all
  B2FA  LDA ($9A),Y  Y=8         ; a SEPARATE counter (list A uses Y=7)
  B2FC  AND #$03                 ; mod 4, not mod 8
  B301  ADC #$0B                 ; +11 = start of list B
  B304  LDA ($9E),Y / CMP #$FF   ; $FF entry -> reset counter, wrap
```

⭐ Because `$B2C7 BCS $B2EF` falls through from list A, a monster carrying both
lists uses list B at **`(1 - a/128) * (b/128)`**, not `b/128`.

Structural check across all 44 pool entries, **zero mismatches**: `byte 0 != 0`
iff `+2..+9` is populated, `byte 1 != 0` iff `+11..+14` is populated, and `+10`
and `+15` are always `$FF`.

Measured on WarMECH (pool `$20`, `byte 0 = 00` so list A can never fire, which
isolates list B), 14 independent battles per row:

| byte 1 | n rolls | fires | measured | chance/128 |
|---|---|---|---|---|
| `$00` | 126 | 0 | 0.0% | 0% |
| `$10` | 123 | 18 | 14.6% | 13% |
| `$20` | 117 | 42 | 35.9% | 25% |
| `$40` | 108 | 72 | 66.7% | 50% |
| `$7F` | 100 | 98 | 98.0% | 99% |

⛔ **OPEN: the mid-range runs high.** Endpoints are pinned (0 -> 0%, 127 -> 98%)
and it is monotonic, so byte 1 is certainly the chance — but `$20` and `$40`
measure ~1.35x their nominal rate, which is too systematic for noise at n>100.
The suspect is the RNG: it is a FIXED 256-byte table, and the special roll
happens at a fixed point in each turn's call sequence, so it samples the table
at a stride rather than uniformly — a strided subsample need not match the
table's overall distribution. **Not proven.** Testing it means logging the
`$688A` index at each roll and checking whether the visited indices are strided.
Until then `chance/128` is the mechanism, not a calibrated in-battle rate.

| byte 7 | monsters | behaviour (names + baseline stripped) | example |
|---|---|---|---|
| `0x00` | 1 ⚠ | FROST | FrWOLF |
| `0x01` | 1 ⚠ | Hits' HEAT | AGAMA |
| `0x02` | 3 | GLANCE Stopped | SAURIA |
| `0x03` | 1 ⚠ | GAZE Paralyzed Stun | OddEYE |
| `0x04` | 1 ⚠ | GAZE Paralyzed Stun Hits' FLASH Darkness Dark | BigEYE |
| `0x05` | 1 ⚠ | SCORCH | CEREBUS |
| `0x06` | 1 ⚠ | RUSE Easy dodge DARK Darkness Dark | WzOGRE |
| `0x07` | 1 ⚠ | CRACK Ineffective Slain | Sand W |
| `0x08` | 1 ⚠ | XXXX Ineffective BRAK Stopped RUB LIT HOLD Attack | EYE |
| `0x09` | 1 ⚠ | STOP Ineffective Time stopped Paralyzed Stun | PHANTOM |
| `0x0A` | 1 ⚠ | FIR SLOW Lost intelligence DARK Darkness Dark | MANCAT |
| `0x0B` | 1 ⚠ | Paralyzed Stun Cured' DAZZLE | VAMPIRE |
| `0x0C` | 1 ⚠ | AFIR MUTE Silenced Mute | WzVAMP |
| `0x0D` | 1 ⚠ | FIR HOLD Attack halted Paralyzed Stun Hits' Cured' | R.GOYLE |
| `0x0E` | 1 ⚠ | BLIZZARD | Frost D |
| `0x0F` | 1 ⚠ | BLAZE | Red D |
| `0x10` | 1 ⚠ | SQUINT Slain | PERILISK |
| `0x11` | 1 ⚠ | CREMATE Hits' | R.HYDRA |
| `0x12` | 1 ⚠ | LIT HOLD Attack halted Paralyzed Stun SLOW Lost | NAGA |
| `0x13` | 1 ⚠ | RUSE Easy dodge MUTE Silenced Mute | GrNAGA |
| `0x14` | 1 ⚠ | CREMATE Hits' | CHIMERA |
| `0x15` | 1 ⚠ | CREMATE Hits' POISON Stopped | JIMERA |
| `0x16` | 1 ⚠ | TRANCE Ineffective Paralyzed Stun | SORCERER |
| `0x17` | 1 ⚠ | POISON | Gas D |
| `0x18` | 1 ⚠ | THUNDER | Blue D |
| `0x19` | 1 ⚠ | FAST Quick shot Poisoned Hits' | MudGOL |
| `0x1A` | 1 ⚠ | SLOW Lost intelligence | RockGOL |
| `0x1B` | 1 ⚠ | TOXIC Ineffective Slain | IronGOL |
| `0x1C` | 1 ⚠ | XFER Defenseless NUKE | EVILMAN |
| `0x1D` | 1 ⚠ | RUB Ineffective LIT FIR BANE Poison smoke Slain | MAGE |
| `0x1E` | 1 ⚠ | WALL Defend all XFER Defenseless HEL FOG INV | FIGHTER |
| `0x1F` | 1 ⚠ | Hits' SNORTING Darkness Dark Ineffective | NITEMARE |
| `0x20` | 1 ⚠ | Hits' NUCLEAR | WarMECH |
| `0x21` | 1 ⚠ | STINGER Ineffective Poisoned | MANTICOR |
| `0x22` | 1 ⚠ | ICE SLP Asleep Woke FAST Quick shot Paralyzed | LICH |
| `0x23` | 1 ⚠ | NUKE STOP Time stopped Paralyzed Stun | LICH |
| `0x24` | 1 ⚠ | FIR DARK Darkness Dark | KARY |
| `0x25` | 1 ⚠ | FIR RUB Erased Slain Hits' | KARY |
| `0x26` | 1 ⚠ | Hits' INK Ineffective Darkness Dark | KRAKEN |
| `0x27` | 1 ⚠ | LIT INK Ineffective Darkness Dark | KRAKEN |
| `0x28` | 1 ⚠ | THUNDER Hits' POISON BLIZZARD BLAZE | TIAMAT |
| `0x29` | 1 ⚠ | BANE Ineffective Poison smoke Slain | TIAMAT |
| `0x2A` | 1 ⚠ | ICE LIT CRACK Ineffective Slain | CHAOS |
| `0x2B` | 1 ⚠ | RUB Ineffective SLO Lost intelligence FAST Quick shot | ASTOS |
| `none` | 82 | — | IMP |

128 monsters, 44 distinct special ids (82 monsters have none).

## Per-monster

| id | monster | byte 7 | status | rounds | behaviour |
|---|---|---|---|---|---|
| `00` | IMP | — | `00` | 4 | — |
| `01` | GrIMP | — | `00` | 4 | — |
| `02` | WOLF | — | `00` | 4 | — |
| `03` | GrWOLF | — | `00` | 4 | — |
| `04` | WrWOLF | — | `04` | 4 | Poisoned |
| `05` | FrWOLF | `0x00` | `00` | 20 | FROST |
| `06` | IGUANA | — | `00` | 4 | — |
| `07` | AGAMA | `0x01` | `00` | 20 | Hits' HEAT |
| `08` | SAURIA | `0x02` | `00` | 5 | GLANCE Stopped |
| `09` | GIANT | — | `00` | 4 | — |
| `0A` | FrGIANT | — | `00` | 4 | — |
| `0B` | R.GIANT | — | `00` | 4 | — |
| `0C` | SAHAG | — | `00` | 4 | — |
| `0D` | R.SAHAG | — | `00` | 4 | — |
| `0E` | WzSAHAG | — | `00` | 4 | — |
| `0F` | PIRATE | — | `00` | 4 | — |
| `10` | KYZOKU | — | `00` | 4 | — |
| `11` | SHARK | — | `00` | 4 | — |
| `12` | GrSHARK | — | `00` | 4 | — |
| `13` | OddEYE | `0x03` | `00` | 5 | GAZE Paralyzed Stun |
| `14` | BigEYE | `0x04` | `00` | 7 | GAZE Paralyzed Stun Hits' FLASH Darkness Dark |
| `15` | BONE | — | `00` | 4 | — |
| `16` | R.BONE | — | `00` | 4 | — |
| `17` | CREEP | — | `00` | 4 | — |
| `18` | CRAWL | — | `10` | 4 | Paralyzed Hits' Stun |
| `19` | HYENA | — | `00` | 4 | — |
| `1A` | CEREBUS | `0x05` | `00` | 20 | SCORCH |
| `1B` | OGRE | — | `00` | 4 | — |
| `1C` | GrOGRE | — | `00` | 4 | — |
| `1D` | WzOGRE | `0x06` | `00` | 12 | RUSE Easy dodge DARK Darkness Dark |
| `1E` | ASP | — | `04` | 4 | Poisoned |
| `1F` | COBRA | — | `00` | 4 | — |
| `20` | SeaSNAKE | — | `00` | 4 | — |
| `21` | SCORPION | — | `04` | 4 | Poisoned Hits' |
| `22` | LOBSTER | — | `04` | 4 | Poisoned Hits' |
| `23` | BULL | — | `00` | 4 | Hits' |
| `24` | ZomBULL | — | `00` | 4 | — |
| `25` | TROLL | — | `00` | 4 | Hits' |
| `26` | SeaTROLL | — | `00` | 4 | — |
| `27` | SHADOW | — | `08` | 4 | Darkness Dark |
| `28` | IMAGE | — | `10` | 4 | Paralyzed Stun |
| `29` | WRAITH | — | `10` | 4 | Paralyzed Stun |
| `2A` | GHOST | — | `10` | 4 | Paralyzed Stun |
| `2B` | ZOMBIE | — | `00` | 4 | — |
| `2C` | GHOUL | — | `10` | 4 | Paralyzed Hits' Stun |
| `2D` | GEIST | — | `10` | 4 | Paralyzed Hits' Stun |
| `2E` | SPECTER | — | `10` | 4 | Paralyzed Stun |
| `2F` | WORM | — | `00` | 4 | — |
| `30` | Sand W | `0x07` | `00` | 4 | CRACK Ineffective Slain |
| `31` | Grey W | — | `00` | 4 | — |
| `32` | EYE | `0x08` | `00` | 11 | XXXX Ineffective BRAK Stopped RUB LIT HOLD Attack |
| `33` | PHANTOM | `0x09` | `10` | 4 | STOP Ineffective Time stopped Paralyzed Stun |
| `34` | MEDUSA | `0x02` | `04` | 5 | GLANCE Stopped |
| `35` | GrMEDUSA | `0x02` | `10` | 5 | GLANCE Stopped |
| `36` | CATMAN | — | `04` | 4 | Poisoned Hits' |
| `37` | MANCAT | `0x0A` | `00` | 10 | FIR SLOW Lost intelligence DARK Darkness Dark |
| `38` | PEDE | — | `04` | 4 | Poisoned |
| `39` | GrPEDE | — | `00` | 4 | — |
| `3A` | TIGER | — | `00` | 4 | Hits' |
| `3B` | Saber T | — | `00` | 4 | Hits' |
| `3C` | VAMPIRE | `0x0B` | `10` | 8 | Paralyzed Stun Cured' DAZZLE |
| `3D` | WzVAMP | `0x0C` | `10` | 6 | AFIR MUTE Silenced Mute |
| `3E` | GARGOYLE | — | `00` | 4 | Hits' |
| `3F` | R.GOYLE | `0x0D` | `00` | 20 | FIR HOLD Attack halted Paralyzed Stun Hits' Cured' |
| `40` | EARTH | — | `00` | 4 | — |
| `41` | FIRE | — | `00` | 4 | — |
| `42` | Frost D | `0x0E` | `00` | 20 | BLIZZARD |
| `43` | Red D | `0x0F` | `00` | 20 | BLAZE |
| `44` | ZombieD | — | `10` | 4 | Paralyzed Stun |
| `45` | SCUM | — | `04` | 4 | Poisoned |
| `46` | MUCK | — | `00` | 4 | — |
| `47` | OOZE | — | `00` | 4 | — |
| `48` | SLIME | — | `04` | 4 | Poisoned |
| `49` | SPIDER | — | `00` | 4 | — |
| `4A` | ARACHNID | — | `04` | 4 | Poisoned |
| `4B` | MANTICOR | `0x21` | `00` | 4 | STINGER Ineffective Poisoned |
| `4C` | SPHINX | — | `00` | 4 | Hits' |
| `4D` | R.ANKYLO | — | `00` | 4 | Hits' |
| `4E` | ANKYLO | — | `00` | 4 | — |
| `4F` | MUMMY | — | `20` | 4 | Asleep Woke |
| `50` | WzMUMMY | — | `20` | 4 | Asleep Woke |
| `51` | COCTRICE | — | `02` | 4 | Stopped |
| `52` | PERILISK | `0x10` | `00` | 9 | SQUINT Slain |
| `53` | WYVERN | — | `04` | 4 | Poisoned |
| `54` | WYRM | — | `00` | 4 | — |
| `55` | TYRO | — | `00` | 4 | — |
| `56` | T REX | — | `00` | 4 | — |
| `57` | CARIBE | — | `00` | 4 | — |
| `58` | R.CARIBE | — | `00` | 4 | — |
| `59` | GATOR | — | `00` | 4 | Hits' |
| `5A` | FrGATOR | — | `00` | 4 | Hits' |
| `5B` | OCHO | — | `04` | 4 | Poisoned Hits' |
| `5C` | NAOCHO | — | `04` | 4 | Poisoned Hits' |
| `5D` | HYDRA | — | `00` | 4 | Hits' |
| `5E` | R.HYDRA | `0x11` | `00` | 20 | CREMATE Hits' |
| `5F` | GUARD | — | `10` | 4 | Paralyzed Hits' Stun |
| `60` | SENTRY | — | `00` | 4 | — |
| `61` | WATER | — | `00` | 4 | — |
| `62` | AIR | — | `00` | 4 | — |
| `63` | NAGA | `0x12` | `04` | 12 | LIT HOLD Attack halted Paralyzed Stun SLOW Lost |
| `64` | GrNAGA | `0x13` | `04` | 6 | RUSE Easy dodge MUTE Silenced Mute |
| `65` | CHIMERA | `0x14` | `00` | 20 | CREMATE Hits' |
| `66` | JIMERA | `0x15` | `00` | 9 | CREMATE Hits' POISON Stopped |
| `67` | WIZARD | — | `00` | 4 | Hits' |
| `68` | SORCERER | `0x16` | `01` | 4 | TRANCE Ineffective Paralyzed Stun |
| `69` | GARLAND | — | `00` | 4 | — |
| `6A` | Gas D | `0x17` | `00` | 20 | POISON |
| `6B` | Blue D | `0x18` | `00` | 20 | THUNDER |
| `6C` | MudGOL | `0x19` | `04` | 12 | FAST Quick shot Poisoned Hits' |
| `6D` | RockGOL | `0x1A` | `00` | 20 | SLOW Lost intelligence |
| `6E` | IronGOL | `0x1B` | `00` | 8 | TOXIC Ineffective Slain |
| `6F` | BADMAN | — | `00` | 4 | Hits' |
| `70` | EVILMAN | `0x1C` | `00` | 20 | XFER Defenseless NUKE |
| `71` | ASTOS | `0x2B` | `00` | 20 | RUB Ineffective SLO Lost intelligence FAST Quick shot |
| `72` | MAGE | `0x1D` | `00` | 20 | RUB Ineffective LIT FIR BANE Poison smoke Slain |
| `73` | FIGHTER | `0x1E` | `00` | 20 | WALL Defend all XFER Defenseless HEL FOG INV |
| `74` | MADPONY | — | `00` | 4 | Hits' |
| `75` | NITEMARE | `0x1F` | `00` | 20 | Hits' SNORTING Darkness Dark Ineffective |
| `76` | WarMECH | `0x20` | `00` | 20 | Hits' NUCLEAR |
| `77` | LICH | `0x22` | `10` | 19 | ICE SLP Asleep Woke FAST Quick shot Paralyzed |
| `78` | LICH | `0x23` | `10` | 7 | NUKE STOP Time stopped Paralyzed Stun |
| `79` | KARY | `0x24` | `00` | 7 | FIR DARK Darkness Dark |
| `7A` | KARY | `0x25` | `00` | 20 | FIR RUB Erased Slain Hits' |
| `7B` | KRAKEN | `0x26` | `00` | 20 | Hits' INK Ineffective Darkness Dark |
| `7C` | KRAKEN | `0x27` | `00` | 10 | LIT INK Ineffective Darkness Dark |
| `7D` | TIAMAT | `0x28` | `00` | 20 | THUNDER Hits' POISON BLIZZARD BLAZE |
| `7E` | TIAMAT | `0x29` | `00` | 4 | BANE Ineffective Poison smoke Slain |
| `7F` | CHAOS | `0x2A` | `10` | 10 | ICE LIT CRACK Ineffective Slain |
