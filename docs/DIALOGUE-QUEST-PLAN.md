# NPC Dialogue & Quests — refactor plan

Status: **PROPOSED, not started.** Written 2026-08-27 against live `v1.11.14`.
Nothing in here has been built. Read §7 first if you only read one section —
that is the list of calls that are yours, not mine.

Every number below is **measured**, not estimated. The instruments are in
`tools/audit-*.mjs` (written during the 2026-08-27 audit) and each one drives
the real modules, never a re-implementation:

| tool | what it answers |
|---|---|
| `audit-npc-talk.mjs` | the transcript — what every placed person says at each story beat |
| `audit-quest-coverage.mjs` | quest cast × stage: who has a line and who falls back to idle |
| `audit-dialogue-reach.mjs` | walks all **384** consistent world states; which authored pages are never seen |
| `audit-word-matrix.mjs` | the ASK table: teachers, answerers, what each term is *for* |
| `audit-talk-reach.mjs` | can the player press Z on this person **under the runtime's rule** |

---

## 1. Diagnosis

Three systems speak to the player:

* **quests** — `src/quests.js` + `src/data/quests.js` (stages, asides, `after`)
* **idle dialogue** — `src/data/dialogue.js` variants keyed to story flags
* **word memory** — `src/word-memory.js` (`teaches` / `answers` on the spec)

**Nothing owns the arbitration between them.** The priority order is inlined in
twenty lines of `npc.js#talkToNpc`, every tool re-derives it, and five distinct
defect classes fall straight out of that:

**R1 — `after` shadows idle forever.** Once a quest is `done`, `quest.after[key]`
outranks the NPC's own lines for the rest of the save. Cid's post-curse idle
(`town-npcs.js:868`) and Sara's `sara_found` idle (`:1307`) are authored,
measured by `check-dialogue-fit`, and **impossible to see** — proven over all
384 states. Sara's surviving line, *"I am still going back for that thing"*,
outlives the thing.

**R2 — mid-quest coverage is a hand-maintained matrix.** `also` is written
per-stage-per-person, so a cast of 4 across 5 stages is 20 cells filled by hand.
**12 of them are empty.** At stage `found` the King has no aside at all and
answers *"King Sasune. Or I was."* — no mention of the daughter he sent you
after. The smith reverts to his pre-quest line for `return` **and** for the rest
of the game.

**R3 — the quest spine is a strict array; the world is not.** The King hands you
the canoe at `ask`, which opens the Sealed Cave immediately. Walk in, find Sara
at stage `errand`, and **nothing happens** — `found` only fires after `errand`
and `forge`. The shortest honest route to the princess dead-ends.

**R4 — only quests can change the world.** `setFlag` is called from exactly one
place in the entire client: `quests.js:192`, a quest stage. Ur's defining event
— the Altar Cave, the Land Turtle, the Wind Crystal — sets **no flag**, so no
one in Ur can react to it. That is the mechanical reason **39 of 49 people say
the same thing from new game to endgame** (Ur 2/25, Kazus 2/12, Sasune 5/11).

**R5 — the gates model a game we don't ship.** `tools/lib/talkable.mjs` allows
talking *across* a solid counter; `movement.js:353` calls
`findNpcAt(facedX, facedY)` on the **one** tile faced and opens the shop
instead. So `check-npc-room` passes **7 NPCs the player can never talk to**,
four of whom carry authored lines — including `ur_tavern_keep`, who is walled in
on all four sides on a map with **no shop counter at all**, and who answers
BROTHER with a quest lead: *"He drank here. Then he went down."*

Plus two data leaks the gates never look for: `canoe_granted` is set and **read
by nothing**; five exported NPC specs (`CID_MAN`, `UR_HOUSEHOLDER`,
`UR_INN_GUEST_15/16A/16B`) are placed on no map.

---

## 2. Target architecture

### 2.1 `src/speech.js` — one resolution pipeline

Everything that decides what a person says moves behind one pure function:

```js
resolveSpeech(mapId, npcKey, spec, world) -> { source, pages, act } | null
```

`source` is one of `notice` · `advance` · `waiting` · `aside` · `idle`.
`act` is what pressing Z *does* (`advance-stage` / `nothing`), so the caller
never has to infer intent from which branch produced the pages.

