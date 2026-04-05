-- FCEUX Lua: dump PPU tile data for miss sprite tiles ($61, $62, $63)
-- Based on dump-battle-palettes.lua state machine (same title/battle entry)
-- Forces player attacks to miss, waits for tile $61 to appear in OAM,
-- then dumps raw PPU bytes from $1000 sprite pattern table for tiles $61-$63.
-- Output: tools/miss-ppu-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/miss-ppu-dump-en.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame       = 0
local done        = false
local state       = "title"
local last_mode   = 0xFF
local name_timer  = 0
local battle_frames = 0
local dumped      = false

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  f:close()
  emu.message("Done! Miss tiles dumped")
end

-- Force all player attacks to miss by zeroing hit rate
function force_misses()
  -- Party member hit rates at offsets within party data
  for p = 0, 3 do
    local base = 0x6100 + p * 0x40
    memory.writebyte(base + 0x2E, 0x00) -- hit%
  end
end

-- Check OAM for tile $61 (miss sprite)
function has_miss_sprite()
  for i = 0, 63 do
    local tile = memory.readbyte(0x0204 + i * 4 + 1)
    if tile == 0x61 then return true end
  end
  return false
end

-- Dump raw 16 bytes of a PPU tile (2BPP planar, 8x8)
function dump_ppu_tile(tileNum)
  local addr = 0x1000 + tileNum * 16
  local bytes = {}
  for i = 0, 15 do
    table.insert(bytes, ppu.readbyte(addr + i))
  end
  return bytes
end

function dump_miss_tiles()
  log("=== MISS SPRITE PPU TILE DUMP ===")
  log(string.format("  frame: %d", frame))

  -- Dump sprite palettes
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("  sprPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end

  -- Dump tiles $61, $62, $63
  for _, tileNum in ipairs({0x61, 0x62, 0x63}) do
    local bytes = dump_ppu_tile(tileNum)
    local hex = {}
    for _, b in ipairs(bytes) do table.insert(hex, string.format("0x%02X", b)) end
    log(string.format("  tile $%02X PPU $%04X: [%s]",
      tileNum, 0x1000 + tileNum * 16, table.concat(hex, ",")))

    -- Also show as pixel grid for verification
    log(string.format("  tile $%02X pixels:", tileNum))
    for row = 0, 7 do
      local bp0 = bytes[row + 1]
      local bp1 = bytes[row + 8 + 1]
      local line = "    "
      for col = 0, 7 do
        local bit_pos = 7 - col
        local ci = bit.bor(
          bit.band(bit.rshift(bp0, bit_pos), 1),
          bit.lshift(bit.band(bit.rshift(bp1, bit_pos), 1), 1)
        )
        if ci == 0 then line = line .. "."
        elseif ci == 1 then line = line .. "1"
        elseif ci == 2 then line = line .. "2"
        else line = line .. "3" end
      end
      log(line)
    end
  end

  -- Also dump OAM positions for reference
  log("  OAM miss sprites:")
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y    = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x    = memory.readbyte(base + 3)
    if tile == 0x61 or tile == 0x62 or tile == 0x63 then
      local pal = bit.band(attr, 0x03)
      local hf  = bit.band(bit.rshift(attr, 6), 1)
      local vf  = bit.band(bit.rshift(attr, 7), 1)
      log(string.format("    spr%02d: x=%d y=%d tile=$%02X pal=%d hf=%d vf=%d",
        i, x, y+1, tile, pal, hf, vf))
    end
  end

  dumped = true
  log("=== DUMP COMPLETE ===")
end

-- ═══════════════════════════════════════════════════════════════════
-- State machine — same title/pressing entry as dump-battle-palettes.lua
-- ═══════════════════════════════════════════════════════════════════
function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- ── TITLE ──────────────────────────────────────────────────────
  if state == "title" then
    if mode == 0xA8 then
      if last_mode ~= 0xA8 then
        name_timer = 0
        log(string.format("[%d] Name entry screen", frame))
      end
      name_timer = name_timer + 1
      joypad.set(1, {})
      local seq = {
        [20]="A",[28]="A",[36]="A",[44]="A",[52]="A",[60]="A",[70]="A",
        [190]="D",
        [205]="A",[213]="A",[221]="A",[229]="A",[237]="A",[245]="A",[255]="A",
        [375]="D",
        [390]="A",[398]="A",[406]="A",[414]="A",[422]="A",[430]="A",[440]="A",
        [560]="D",
        [575]="A",[583]="A",[591]="A",[599]="A",[607]="A",[615]="A",[625]="A",
      }
      local act = seq[name_timer]
      if act == "A" then joypad.set(1, {A=true})
      elseif act == "D" then joypad.set(1, {down=true}) end
    else
      if frame % 4 < 2 then joypad.set(1, {A=true, start=true})
      else joypad.set(1, {}) end
    end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      log(string.format("[%d] Past name entry — pressing A into battle", frame))
      emu.message("Heading to battle...")
    end
    last_mode = mode
    return
  end

  -- ── PRESSING ───────────────────────────────────────────────────
  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if mode == 0x20 then
      state = "battle_settle"
      battle_frames = 0
      log(string.format("[%d] BATTLE START", frame))
      emu.message("In battle — forcing misses")
    end
    last_mode = mode
    return
  end

  -- ── SETTLE — wait for battle menu, force misses ────────────────
  if state == "battle_settle" then
    battle_frames = battle_frames + 1
    force_misses()
    -- Wait 90 frames for battle to fully initialize, then start attacking
    if battle_frames >= 90 then
      state = "attack_mash"
      battle_frames = 0
      log(string.format("[%d] Battle settled — mashing A to attack", frame))
    end
    last_mode = mode
    return
  end

  -- ── ATTACK — mash A to trigger attack (will miss) ─────────────
  if state == "attack_mash" then
    battle_frames = battle_frames + 1
    force_misses()

    -- Mash A to select Fight and confirm target
    if frame % 4 < 2 then joypad.set(1, {A=true}) else joypad.set(1, {}) end

    -- Check for miss sprite appearing
    if has_miss_sprite() and not dumped then
      log(string.format("[%d] Miss sprite detected in OAM!", frame))
      -- Wait a few more frames for all 3 tile types to appear
      state = "wait_full_miss"
      battle_frames = 0
    end

    if battle_frames > 600 then
      log("Timeout waiting for miss sprite")
      finish()
      return
    end
    last_mode = mode
    return
  end

  -- ── WAIT — let miss animation play out so $62/$63 also appear ──
  if state == "wait_full_miss" then
    battle_frames = battle_frames + 1
    force_misses()

    -- Check if tile $63 has appeared (last phase)
    local has63 = false
    for i = 0, 63 do
      if memory.readbyte(0x0204 + i * 4 + 1) == 0x63 then has63 = true; break end
    end

    if has63 or battle_frames >= 30 then
      dump_miss_tiles()
      finish()
      return
    end
    last_mode = mode
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Miss Sprite PPU Tile Dump")
log("")

-- Load save state slot 0
local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0 — fast-forwarding to battle]")
  emu.message("Save state loaded — heading to battle!")
else
  log("[No save state slot 0 — running from title screen]")
  emu.message("No save state — running from title")
end
