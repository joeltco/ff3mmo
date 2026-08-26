# Quest + dialogue rebuild — plan

Status: **PROPOSED, nothing built.** Written 2026-08-25 against v1.10.88.

Replaces the quest system wholesale. The current one is not broken in the sense
of failing its gates — `check-quests`, `check-words`, `check-word-flow`,
`check-dialogue-fit` and `check-npc-dialogue` all pass — it is too small and too
rigid to express the two quests this game actually needs, and one of its three
quests is dead on arrival because of that rigidity (§2.1).

The target is the beginner valley: Ur, Kazus, Castle Sasune, Altar Cave, and the
Cave of Seals behind a canoe.

---

## 1. The ask

Two named quests, from Joel:

1. **A King's quest that grants the CANOE**, which unlocks the Cave of Seals.
   A *process* rescue quest — find Princess Sara. Finding her completes it.
2. **Cid's quest to lift the curse** by beating the Djinn, turning him back into
   himself.

Everything else — supporting cast, words, the valley's voice — is to be built
around those two. The explicit quality bar is **no mediocre dialogue**.

---

## 2. What is wrong today, measured

### 2.1 ⛔ `kazus_cid_airship` is unstartable on every save

The quest names `giver: { mapId: 12, npcKey: 'cid' }`. The placement rows are:

```js
{ key: 'cid_ghost', x: 6, y: 23, spec: CID_GHOST, when: (q) => !q('kazus_cid_airship') },
{ key: 'cid',       x: 6, y: 23, spec: CID,       when: (q) =>  q('kazus_cid_airship') },
```

**Cid is only placed once the quest he gives is already done.** Simulated both
states through the real `when` predicates:

```
FRESH SAVE       -> map 12: kazus_inn_keep, kazus_item_keeper, kazus_inn_guest_b, cid_ghost
AFTER quest done -> map 12: kazus_inn_keep, kazus_item_keeper, kazus_inn_guest_b, cid
```

`askQuestWord(12, 'cid_ghost', 'airship')` matches no quest, so asking the ghost
about AIRSHIP returns his flavour lines and no offer, forever. One of three
quests, dead. The other two givers are placed correctly on a fresh save.

⛔ **`check-quests` passes it** because it drives the quest API with
`quest.giver` values directly and never asks whether the giver is standing
there. That assertion does not exist. It is §8's first gate.

### 2.2 The fix for 2.1 requires a capability the system does not have

Point the giver at `cid_ghost` and the other end breaks: the `done` pages are
*"The curse let go of me. / Fly her well."*, written for post-curse Cid, who is a
different `npcKey`. **The quest must be offered by one NPC and remembered by
another, and a quest may only have one giver.** The live bug is the structural
limit wearing a costume.

### 2.3 The rest of the limits

| # | limit | evidence |
|---|---|---|
| a | **Prose and mechanics share one record.** ~45 of a quest's ~70 lines are English, in the table `economy-arbiter.js` and `api.js` import to validate claims. | `data/quests.js` |
| b | **One objective kind.** `noteEncounterVictory` returns early on anything but `'defeat'`. Every quest is "win N encounters in zone X". | `quests.js` |
| c | **One giver per quest**, matched on `(mapId, npcKey)` in three copied places. | `talkQuest`, `askQuestWord`, `_takeQuestNotice` |
| d | **No world state.** Only `ps.quests[id] = {s,n}`. NPC variation is `when:` on the *placement* row, which swaps one whole NPC for another — hence Cid being two NPCs on one tile. | `npc.js#_questDone` |
| e | **Dialogue cannot vary by state.** `dialogue` and `answers` are frozen arrays. | `data/town-npcs.js` |
| f | **The state machine is implicit** — sort ranks plus inline mutation plus persist plus a reward callback in one function. | `talkQuest` |
| g | **Rewards take three paths.** Gil/item go through the server ledger; `_grantVehicle` is client-only with no claim; `_questNotice` is a hand-rolled one-slot queue in `npc.js`. | `quests.js`, `npc.js` |

### 2.4 What is NOT wrong, and must survive

The server half is good and the rebuild must not disturb it:

- reward comes from the **server's** copy of the quest table, never the payload
- one payout per `(user, slot, quest)` via the `quest_claims` table
- saved counts clamped to the real objective; unknown ids dropped

⭐ **The vehicle system is fully wired.** `movement.js` boards by position,
disembarks by position, and calls `isPassableForMode(tileX, tileY, ps.vehicle)`
on the world map. `check-world-passability` only pins the two-arg `isPassable`,
which world movement does not use. **A granted vehicle works today** — the canoe
needs no new machinery, only `grantsVehicle: { mode: 1, … }`.

