-- Capture poison status animation tiles from PPU.
-- Uses EXACT state machine from dump-battle-palettes.lua.
-- Forces poison + status display flag in battle, captures PPU.

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
local settle_timer   = 0
local SETTLE_FRAMES  = 60
local capture_count  = 0

function log(m) if not done then f:write(m.."\n"); f:flush() end end
function finish()
  if done then return end
  done = true
  f:close()
  emu.message("Done! " .. capture_count .. " captures")
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

function force_poison_and_display()
  -- Field status
  for c = 0, 3 do
    local addr = 0x6102 + c * 0x40
    memory.writebyte(addr, bit.bor(memory.readbyte(addr), 0x02))
  end
  -- Battle status
  memory.writebyte(0x7637, bit.bor(memory.readbyte(0x7637), 0x02))
  -- Display flags
  memory.writebyte(0x78BC, bit.bor(memory.readbyte(0x78BC), 0x40))
  memory.writebyte(0x78C4, 0x05)
  memory.writebyte(0x7DB7, 0x05)
  -- Force status sprite display ON
  memory.writebyte(0x00AC, 0x01)
end

function capture(label)
  capture_count = capture_count + 1
  log(string.format("=== %s (frame %d, capture #%d) ===", label, frame, capture_count))
  log("TILES $40-$60:")
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
  log("PALETTES:")
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("  sprPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end
  log("OAM:")
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y < 0xEF then
      log(string.format("  [%02d] Y=%3d tile=$%02X attr=$%02X X=%3d",
        i, y, memory.readbyte(base+1), memory.readbyte(base+2), memory.readbyte(base+3)))
    end
  end
  log(string.format("STATUS: $6102=$%02X $78BC=$%02X $78C4=$%02X $7DB7=$%02X $AC=$%02X",
    memory.readbyte(0x6102), memory.readbyte(0x78BC), memory.readbyte(0x78C4),
    memory.readbyte(0x7DB7), memory.readbyte(0x00AC)))
end

-- ═══════════════════════════════════════════════════════════════════
-- EXACT state machine from dump-battle-palettes.lua
-- ═══════════════════════════════════════════════════════════════════
function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if mode == 0xA8 then
      if last_mode ~= 0xA8 then
        name_timer = 0
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
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      battle_start = frame
    end
    last_mode = mode
    return
  end

  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode == 0x20 then
      state = "battle_settle"
      settle_timer = 0
      battle_frames = 0
      log(string.format("[%d] BATTLE START", frame))
    end
    last_mode = mode
    return
  end

  if state == "battle_settle" then
    keep_monsters_alive()
    -- Force poison + status display every frame
    force_poison_and_display()
    settle_timer = settle_timer + 1
    -- Capture at multiple points to catch both animation frames
    if settle_timer == 30 then capture("30 frames in") end
    if settle_timer == 38 then capture("38 frames in") end
    if settle_timer == 60 then capture("60 frames in") end
    if settle_timer == 68 then capture("68 frames in") end
    if settle_timer == 90 then capture("90 frames in") end
    if settle_timer == 98 then capture("98 frames in") end
    if settle_timer == 120 then capture("120 frames in") end
    if settle_timer == 128 then capture("128 frames in") end
    if settle_timer >= 130 then finish() end
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Poison Sprite Capture")

local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0]")
else
  log("[No save state — from title]")
end
