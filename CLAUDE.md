# Project Rules

## STOP WASTING TOKENS — Hard Limits

### When the user says something LOOKS wrong visually:
1. **DO NOT trace ROM disassembly.** DO NOT analyze hex offsets. DO NOT read bank data.
2. **Find or ask for a reference image IMMEDIATELY.** Download it. Analyze pixels with python/PIL.
3. **Compare reference pixels against our rendering.** Derive the correct values from the image.
4. **Apply the fix. Done.** Maximum 3 tool calls from "it looks wrong" to fix applied.

### The 3-strike rule:
- If you have made 3 tool calls trying to verify/prove something and still don't have the answer: **STOP.**
- Do NOT make a 4th attempt with a slightly different approach.
- Instead: ask the user, find a reference image, or try the simplest possible fix.

### NEVER do these:
- Spend more than 3 tool calls tracing ROM disassembly for a visual issue
- Launch research agents to "verify" data when the user already told you the answer
- Argue with the user about what something should look like — THEY KNOW, YOU DON'T
- Web search for sprite references when you can just download the actual sprite and analyze it
- Re-verify data you already verified — if it was wrong the first time, your METHOD is wrong
- **NEVER guess ROM offsets for sprite data** — ROM bytes ≠ PPU bytes due to CHR bank switching
- **NEVER use raw ROM offsets (BATTLE_SPRITE_ROM + N) for new sprite frames** — existing frames were mapped by previous devs, new frames MUST be captured from PPU via FCEUX Lua

### NEVER GUESS GAME DATA — LOOK IT UP FIRST
- **NEVER state item effects, stats, drop locations, or game mechanics from memory.** Always fetch a primary source first.
- When asked about FF3 NES item/enemy/spell data: **immediately WebFetch a known reference** (shrines.rpgclassics.com/nes/ff3/, guides.gamercorner.net/ffiii/, strategywiki.org, gamefaqs.gamespot.com).
- If you are not 100% certain of a fact, **do not say it** — look it up first.
- One wrong guess wastes more time than fetching the source. **Fetch first, answer second. Always.**

### The user is the source of truth for visual correctness. The ROM is not.

### PPU tile capture — MANDATORY process for new battle sprites:
1. **NES sprites use CHR bank switching (MMC3).** ROM bytes do NOT map 1:1 to PPU tile data.
2. **The ONLY way to get correct tile data is to dump it from PPU $1000 during the animation in FCEUX.**
3. PPU $0000 = background tiles. PPU $1000 = sprite tiles. **ALWAYS use $1000 for sprites.**
4. Write a Lua script that **auto-triggers on the correct OAM state** (don't rely on manual timing).
5. Dump: tile RAW bytes, sprite palettes (PPU $3F10+), and OAM positions for verification.
6. Use the dumped RAW bytes as hardcoded `new Uint8Array([...])` in game.js.
7. **Portrait sprites use the top 4 tiles (16×16) of a 2×3 (16×24) body.** Same as idle/hit/victory.