---

## 3. Why the canoe, and why it comes first

⭐ **Measured**, flooding the world map with the ROM's own mask table at `$C6CD`
from Ur's entrance tile:

| mode | tiles | entrances reached | Sealed Cave? |
|---|---|---|---|
| 0 on foot | 267 | Ur, Kazus, Castle Sasune, Altar Cave | ❌ |
| **1 canoe** | **296** | **+ Sealed Cave** | ✅ |
| 4/7 airship, Invincible | 304 | loses Altar Cave too | ❌ |

Both cave mouths carry tile `byte1 = 0x9e`; bit 4 is the flight barrier, so **no
flying craft can land on either one**. The three towns are `0x8e` and can be
landed on. That is the cartridge's own rule.

The canoe opens exactly a 29-tile pocket, only 8 of it water:

```
Ur (95,41) --walk--> (87,41) --canoe--> (87,40..37) --> (86,37) (85,37) (84,37) --> mouth (84,36)
```

⚠ **This reorders canon, correctly.** In FF3 the canoe is the King's *reward*
after the Djinn is sealed (script `0x240`), and Cid's **airship** crosses the
lake to the cave (`0x225`). On ff3mmo's terrain the airship provably cannot, and
the canoe provably can. Joel's ordering — canoe first, as the key — is the one
that matches the ground we actually have.

⛔ **Consequence for Sara:** she cannot be found inside the Sealed Cave, because
the cave is behind the canoe that finding her grants. See §7.3.

---

## 4. What the ROM gives us

All decoded already; nothing here is invented.

### 4.1 The script

`docs/FF3-SCRIPT.md` carries the whole chain. The load-bearing lines:

| id | line |
|---|---|
| `0x23f` | King: the Djinn cursed everyone; reseal it to lift the curse; a Mythril Ring is needed; Sara has one; **where is she?** |
| `0x22d` | "The Djinn that we had banished into the Sealed Cave was released by the earthquake." |
| `0x231` | "The Mythril Ring can seal the Djinn. It's only made in this town. That's why the Djinn attacked us." |
| `0x22f` | "A while ago, there was a Mythril Ring made for Princess Sara of Castle Sasune. If only we had it!" |
| `0x238` | A castle servant: "I only escaped the curse because I was out running errands." |
| `0x245` | Sara: "My Mythril Ring saved me from the Djinn's curse. I came to seal the Djinn and save my people, but the monsters are getting in the way!" |
| `0x223` | "Sorry, I thought you were a ghost! … This town is cursed. There's ghosts haunting the inn." |
| `0x23d` / `0x22b` | the ghosts: "The Djinn's curse has left me in this wretched state." |
| `0x239` | "the Djinn's curse has been lifted. Please speak to the king … a magical folding canoe." |
| `0x240` | "King Sasune gave you a Canoe." |
| `0x243` | "Her room is at the top of the east tower." |
| `0x23b` | "The Sealed Cave is guarded by undead monsters. They may be defeated by casting Cure!" |

That is a complete, sourced spine for both quests. **The words are ours to
write; the beats are the cartridge's.**

### 4.2 ⭐ The throne room is empty, and the ROM has already paired the curse

`node tools/npc-dump.mjs 29` — **the ROM lists 11 NPCs on map 29 and ff3mmo
places ZERO.** There is no King in this game. Worse and better: the records come
in **same-tile pairs**, one cursed and one not.

| tile | cursed id | living id | living bundle |
|---|---|---|---|
| (10,6) — the throne | `$37` | `$38` | **0x1EF10** (unique to this record) |
| (9,7) | `$31` | `$32` | 0x1EE10 |
| (11,7) | `$33` | `$34` | 0x1EE10 |

Every cursed id resolves through the id→gfx table at `0x1410` to **gfx 45 =
bundle 0x1ED10**, the ghost. **The two-state pattern we need is the cartridge's
own data**, sitting unused. The King is `$38` on the throne tile wearing a
bundle no other record in the room wears.

⛔ Identified by **placement and sprite**, not by `npcId + 0x202`.

### 4.3 Sara

`gfxForNpcId(rom, 67)` → gfx 25 → bundle **`0x1D910`**. The ROM places her only
on maps 33/34 (a late-game pair, `npcIdx 23`), never in Sasune and never in the
Sealed Cave — in canon she is placed by event script, not by the static table.
**Map 174, Sasune's East Tower, lists ZERO NPCs**, so her room is ours to fill.