`npc.js#talkToNpc` becomes: call it, show `pages`, run `act`. Gates and the
transcript tools call the identical function — this is the
`single-source-paths` rule, and it is what makes every gate below trustworthy.

### 2.2 `after` becomes world state, not quest state (**D1**)

Delete `quest.after` as a resolution layer. A quest's payoff line becomes an
**idle variant keyed to a flag**, which is exactly the argument `data/flags.js`
already makes in its own header about why `when: (q) => q('quest_id')` was
wrong: *"a flag says what is true about the WORLD; a quest says where one player
is in one errand."* What Cid says forever afterwards is the former.

Consequences, all good:

* R1 dies by construction. Idle is the **base** layer; nothing outranks it
  permanently, so an endgame variant an author writes is the one that shows.
* One table per person for "what I say when nothing urgent is happening", with
  the full flag grammar already in `dialogue.js`.
* Quest data then describes a quest **in progress only** — a clean seam.

Cost: every quest's final stage must `set` a flag. Two already do
(`djinn_sealed` / `curse_lifted`). Three new ones needed: `brother_avenged`,
`road_cleared`, `daughter_home`. Payoff prose moves out of the quest block onto
the NPC row; reviewability is covered by `audit-quest-coverage`, which prints
the whole cast script in stage order regardless of where the strings live.

> **Alternative if you'd rather keep `after` co-located:** make `after` a
> flag-variant value run through `resolvePages`, and fall through to idle when
> no variant matches. That fixes Sara's stale line but leaves the shadowing
> mechanism in place, so R1 can come back the next time someone writes an
> endgame idle variant. My recommendation is the collapse. — **your call.**

### 2.3 `voice` — coverage by construction

Replace per-stage `also` with a per-person block on the quest:

```js
voice: {
  sasune_king: [
    { while: ['errand', 'forge'], pages: [...] },
    { while: ['found'],           pages: [...] },   // ← the hole today
  ],
  kazus_smith: [ ... ],
}
```

Same information, transposed: you write one person's whole arc in one place, in
order, and a missing stage is visible on the page instead of discoverable only
by walking the game. `also` is **deleted**, not aliased — a second way to say
the same thing is the divergence rule.

The gate (§4.1) then reads: *for every quest, every stage, every cast member,
`resolveSpeech` returns a source other than `idle`* — unless the person is named
in a `quiet: []` list with a written reason. That turns R2 from "12 holes a new
tool found" into "the build fails".

### 2.4 Leads and beats — the spine stops being an array index (**D2**)

A stage gains one optional field:

```js
{ id: 'errand', lead: true, ... }
```

* A **beat** (default) is a hard gate and cannot be skipped.
* A **lead** is optional colour. Reaching a *later* stage's `at` NPC when that
  stage's own precondition holds **jumps the quest forward**, skipping any
  intervening leads.

For the Sasune chain: `errand` and `forge` become leads, `found` stays a beat.
Sail north at stage `errand`, talk to Sara, and the quest jumps to `found` and
advances — while the intended route still gets both asides and both leads. A
skipped lead's information is not lost, because §2.3's coverage gate forces the
smith and the servant to have something to say at every later stage anyway.

**Server impact: none.** `isLegalStage` is id-membership and `maxObjectiveCount`
is a maximum; neither depends on stage order. `data/quests.js` stays
import-free. `ps.quests = {s, n}` is unchanged, so there is no save-shape
lockstep to do.

### 2.5 World events set flags too

Add flag setters at the event sites that already exist, so the world can change
for reasons that are not errands:

| flag | set where |
|---|---|
| `altar_boss_beaten` | the Land Turtle defeat path (`battleSt.enemyDefeated`) |
| `wind_crystal_woken` | `npc.js#_talkToCrystal`, first talk |

That is the mechanical unlock for Ur. Without it, "Ur reacts to the Altar Cave"
is unwritable no matter how many lines we author. Both flags need a row in
`data/flags.js` (import-free; `api.js` validates against the same table, so it
is one edit, not two tables).

### 2.6 Reachability: the gate learns the runtime's rule

