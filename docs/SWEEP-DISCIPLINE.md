# Sweep discipline

Written 2026-08-11 after Joel said, for at least the fourth time in one session,
that a sweep was half-assed. He was right every time. This file exists so the
next sweep starts from the failure list instead of rediscovering it.

## The pattern

**I check the half of the property that is easy to measure, declare the sweep
complete, and the hard half is the one that was broken.** In most cases the
evidence was already in output I had generated and had not read.

## The record

| version | what I claimed | what was actually true |
|---|---|---|
| v1.7.847 | "SFX wired for all 56 spells" | Checked only that no spell was **silent**, never that the sound was **right**. 23 spells played Fire's captured impact — Meteo, Kill, all 8 summons. My own sweep table printed `Meteo … 130` and `Fire … 130` on adjacent rows. |
| v1.7.847 | element cases "fixed" | Added **picked** sounds with comments (`// NSF $84 — thunder crash`) in the same style as real captures (`// NSF $82 — REC OAM f1301`), making a guess indistinguishable from data. |
| v1.7.851 | "compound elements ignored every weakness" | **False.** Misread an ARRAY's stringification (`['ice','air']` prints as `ice,air`) in a table I generated. `elemMultiplier` always handled arrays. Shipped a no-op fix and a gate asserting a comma-string present nowhere in the data. |
| v1.7.866 | dungeon gate proves floors traversable | The gate's reachability rested on a hand-written tile-id list nobody had checked against the real `MapRenderer.isPassable`. |
| v1.7.985 | ASK/LEARN panel "renders" | Never rendered it once. Shipped a BLACK box under a blue one with the cursor on the text baseline. Joel found it in the live build. |
| v1.7.988 | scroll-flash gate passes | Sampled the MIDDLE of the scroll, where the outgoing page has left and the incoming has not arrived: the reading is 0 with **or** without the bug. It passed on the broken build when revert-tested. |
| v1.7.989 | highlight gate covers the palette | Counted RED pixels — and the red was there, sitting on a black tile. Then the fix drew the box with a **no-op border function**, so an empty box read as 362 "text" pixels and it failed on correct code. Then it tested "near-black" when the offending colour is `0x06` = **(90,4,0)**, a dark red that sails through. |
| v1.7.993 | equip-emit gate is slot-aware | A "was there an emit within 4 lines" window let the RIGHT hand go silent, because the LEFT hand's emit sat four lines below it. |
| v1.7.995 | jobLevels revert proves the save gate | The revert **didn't revert** — an inner `slot.jobLevels` survived on the same line. Re-running it properly exposed that hop 4 accepted any mention of `slot.<field>`, which the NEW GAME template on line 657 satisfies for half the fields. |

## Before claiming a sweep is complete

1. **Presence vs correctness.** Did I check the thing EXISTS, or that it is
   RIGHT? Silent-vs-wrong, present-vs-correct, renders-vs-renders-properly.
   The easy half is never where the bug is.
2. **Read my own table.** Scan for repeated values across rows that should
   differ. That is exactly where Meteo and Fire sat.
3. **Confirm the data SHAPE.** Print `typeof` / `Array.isArray`. Never infer a
   shape from a stringified dump — that is what produced the v1.7.851 fiction.
4. **Provenance per value.** CAPTURED or PICKED? A pick must never wear a
   capture's citation. Make provenance a FIELD, not a comment
   (`SPELL_SFX_RULES` in `src/combatant-cast.js` is the shape to copy).
5. **Does the gate test the real thing, or my restatement of it?** Revert the
   fix and watch the gate fail, every time. **And check the revert actually
   landed** — a `python replace` that silently matched nothing produces a green
   run that looks like proof (v1.7.995).
6. **Where does the gate SAMPLE?** A pixel or timing check can be blind at the
   moment it looks. Measure the whole curve first, then place the sample where
   fixed and broken differ most (v1.7.988: 0 vs 0 at mid-scroll, 0 vs 287 late).
7. **Does the harness perform every step the game performs?** A tool that skips
   the IPS patch renders garbage glyphs; one that skips the border function
   renders a box with no interior. Both look like product bugs (v1.7.985/989).
8. **Never derive the expectation from the value under test.** `check-ff2-sfx`
   re-reads the register values out of the ROM rather than trusting `FF2_SFX`,
   which would agree with itself.
9. **Check `tools/` first, then BUILD one.** The harness usually already
   exists; when it does not, writing it is the normal first move, not a last
   resort. Never hand the work back to Joel.

## The honest closing line

A sweep report should end with **what is still unverified or unsourced**, with a
count. "47 of 56 spell sounds are picked, not captured" is a useful result.
"Magic SFX: fixed" was not.