⛔ **`0x1D910` is ff3mmo's Cid.** The ROM says gfx 25 is worn by ids 31, 67
(Sara), 192 (Desch) and 217 — a shared townsfolk sprite, which `NPC-CATALOG.md`
already flagged. But Joel supplied that art for Cid and it shape-matches at
90.2%, and it is reserved to him in `STORY_SPRITE_BUNDLES`. **Sara in her
authentic sprite would be visually identical to our Cid.** Decision in §7.1.

---

## 5. The system

Five changes. Each one is forced by something in §2, and nothing here is added
speculatively.

### 5.1 Split the prose out of the server's table

```
src/data/quests.js      MECHANICS ONLY — import-free, imported by the server
src/data/script.js      ALL prose, keyed by string id — client only
```

The server stops importing a single line of English, and the voice can be
rewritten without touching the table that validates claims. Fixes **2.3a**.

### 5.2 A quest is a list of STAGES

```js
sasune_missing_daughter: {
  id: 'sasune_missing_daughter',
  stages: [
    { id: 'asked',   at: { map: 29,  npc: 'sasune_king' },  startWord: 'sara' },
    { id: 'errand',  at: { map: 25,  npc: 'sasune_runner' }, objective: { kind: 'talk' } },
    { id: 'forge',   at: { map: 10,  npc: 'takka' },         objective: { kind: 'talk' } },
    { id: 'found',   at: { map: 174, npc: 'sara' },          objective: { kind: 'talk' },
                     sets: ['sara_found'] },
    { id: 'return',  at: { map: 29,  npc: 'sasune_king' },   handIn: true },
  ],
  reward: { gil: 500, exp: 200, vehicle: { mode: 1, x: 87, y: 41 } },
}
```

One structure buys **2.2** (offered by one NPC, handed in by another), **2.3c**
(many NPCs per quest, one place that resolves them), and **2.3f** (the machine is
declared, not inferred from sort ranks). `ps.quests[id]` becomes `{ s, n }` where
`s` is the **stage id** — same two fields, same wire, same server clamp.

### 5.3 Objective kinds as a registry

⛔ A registry keyed by `kind`, never a ternary — adding a kind must not touch the
engine.

| kind | shape | needed by |
|---|---|---|
| `defeat` | `{ zonePrefix, count }` | existing quests |
| `talk` | `{ }` — satisfied by talking to the stage's own `at` NPC | Sara, the runner, Takka |
| `boss` | `{ bossId }` | **Djinn `0xCD`** |
| `flag` | `{ flag }` | chaining |

Fixes **2.3b**. `boss` and `talk` are the two the named quests actually require;
`flag` falls out of §5.4 for free. Nothing else is added until something needs it.

### 5.4 Story flags

```js
ps.flags = { sara_found: 1, canoe_granted: 1, djinn_sealed: 1, curse_lifted: 1 }
```

A small string-keyed set with a **fixed whitelist**, validated server-side
exactly like `ps.quests`.

⛔ **Save whitelist lockstep** — a `ps.*` field added to the client serializer
but not the server validator vanishes on next login. `save-state.js` **and**
`api.js`, same change, same commit.

NPC `when:` predicates read **flags**, not quest ids. That is what lets the
37-NPC curse inversion key off `curse_lifted` instead of off "is quest K done".
Fixes **2.3d**.

### 5.5 State-dependent dialogue

```js
dialogue: [
  { when: 'curse_lifted', pages: ['The Djinn is sealed.', 'I am myself again.'] },
  { pages: ['The curse caught me here.'] },              // default, last
],
answers: {
  djinn: [
    { when: 'curse_lifted', pages: [...] },
    { pages: [...] },
  ],
},
```

First matching entry wins; the unguarded one is the default and must be last.
Fixes **2.3e**, and kills the duplicate-placement-row pattern: **the 37 inverted
NPCs become 37 rows with two states, not 74 rows.**

### 5.6 One reward path

Every payout — gil, item, **vehicle**, flags — goes through
`validateQuestClaim`, which already pays from the server's own table and ledgers
one claim per `(user, slot, quest)`. `_grantVehicle`'s client-only path goes
away. `_questNotice` becomes a small named module instead of a one-slot global in
`npc.js`. Fixes **2.3g**.

---

## 6. The content

### 6.1 Quest 1 — *The King's Daughter* (Sasune → canoe)

The King is **new content**: the throne room is empty today (§4.2).