* `tools/lib/talkable.mjs` grows `canTalk()` = *some standable tile is
  orthogonally adjacent* — the rule `movement.js` actually implements. The
  counter clause survives under its own name, used only to justify the marker
  below.
* Every placed NPC must be **either** directly talkable (and then **must** have
  dialogue — silence on Z is a bug) **or** marked `counterBound: true` (and then
  must have **no** dialogue and **no** word entries, because none of it can
  fire).
* Ur's three keepers get the marker. Kazus's three lose dialogue that has never
  once been read.
* `ur_tavern_keep` is neither, and is the one real casualty — see **D3**.

---

## 3. Content plan

### 3.1 The fork: which Kazus and Sasune do we ship? (**D4 — the big one**)

`project_ff3mmo_cursed_town_inversion` is measured and still parked on your
call. It decides *what the dialogue work even is*, so it has to be answered
before a line is written:

* **W1 — ours.** Living villagers present throughout; the curse shows in what
  they *say*, and their lines change on `curse_lifted`. Work = **16** second
  variants (Kazus 10, Sasune 6 — the other 7 already change).
* **W2 — the cartridge's.** Ghosts populate Kazus and Sasune until the Djinn is
  sealed; the living cast switches on afterwards. Work = 21 ghost rows placed +
  16 living rows gated + two casts of dialogue.

W1 is a third of the work and keeps the towns legible. W2 is what the hardware
does and makes the curse a thing you *see*. I am not picking this one.

### 3.2 Era coverage, with targets

Once §2.5 lands, every town has at least two states, and the gate can hold a
number instead of a feeling:

| town | eras | people | target |
|---|---|---|---|
| Ur | pre-Altar / crystal woken | 25 | every reachable person ≥2 variants |
| Kazus | cursed / lifted | 12 | ≥2 (W1) or two casts (W2) |
| Sasune | cursed / Sara found / home & lifted | 11 | ≥2, quest cast ≥3 |

Today: Ur 2/25, Kazus 2/12, Sasune 5/11.

### 3.3 The Sasune chain, rewritten

Fills the 12 measured holes and repairs the lies:

* **The lie.** `town-npcs.js:1259`, the smith's default answer to SARA:
  *"The princess? Here. She has not left."* She is not in Kazus. Rewrite as the
  lead it should be — he cut the ring, she asked him what crosses water.
* **The King at `found`** gets his missing `voice` entry.
* **The smith at `return` / afterwards** stops reverting to his pre-quest line.
* **The servant at `forge` / `found`** stops re-reading you the lead he gave.
* **Sara at `errand` / `forge`** gets lines for the player who arrives early —
  which §2.4 turns into a real branch rather than a dead end.
* **After the Djinn:** Sara's *"Take me home, would you"* is a request the game
  cannot honour (she has no walk-home path). Either give her one — a `when`
  predicate that moves her to Sasune on `djinn_sealed` — or change the line.
  (**D5**)
* **Cid's AIRSHIP answer** after the seal still says *"Clear the road first."*
* **`canoe_granted` gets a reader**: the gate guard and the servant remark on
  the boat you are carrying. Otherwise delete the flag. (**D6**)

### 3.4 Words: 8 terms, and what each is for

Measured today: **4 of 8** terms start a quest — BROTHER, RIDERS, SARA, DJINN.
CAVE, VEIN, AIRSHIP and RING are flavour: asking about them changes nothing
anywhere, in any state. **20 of 53** placed people have any word behaviour; 33 answer
nothing at all. Kazus, whose entire story is the curse, has **two** people who
respond to DJINN.

That is not automatically wrong — FF2 has plenty of people who know nothing —
but it should be a decision, not a leftover. Proposed: every town keeps one
term that **does** something and two that reward asking around, and every quest
cast member answers the terms their own quest is about.

### 3.5 Style, and the duplicates

* A `docs/VOICE.md` sheet: one paragraph per town and per named character, so
  lines stay in register across sessions. Ur is plain and tired; Kazus is
  clipped and proud; Sasune is formal. Sara is not a damsel.
* Kill the duplicates: four Sasune posts share one page set verbatim; both
  throne attendants share theirs in **both** states.
* Kill the meta line: `ur_npc_05`'s *"You have the look of someone who asks.
  Ask, then."* is UI instruction in a character's mouth.
