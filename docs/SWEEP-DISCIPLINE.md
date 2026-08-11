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
   fix and watch the gate fail, every time.
6. **Check `tools/` first.** The harness usually already exists. Never hand the
   work back to Joel.

## The honest closing line

A sweep report should end with **what is still unverified or unsourced**, with a
count. "47 of 56 spell sounds are picked, not captured" is a useful result.
"Magic SFX: fixed" was not.