| stage | where | who | beat |
|---|---|---|---|
| asked | Sasune throne, map 29 | **King `$38`**, bundle 0x1EF10, throne (10,6) | The Djinn cursed the castle. It must be resealed. Only Sara's Mythril Ring can. She is gone. |
| errand | hall, map 25 | **the runner** — the one servant the curse missed, "out running errands" (`0x238`) | He saw her ride out. She asked the way to Kazus. |
| forge | Kazus, map 10 | a Kazus smith — id chosen from the map's own dump (§6.3) | The ring was made here. She came back asking what could cross the water north. |
| found | East Tower, map 174 | **Sara** | She got as far as the water and could not cross. |
| return | Sasune throne, map 29 | King | **The canoe.** He gives it because water is what stopped his daughter. |

⭐ The reward is *causal*, not a gift: the King hands over the thing that would
have saved her the walk home. Grounded in `0x23f`, `0x238`, `0x231`, `0x22f`,
`0x245`, `0x240`.

⛔ **Takka is NOT available in Kazus.** `NPC-CATALOG.md` names id 52 as Takka
from a self-identifying line, and a full 256-map sweep places id 52 exactly once
— **map 29 (11,7), the throne room**, as the living half of ghost `$33`. The
four `$35` records in halls 25/26/27 that an earlier note called "Takka" wear the
GHOST bundle 0x1ED10 and are a different id. Putting Takka in his own forge would
mean **moving** him, which is ff3mmo's call to make, not a ROM fact to cite. The
Kazus smith for this stage is picked from map 10's own dump instead.

New words: **SARA**, **RING**, **DJINN**. Each taught by someone who says it in
a line they would say anyway — the existing rule from `keywords.js`.

### 6.2 Quest 2 — *The Sealed Cave* (Cid → curse lifted)

| stage | where | who | beat |
|---|---|---|---|
| asked | Kazus pub, map 12 (6,23) | **Cid, cursed** | He is a ghost like the rest of the town. He knows what did it. |
| sealed | Cave of Seals, map 2003 | — | `objective: { kind: 'boss', bossId: 0xCD }` — the Djinn. |
| return | Kazus pub, map 12 (6,23) | **Cid, himself** | `sets: ['djinn_sealed', 'curse_lifted']` |

⭐ **This is what fixes §2.1** — one quest, two Cids, no circular gate, because
stages bind to NPCs individually.

⭐ **And it is what resolves the cursed-town inversion.** Today ff3mmo shows the
post-curse cast on a fresh save and hides the ghosts the cartridge draws
(`design-notes` followup 1 — 16 wrongly shown, 21 wrongly hidden). Fixing that
alone would close Kazus's inn and its weapon and armor shops with no way to
reopen them. **Gated on `curse_lifted`, the inversion stops being a bug fix and
becomes this quest's payoff.**

### 6.3 ⭐ There is plenty of unplaced cast to build from

Measured across the 31 valley maps — **the ROM lists 117 NPC records and ff3mmo
places 45. Seventy-two are unplaced.**

| map | ROM | placed | map | ROM | placed |
|---|---|---|---|---|---|
| 29 Sasune throne | 11 | **0** | 12 Kazus pub/inn | 10 | 5 |
| 10 Kazus town | 9 | 3 | 8 Ur inn | 8 | 3 |
| 26 / 27 Sasune halls | 6 / 6 | **0 / 0** | 25 Sasune hall | 6 | 2 |
| 6 Ur elder | 6 | 1 | 2 Ur secret | 5 | 1 |

⚠ Not all 72 should be placed at once — some are the cursed/living pairs of
§4.2, and some records are objects rather than people. But the supporting cast
for both quests already exists as ROM records on the right tiles.

⛔ **Read the map's own dump before placing anybody.** `npc-dump.mjs 12` printed
Cid's tile the whole time and it still took three releases and Joel pointing at
it.

### 6.4 The voice

The register already exists in Ur and it is good — terse, declarative, no
throat-clearing:

> *"He was mine. / You know already."*

Rules the rebuild keeps:

1. **The box wraps at 16 chars and fits 3 lines** — ~48 characters a page. The
   constraint is the voice; do not fight it. `check-dialogue-fit` wraps the
   widest token expansion, and all 408 current pages pass.
2. **No exposition an NPC would not say out loud.** Nobody explains the plot to
   a stranger.
3. **Every keyword is a word someone actually said**, so LEARN is honest.
4. **Nothing invented where the ROM has a line** — `docs/FF3-SCRIPT.md` first,
   ours second, and say which.

Sample, to fix the register (King, stage `asked`):

```
'The Djinn woke.'
'It made ghosts of us.'
'My daughter took her ring'
'and did not come back.'
```