* Lint (§4.4): page width, terminal punctuation, no one-word pages, no double
  spaces, nothing the font lacks.

---

## 4. Gates

Five new gates in `deploy.sh`. **Each is proven by reverting the fix it guards
and watching it fail** — a gate that has never failed is a comment.

1. **`check-speech-coverage`** — quest cast × stage; any `idle` fallback that is
   not in an explicit `quiet: []` fails. *Revert proof: delete the King's
   `found` entry → fail.*
2. **`check-dialogue-reach`** — walks all consistent world states; **zero**
   authored page sets may be unreachable. *Revert proof: re-add Cid's shadowed
   idle → fail.*
3. **`check-talk-reach`** — runtime rule; talkable ⇒ has lines, `counterBound` ⇒
   has none. *Revert proof: drop the marker on a keeper → fail.*
4. **`check-dialogue-style`** — width, punctuation, duplicates (allowlisted),
   banned meta phrasing. *Revert proof: re-duplicate a post's line → fail.*
5. **`check-flag-readers`** — every declared flag has ≥1 reader; every quest's
   final stage sets ≥1 flag; every exported NPC spec is placed. *Revert proof:
   drop `canoe_granted`'s reader → fail.*

`audit-npc-talk.mjs` stays a **human** instrument, not a gate — read the
transcript before every dialogue release.

---

## 5. Phasing

Each phase is its own version bump, CHANGELOG entry, `./deploy.sh`, and live
verify on ff3mmo.com, per the deploy law.

**Phase 1 — engine.** `speech.js`; `after` → flags; `also` → `voice`; leads;
world-event flag setters. **No content change** — the transcript before and
after must differ only where a hole is filled. Gates 1, 2, 5.

**Phase 2 — reachability & hygiene.** `canTalk`, `counterBound`, `ur_tavern_keep`,
the five orphan specs, `canoe_granted`. Gate 3.

**Phase 3 — content.** The Sasune chain rewrite, the era dialogue for whichever
world D4 picks, duplicates, style, `docs/VOICE.md`. Gate 4.

**Phase 4 — new material,** only if you want it: more quests, more terms, the
shop-greeting idea for counter-bound keepers.

**Risks / lockstep**

* `data/quests.js`, `data/flags.js`, `data/keywords.js` must stay **import-free**
  — `api.js` and `economy-arbiter.js` import them and one browser-only import
  takes the server down at boot.
* New flag ids need `data/flags.js` only; `api.js` validates against that same
  table.
* No `ps.*` shape change is planned. If one appears it needs the client
  serializer **and** the server validator in the same commit.
* Phase 1 is the only phase that can silently change existing behaviour. The
  before/after transcript diff is the check, and it is cheap.

---

## 6. Explicitly out of scope

* **No quest journal, no overhead marker.** Removed deliberately in
  v1.7.990/991; Word Memory is the signposting. Adding a UI would undo the
  design.
* **No new art, no hand-authored sprites.** Placement stays on ROM records read
  from `npc-dump.mjs`.
* **No re-litigating the magic sign** (`$17` on Kazus is correct, closed).
* **Cid does not join the party.** That is a special-character system ff3mmo
  does not have.

---

## 7. Decisions I need from you

