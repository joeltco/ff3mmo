-- FCEUX Lua: capture poison status sprite tiles from PPU
-- Based on dump-battle-palettes.lua state machine (battle entry proven working)
-- After battle settles: force poison, select Fight, let turn execute,
-- rapidly capture PPU tiles when CHR bank changes for status animation.

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/poison-sprite-dump.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame       = 0
local done        = false
local state       = "title"
local battle_start= 0
local last_mode   = 0xFF
local name_timer  = 0
local battle_frames = 0
local MAX_BATTLE_FRAMES = 1800

local settle_timer   = 0
local SETTLE_FRAMES  = 60
local turn_timer     = 0
local prev_tile49    = ""
local captures       = 0

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  log(string.format("=== DONE — %d captures ===", captures))
  f:close()
  emu.message("Done! " .. captures .. " captures")
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
  -- Char 1 battle status: $7637 bit 1 = poison
  local s = memory.readbyte(0x7637)
  memory.writebyte(0x7637, bit.bor(s, 0x02))
  -- Display status: $78BC bit 6 = poison
  local d = memory.readbyte(0x78BC)
  memory.writebyte(0x78BC, bit.bor(d, 0x40))
  -- Status ID for animation: $78C4 = 5 (poison)
  memory.writebyte(0x78C4, 0x05)
  memory.writebyte(0x7DB7, 0x05)
  -- Field status: $6102 bit 1 = poison
  local fs = memory.readbyte(0x6102)
  memory.writebyte(0x6102, bit.bor(fs, 0x02))
  log(string.format("[%d] Forced poison on char 1", frame))
end

function get_tile_hash(startTile, count)
  local h = ""
  for t = startTile, startTile + count - 1 do
    local addr = 0x1000 + t * 16
    for i = 0, 15 do h = h .. string.format("%02x", ppu.readbyte(addr + i)) end
  end
  return h
end

function capture_ppu(label)
  captures = captures + 1
  log(string.format("=== CAPTURE #%d: %s (frame %d) ===", captures, label, frame))

  -- Sprite palettes
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("  sprPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end

  -- Status tiles region $40-$60
  for tid = 0x40, 0x60 do
    local addr = 0x1000 + tid * 16
    local bytes = {}
    local nz = 0
    for i = 0, 15 do
      local b = ppu.readbyte(addr + i)
      table.insert(bytes, string.format("0x%02x", b))
      if b ~= 0 then nz = nz + 1 end
    end
    log(string.format("  $%02X: new Uint8Array([%s])  // %d nz", tid, table.concat(bytes, ","), nz))
  end

  -- OAM for reference
  log("  OAM visible:")
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y < 0xEF then
      local tile = memory.readbyte(base + 1)
      local attr = memory.readbyte(base + 2)
      local x = memory.readbyte(base + 3)
      log(string.format("    [%02d] Y=%3d tile=$%02X attr=$%02X X=%3d", i, y, tile, attr, x))
    end
  end
end

-- ═══════════════════════════════════════════════════════════════════
-- State machine — from dump-battle-palettes.lua
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
      battle_start = frame
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
      settle_timer = 0
      battle_frames = 0
      log(string.format("[%d] BATTLE START", frame))
      emu.message("Battle started!")
    end
    last_mode = mode
    return
  end

  -- ── SETTLE — wait for battle to render ─────────────────────────
  if state == "battle_settle" then
    keep_monsters_alive()
    settle_timer = settle_timer + 1
    if settle_timer >= SETTLE_FRAMES then
      force_poison()
      capture_ppu("BASELINE before turn")
      prev_tile49 = get_tile_hash(0x49, 4)
      state = "fight_select"
      turn_timer = 0
      log(string.format("[%d] Selecting Fight...", frame))
      emu.message("Selecting Fight...")
    end
    return
  end

  -- ── FIGHT SELECT — press A to pick Fight, then A to confirm target
  if state == "fight_select" then
    keep_monsters_alive()
    turn_timer = turn_timer + 1

    -- Frame 1-5: press A to select Fight from menu
    if turn_timer <= 5 then
      if turn_timer % 2 == 1 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
      return
    end

    -- Frame 10-15: press A to confirm target
    if turn_timer >= 10 and turn_timer <= 15 then
      if turn_timer % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
      return
    end

    -- Frame 20+: wait and watch for CHR bank change at tiles $49-$4C
    if turn_timer >= 20 then
      local cur = get_tile_hash(0x49, 4)
      if cur ~= prev_tile49 then
        capture_ppu("CHR CHANGED at tiles $49-$4C")
        prev_tile49 = cur
      end

      -- Also capture every 30 frames for good measure
      if turn_timer % 30 == 0 then
        capture_ppu(string.format("periodic (turn frame %d)", turn_timer))
      end
    end

    -- After 600 frames we should have everything
    if turn_timer >= 600 then
      finish()
    end
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Poison Sprite Capture")
log("Uses battle entry from dump-battle-palettes.lua")
log("Forces poison, executes Fight, watches for CHR bank swap at $49-$4C")
log("")

-- Load save state slot 0
local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0 — fast-forwarding to battle]")
  emu.message("Save state loaded!")
else
  log("[No save state slot 0 — running from title screen]")
  emu.message("No save state — running from title")
end
