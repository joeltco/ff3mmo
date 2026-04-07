-- FCEUX Lua: dump status animation PPU tiles during battle
-- Reads PPU $1000 sprite bank for tiles $49-$5C (all 8 status animations)
-- Also reads the ROM tiles the user found at $56A50 to compare
-- Reuses battle entry state machine
-- Output: tools/status-tiles-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/status-tiles-dump.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame = 0
local done = false
local state = "title"
local last_mode = 0xFF
local name_timer = 0
local settle_timer = 0
local SETTLE_FRAMES = 90
local turn_timer = 0

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  f:close()
  emu.message("Done! Check status-tiles-dump.txt")
end

function keep_monsters_alive()
  for m = 0, 7 do
    local base = 0x7675 + m * 0x40
    if memory.readbyte(base + 0x05) > 0 then
      memory.writebyte(base + 0x03, 0xFF)
      memory.writebyte(base + 0x04, 0x00)
    end
  end
end

function force_poison()
  local s1 = memory.readbyte(0x7637)
  memory.writebyte(0x7637, bit.bor(s1, 0x02))
  local d = memory.readbyte(0x78BC)
  memory.writebyte(0x78BC, bit.bor(d, 0x40))
  -- Set display status ID to 5 (poison) for char 1
  memory.writebyte(0x78C4, 0x05)
  -- Also copy to animation buffer
  memory.writebyte(0x7DB7, 0x05)
  local fs = memory.readbyte(0x6102)
  memory.writebyte(0x6102, bit.bor(fs, 0x02))
  log(string.format("[%d] Forced poison + display status on char 1", frame))
end

function dump_ppu_tile(tileId)
  local addr = 0x1000 + tileId * 16
  local bytes = {}
  for i = 0, 15 do
    table.insert(bytes, ppu.readbyte(addr + i))
  end
  local hex = {}
  for _, b in ipairs(bytes) do table.insert(hex, string.format("0x%02x", b)) end
  local nonzero = 0
  for _, b in ipairs(bytes) do if b ~= 0 then nonzero = nonzero + 1 end end
  log(string.format("  PPU tile $%02X (addr $%04X): [%s]  (%d nonzero bytes)",
    tileId, addr, table.concat(hex, ","), nonzero))
  return bytes
end

function dump_all_status_tiles()
  log("=== STATUS ANIMATION PPU TILES ($49-$5C) ===")
  log("  Per-char base tiles: char1=$49, char2=$4D, char3=$51, char4=$55")
  log("  Each status: 4 tiles (frame1: base,base+1  frame2: base+2,base+3)")
  log("")

  -- Dump all status tiles for all 4 characters
  for tileId = 0x49, 0x5C do
    dump_ppu_tile(tileId)
  end

  log("")
  log("=== SPRITE PALETTES ===")
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("  sprPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end

  log("")
  log("=== NEARBY PPU TILES (context: $40-$60) ===")
  for tileId = 0x40, 0x60 do
    dump_ppu_tile(tileId)
  end

  log("")
  log("=== JS-READY OUTPUT (char 1 poison bubble) ===")
  log("// Frame 1: tiles $49 + $4A")
  local t49 = {}; local t4a = {}
  for i = 0, 15 do table.insert(t49, string.format("0x%02x", ppu.readbyte(0x1000 + 0x49 * 16 + i))) end
  for i = 0, 15 do table.insert(t4a, string.format("0x%02x", ppu.readbyte(0x1000 + 0x4A * 16 + i))) end
  log("new Uint8Array([" .. table.concat(t49, ",") .. "])")
  log("new Uint8Array([" .. table.concat(t4a, ",") .. "])")
  log("// Frame 2: tiles $4B + $4C")
  local t4b = {}; local t4c = {}
  for i = 0, 15 do table.insert(t4b, string.format("0x%02x", ppu.readbyte(0x1000 + 0x4B * 16 + i))) end
  for i = 0, 15 do table.insert(t4c, string.format("0x%02x", ppu.readbyte(0x1000 + 0x4C * 16 + i))) end
  log("new Uint8Array([" .. table.concat(t4b, ",") .. "])")
  log("new Uint8Array([" .. table.concat(t4c, ",") .. "])")
end

-- State machine (reused from other scripts)
function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if mode == 0xA8 then
      if last_mode ~= 0xA8 then name_timer = 0 end
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
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      log(string.format("[%d] Heading to battle", frame))
    end
    last_mode = mode
    return
  end

  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode == 0x20 then
      state = "battle_settle"
      settle_timer = 0
      log(string.format("[%d] BATTLE START", frame))
      emu.message("Battle!")
    end
    last_mode = mode
    return
  end

  if state == "battle_settle" then
    keep_monsters_alive()
    settle_timer = settle_timer + 1
    if settle_timer == SETTLE_FRAMES then
      log(string.format("[%d] Battle settled — dumping PPU tiles BEFORE poison", frame))
      log("")
      log("=== DUMP 1: BEFORE POISON (baseline) ===")
      dump_all_status_tiles()
      force_poison()
      state = "wait_poison"
      turn_timer = 0
    end
    return
  end

  if state == "wait_poison" then
    keep_monsters_alive()
    turn_timer = turn_timer + 1

    -- Dump at several points to catch CHR bank changes
    if turn_timer == 30 then
      log("")
      log("=== DUMP 2: 30 frames after poison inject ===")
      dump_all_status_tiles()
    end

    if turn_timer == 60 then
      log("")
      log("=== DUMP 3: 60 frames after poison inject ===")
      dump_all_status_tiles()
    end

    -- Now mash A to advance the turn and trigger status animation
    if turn_timer > 60 then
      if turn_timer % 8 < 4 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    end

    if turn_timer == 120 then
      log("")
      log("=== DUMP 4: 120 frames (after A mashing) ===")
      dump_all_status_tiles()
    end

    if turn_timer == 200 then
      log("")
      log("=== DUMP 5: 200 frames ===")
      dump_all_status_tiles()
    end

    if turn_timer == 300 then
      log("")
      log("=== DUMP 6: 300 frames ===")
      dump_all_status_tiles()
    end

    if turn_timer >= 350 then
      finish()
    end
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Status Animation Tile Dump")
log("Reads PPU $1000 sprite tiles $49-$5C at multiple points during battle")
log("")

local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0]")
else
  log("[No save state — from title]")
end