| # | question | my recommendation |
|---|---|---|
| **D1** | Collapse `after` into flag-keyed idle, or keep `after` and make it variant-capable? | **Collapse.** It kills the shadowing class outright. |
| **D2** | Leads-and-beats, so finding Sara early works? | **Yes.** The canoe arrives at `ask`; the cave is the obvious next move. |
| **D3** | `ur_tavern_keep` is walled in with no shop counter. Move him to a standable tile, or mark him counter-bound and move his BROTHER/VEIN answers to a reachable drinker? | **Move him.** He is on the cartridge's own record — but people talk to bartenders, and BROTHER is a quest lead. |
| **D4** | **W1** (living villagers, dialogue changes) or **W2** (the cartridge's ghost cast, gated on the Djinn)? | No recommendation. W1 is a third of the work; W2 is what the hardware does. Yours. |
| **D5** | After the Djinn, does Sara walk home to Sasune, or stay in the cave with a rewritten line? | **Walk home.** She asks to go home; the game should let her. |
| **D6** | `canoe_granted`: give it readers, or delete it? | **Readers.** "You came by boat" is a beat worth having. |
| **D7** | Phase 4 at all, or stop after 3? | Stop after 3, then look at the transcript and decide. |

---

# 8. Audit of this plan — 2026-08-27

Self-audit at Joel's instruction, with the cartridge and published walkthroughs
as the yardstick. **Ten findings. Two of them invalidate parts of §2–§7 above.**
Nothing in §1–§7 has been edited; the corrections are here.

## 8.1 The ballpark — measured, not estimated

Decoded from `docs/FF3-SCRIPT.md` (script ids `0x210`–`0x246` are the whole
beginner valley) against our own tables:

| | strings / pages | words |
|---|---|---|
| **FF3 cartridge** — Ur `0x210-0x21e` | 14 | 223 |
| **FF3 cartridge** — Kazus `0x220-0x237` | 24 | 461 |
| **FF3 cartridge** — Castle Sasune `0x238-0x246` | 15 | 485 |
| **FF3 cartridge — WHOLE VALLEY** | **53** | **1,169** |
| ff3mmo — Ur | 125 | 517 |
| ff3mmo — Kazus | 75 | 328 |
| ff3mmo — Sasune | 110 | 477 |
| ff3mmo — Cave of Seals | 17 | 80 |
| **ff3mmo — WHOLE VALLEY** | **327** | **1,402** |

**We already carry 20% more words than the cartridge does for the same three
towns and dungeon, and 2.3× its budget in Ur.** Volume is not the problem, and
§3.2's targets are pointed at the wrong axis (see 8.3).

Where the cartridge spends its words is the real difference. Of its 53 strings,
roughly **ten are event beats** — `0x224` the throne reunion, `0x238` the
runner, `0x239` the curse lifting, `0x240` the canoe, `0x241` Sara staying,
`0x245` finding her, `0x246` her joining — several over 100 words each. The rest
is thin ambient flavour, most of it one line. **We have inverted that ratio: 327
pages of ambient one-liners and almost no beats.**

## 8.2 ⛔ This plan duplicates one that already exists, and drops three of its open items

`docs/QUEST-DIALOGUE-PLAN.md` (2026-08-25, shipped in part as v1.10.89) already
specifies stages, the objective registry, story flags, variant dialogue and
gates 1–4. Its **§11 carries three items still open that §1–§7 above never
mention**:

1. **⛔ Prose still lives in the server's table** (its §5.1). `data/quests.js` is
   roughly 45% English and `economy-arbiter.js` + `api.js` both import it to
   validate claims. Its gate 5 is blocked on the split. **This is the single
   most load-bearing "professional" item in a dialogue refactor and I omitted
   it entirely.** See 8.4 — my own §2.3 makes it worse.
2. **The vehicle grant still bypasses the claim ledger** (its §5.6).
   `quests.js#_grantVehicle` and `_parkCraft` run client-side;
   `validateQuestClaim` returns gil and item events only. My §3.3 D5 adds more
   traffic to that path without noticing it is the one payout off the ledger.
3. **The inversion's real cost.** I raised it as D4 but dropped its measured
   consequence: `kazus_inn_keep`, `kazus_item_keeper`, `kazus_weapon_keeper` and
   `kazus_armor_keeper` are all in the "wrongly shown" list, so **W2 closes four
   of Kazus's commerce points for the whole early game.** Ur keeps its four, so
   nobody is stranded — but that is a balance change, not a dialogue change.
   ✅ The related ice-scroll deadlock warning is **closed**: `kazus_magic` is
   map 15 and its keeper is placed from `map-loading.js:385`, not `TOWN_NPCS`,
   so the inversion cannot hide the Djinn's only counterplay.

## 8.3 §3.2's content targets are aimed at the wrong axis

Given 8.1, "author 16 second variants" is not what makes this feel
professional — we would be adding ambient text to a valley that already has more
of it than the source game. The work that actually closes the gap is:

* **state**, not volume — the 327 pages we have are almost all frozen; and
* **beats**, not flavour — the cartridge's ten event strings have no counterpart
  here beyond the opening scene.

§3.2 should be rewritten as *"re-key the text we already own to the world's
state, and add the four or five missing beats"*, with a **words-per-town budget
that does not grow**. Ur in particular should probably shrink.

## 8.4 ⛔ `voice` as specified moves prose INTO the server's table

§2.3 puts a `voice` block on the quest record. `data/quests.js` is the file the
server imports. That pushes the refactor **in the opposite direction** from the
existing plan's §5.1, which exists precisely to get English out of that file.

**Correction:** `voice` — and `offer`/`say`/`onAdvance`/the collapsed `after` —
belong in `src/data/script.js`, client-only, keyed by id. The quest record keeps
`at`, `objective`, `sets`, `lead`, `item`, `vehicle`, `reward` and nothing a
player ever reads. §5.1 and this refactor are **one job**, and doing them
separately means moving the same strings twice.

## 8.5 The cartridge validates Joel's ordering, and retires a caveat

Both the walkthroughs and the script agree on the shape:

* The party **finds Cid's airship in the desert west of Kazus first**, and
  `0x225` is Cid saying *"Cross the lake with my airship and you'll reach the
  Sealed Cave."* **The vehicle is granted BEFORE the search in canon too.**
* **Princess Sara is found INSIDE the Sealed Cave**, part-way down — not in a
  town, not in a tower.
* She then **follows the party** for the rest of the dungeon (`0x246`: *"Then
  let's go together. You can't seal the Djinn without my ring."*).
* The canoe (`0x240`) is a **thank-you afterwards**, not the key.

So `QUEST-DIALOGUE-PLAN.md` §3's "⚠ this reorders canon" caveat and its "⛔
consequence: Sara cannot be in the cave" are both **wrong and should be struck**.
Our shape — a craft handed over at the ask, the princess found inside the
dungeon — *is* the cartridge's shape, with the canoe substituted for the airship
because our terrain measurably requires it. Joel had it right in the room.

## 8.6 The beat this plan never proposes: Sara follows you out

It is the beat the cartridge leans on hardest and the one that would most change
how the Cave of Seals plays. `npc.js` already has walk modes and a yield path.

⛔ **Not a party member** — that is the special-character system ff3mmo does not
have and must not invent. A follower NPC is a different, smaller thing. It is
also real scope, and it belongs to Joel, not to a phase list. **New decision
D8.**

## 8.7 D4 is posed as a binary and the cartridge does both

`0x233` *"I miss my beautiful face!"* → `0x234` *"Now everyone can see my
beautiful face again."* is **the same villager, two lines, one flag** — W1.
The ghost bundle swap on a fresh game is W2. FF3 ships **both**: ghosts occupy
the tiles, and the living cast that replaces them carries paired before/after
lines. D4 should be re-posed as *how much of the ghost cast do we place*, with
the paired-line work happening either way.

## 8.8 D5 needs a capability that does not exist

§3.3 says Sara walking home is "a `when` predicate + a placement row".
It is not. `map-loading.js:243` places her **unconditionally**:

```js
if (mapId === SARA_MAP_ID) placeSaraInExitChamber(result);
```

`GENERATED_NPCS` has no `when` support and the placer never consults the
declaration. `TOWN_NPCS` honours `when`; `GENERATED_NPCS` does not — **two
placement paths, one of which cannot see story state.** That is the divergence
rule, and closing it is a prerequisite for D5, not a detail of it.

## 8.9 `check-dialogue-reach` as specified will get switched off

"Zero unreachable page sets" fails the moment somebody writes a line for a state
whose path is not built yet — which is normal during a content pass. Without an
explicit, commented allowlist it becomes a gate people comment out, and a gate
that gets disabled is worse than no gate. Add the allowlist, and gate the
allowlist's size.

## 8.10 Phase 1's acceptance test needs teeth

§5 claims Phase 1 changes no content, but collapsing `after` relocates strings
between files and layers. The acceptance test must be stated as a hard artifact:
**`node tools/audit-npc-talk.mjs --all` diffed before and after must be empty
except at the 12 known holes.** Capture the "before" transcript to a file at the
start of Phase 1, or the claim is unfalsifiable.

## 8.11 Revised shape

1. **Merge with `QUEST-DIALOGUE-PLAN.md`.** One plan. Its §5.1 and §5.6 become
   Phase 1 items here, not carried debt.
2. **Phase 1 = `script.js` split + `speech.js` + `voice` + leads + world-event
   flags + `after` collapse.** All string movement happens once.
3. **Phase 2 = reachability, the `GENERATED_NPCS` `when` gap, vehicle onto the
   ledger.**
4. **Phase 3 = re-key what we own; add the missing beats; hold the word budget
   flat.** Not "16 more variants".
5. Gates as in §4, with 8.9's allowlist.

## 8.12 Decisions, updated

D1–D3, D6, D7 stand. Changed or new:

| # | question | recommendation |
|---|---|---|
| **D4** *(re-posed)* | Not W1-vs-W2. **How much of the ghost cast do we place, given it closes four Kazus commerce points?** Paired before/after lines get written either way. | Ghosts in the **pub and the halls** (atmosphere, no commerce), living keepers stay open. Half W2, no balance change. Still yours. |
| **D5** *(re-scoped)* | Sara walking home first needs `when` support on `GENERATED_NPCS`. Do that, or rewrite her line? | Do the capability — the divergence is a bug on its own. |
| **D8** *(new)* | Does Sara **follow the party** out of the Cave of Seals, as she does in canon? | Want it, but it is real scope. Ship the refactor first, then decide. |
| **D9** *(new)* | Word budget: hold flat at ~1,400 and re-key, or grow? | **Hold flat.** We are already over the cartridge. Ur can afford to lose some. |

---

# 9. APPROVED — Joel's direction, 2026-08-28

Go on the whole thing. D1, D2, D3, D6, D9 as recommended. D8 is **NO** — Sara
does not follow the party. D4/D5 are superseded by the direction below.

## 9.1 What Joel asked for, verbatim in effect

* Finding Sara is a **beat, not a follower**: dialogue, the **fanfare that plays
  when a story character joins**, a message box saying she is found, and a line
  sending you back to the King.
* She then **spawns in the secret ring room in Castle Sasune — the secret water
  room** — and **gives another quest there**.
* **The King gives the canoe**, and only the canoe, to reach the Sealed Cave.
  *"I want players to be on foot more."*
* **Cid, as a ghost, gives the quest whose reward is the airship**, after the
  Djinn is beaten. (Already how `kazus_sealed_cave` works — unchanged.)
* The airship still cannot leave the valley, *"which is what we want."*

## 9.2 ⭐ The secret water room is MAP 24, and it is the Holy Spring

Found by searching every Castle Sasune map for tileset-6 water tiles
(`$17 $18 $19 $1f`) and then **rendering it and looking**:

* Maps **20 / 21 / 23** are 712 tiles of solid `$1f` — the moat, not a room.
* **Map 24** has a three-tile water feature at **(10,7) (11,7) (12,7)**, and the
  render shows a **circular white-and-blue basin with a radiating star**, a red
  altar directly above it at (11,5), and pedestals around it.

That is the Holy Spring the cartridge throws the Mythril Ring into. Canon backs
a hidden way in: script `0x23c` — *"There's a hidden path to the treasure room
in this castle."*

**Sara's tile: (11,8)** — directly south of the basin, walkable, with the player
approaching from below. Map 24 lists **ZERO ROM NPC records**, so the tile is
ours to choose, exactly as the East Tower would have been.

## 9.3 ⛔ Map 24 is unreachable today — this is the real cost

```
areas.js      unreachable: new Set([24])
check-area-graph   Castle Sasune: 11/12 reachable (1 declared unreachable: 24)
map-ascii 24       ROM entrance (1,26) -> 31 reachable tiles, and the
                   spring room is NOT among them
```

Nothing in the castle points a door at map 24, and its own door 0 points at
itself. Its ROM entrance drops the player in a dead 31-tile pocket in the
south-west corner.

**⚠ The `areas.js` comment is wrong on one detail:** it says map 24 is in
`map-triggers.js#STRANDING_MAPS`. It is not — that set is
`{0,34,94,135,152,159,169,180,193,255}`. Map 24 is unreachable only because
nothing leads there. Fix the comment.

**The work:** a secret door in a built castle map that warps to map 24 at
**(5,5)** — the ROM's own `exit_prev` tile, which *is* inside the spring
region. We already own every piece: `openPassage()` (the Altar Cave's
third-torch passage), the locked-door + Magic Key path, and `placeChamberDoor`.

## 9.4 ✅ The sprite-bundle objection does NOT apply to us — measured

Map 24 loads **no townsfolk walk bundle** on hardware
(`MAPS=24 map-bundles.cjs`: `0x1B400`–`0x1BD00`, `0x50000/1`, player and battle
bundles only). That is the same finding that killed the East Tower for Sara and
pins map 11 empty. **Self-tested:** the same probe on map 29 returns
`0x1ED00 0x1EE00 0x1EF00`, the exact bundles we dress the King and attendants
in, so the negative is real *on the cartridge*.

**It does not bind ff3mmo.** `sprite.js:71` is
`decodeTile(this.romData, this.gfxBase + tileIndex * 16)` — we decode sprite
tiles straight out of ROM bytes at an arbitrary offset. There is no CHR-RAM and
no per-map bundle set in our renderer; the map supplies only the two sprite
palettes (`data/npc-palette.js`).

Rendered Sara's own bundle `0x1D910` through **the game's own decoder and the
game's own `mapPalettesForSpec`**, under four maps' palettes:

| map | result |
|---|---|
| 10 Kazus | correct, green cap |
| **24 spring room** | **correct, green cap** |
| 25 Sasune hall | correct, blue cap |
| 29 throne | correct, blue cap |

Shape is identical everywhere; only the cap colour moves with the map's SP3.
**No noise, no corruption.**

⭐ And we have already relied on this: Sara stands in the Cave of Seals today,
a generated dungeon floor that loads no townsfolk bundle either, and she renders
correctly in play.

So the constraint is a **gate policy** — `check-npc-placement` pins each map to
the cartridge's bundle set — not an engine limit. Placing her on map 24 means
adding map 24 to that gate's table with a written reason. That is a documented
fidelity exception for one story character, and it is Joel's call to take it.

⛔ Do NOT retire the rule generally. It is what stops ordinary villagers being
dressed in bundles their room never loads, and that rule caught real bugs.

## 9.5 The fanfare

There is **no measured FF3 track catalogue** — `docs/SOUND-CATALOG.md` covers
FF1 only (23 tracks) and `tools/monscan/sound-catalog.json` holds that one game.
So the join fanfare is **not yet identified**, and I am not going to guess a
song id.

* **Proven fallback, already wired:** `TRACKS.VICTORY = 0x07`, FF3's battle
  fanfare.
* **Preferred:** audition the FF3 song table for one-shot jingles through the
  existing `/sfx` path and pick by ear. Precedent: `SFX.CRYSTAL_THUNDER` is
  labelled *"Found by audition (/sfx)"*.

## 9.6 Revised quest chain

**Quest 1 — `sasune_missing_daughter`** (King). Canoe at `ask` (unchanged).
Leads `errand` / `forge` become skippable (D2). Beat `found` in the Cave of
Seals gains: fanfare + a found-her message + *"go back to the King."* Ends at
`return` with the King. Sets `daughter_home`.

**Quest 2 — `kazus_sealed_cave`** (Cid, cursed). Boss `0xCD`. Reward: the
airship, valley-bound. **Unchanged.**

**Quest 3 — NEW, Sara at the spring, map 24 (11,8)**, gated on
`daughter_home`. Subject open — the ring, the spring, or what the Djinn left
behind. ⛔ Needs a `startWord`, a teacher who says it in a line they would say
anyway, and a stage cast that passes `check-speech-coverage`.

## 9.7 Added to the work

| # | item | phase |
|---|---|---|
| 1 | secret door → map 24 @ (5,5); take 24 out of `unreachable`; fix the wrong `STRANDING_MAPS` comment | 2 |
| 2 | map 24 added to `check-npc-placement`'s bundle table, with the reason | 2 |
| 3 | `when` support on `GENERATED_NPCS` so Sara can leave the cave | 1 |
| 4 | Sara's second placement row: map 24 (11,8), `when: daughter_home` | 3 |
| 5 | fanfare identified by audition; found-her beat wired | 3 |
| 6 | Quest 3 authored | 3 |