Sample (Sara, stage `found`):

```
'I got as far as the water.'
'The ring keeps the curse off.'
'It does not make me swim.'
```

Sample (Cid, after `curse_lifted`):

```
'The curse let go.'
'Kazus will be loud again'
'by morning.'
```

---

## 7. Open decisions — Joel's call

### 7.1 ⛔ Sara's sprite collides with Cid's

Her authentic bundle `0x1D910` is the one ff3mmo reserves to Cid (§4.3).

- **(a) Authentic** — dress her in `0x1D910`. She looks exactly like Cid.
- **(b) ff3mmo's own choice** — pick another **real** ROM bundle that reads as a
  young woman and is distinct from Cid. Legitimate under our own rule that
  ff3mmo's design choices need no ROM provenance; the sprite must still be a real
  rip, never drawn.

**Recommend (b)**, decided off a render sheet rather than a description —
`npc-sheet-ff3.mjs` over the candidate bundles, and look. ⛔ Never hand-author
the art.

### 7.2 Per-player or shared world?

Flags in `ps.flags` make the curse **per-player**. **Recommend per-player**: a
shared world means whoever kills the Djinn first ends the early game for every
player who arrives after. The alternative is a server fact synced to everyone in
the room, which is a much larger change and touches the wire.

### 7.3 Where is Sara found?

She cannot be in the Sealed Cave (§3). Two candidates:

- **(a) The East Tower, map 174** — canon says her room is at the top of the east
  tower (`0x243`), the map exists, is already in `AREAS`, and lists zero ROM
  NPCs. Needs no new subsystem. Weakness: "she was home the whole time" is a
  weak rescue unless the leads earn it.
- **(b) The lake shore, world (87,41)** — the exact tile the canoe launches from.
  Dramatically much better and makes the reward causal. ⛔ **Requires overworld
  NPCs, which do not exist**: `placeTownNpcs` is called only from
  `_loadRegularMap`, never on the world map.

**Recommend (a) for this arc**, with the leads doing the work — and (b) noted as
a real capability we will want later. The plan should not smuggle in a new NPC
subsystem under a quest.

---

## 8. Gates

New, and each one must **fail on revert**:

1. ⭐ **Every stage's NPC is placed when that stage is live.** Walk each quest
   stage by stage, building the map's NPC list through the real `when`
   predicates with the flags that stage implies. This is the gate that was
   missing; it catches §2.1 exactly.
2. **Every quest is completable end to end** through placement, not through the
   API — offer, each objective, hand-in, reward, once.
3. **No orphan flags** — every flag read by a predicate is set by some stage, and
   every flag set is read by something.
4. **Word reachability by stage** — a term's teacher must be reachable before its
   answerer is needed.
5. **Prose/mechanics separation holds** — `data/quests.js` contains no prose, and
   the server imports nothing from `data/script.js`.

Kept as-is: `check-dialogue-fit`, `check-words`, `check-word-flow`,
`check-npc-dialogue`, `check-npc-placement`, `check-roster-locs`.

---

## 9. Order of work

1. Flags + save lockstep (`save-state.js` **and** `api.js`), gate 3.
2. Stages + objective registry; port the two existing Ur quests unchanged as the
   proof the port is behaviour-preserving.
3. Gate 1 and 2. **They must fail against today's `kazus_cid_airship`** — that is
   the revert proof.
4. Split prose out; gate 5.
5. State-dependent dialogue; gate 4.
6. Content: the King and the throne room, the runner, Takka, Sara.
7. Quest 1 → canoe. Verify the Sealed Cave is reachable in play.
8. Quest 2 → Djinn → `curse_lifted`.
9. The 37-NPC inversion, gated on `curse_lifted`.
10. One reward path (§5.6), vehicle through the ledger.

Steps 1-5 are the system and change no visible content. Steps 6-10 are the
valley.

---

## 10. What this does NOT do

- ⛔ **No quest UI, no journal, no overhead marker.** Removed in v1.7.990/991 on
  purpose; the giver's own lines are the signposting. Adding one would undo the
  design.
- ⛔ **No party-member Sara.** She joins the party in canon (`0x246`); ff3mmo has
  no special-character system and this plan does not invent one
  (`design-notes` followup 2).
- ⛔ **No Mythril Ring item, no skeleton key, no secret path.** They are in the
  script (`0x23f`) and they are not in this arc.
- ⛔ **No new overworld NPC subsystem** — see §7.3.
- ⛔ **The server's claim ledger is not touched** beyond adding `vehicle` to the
  validated reward shape.
