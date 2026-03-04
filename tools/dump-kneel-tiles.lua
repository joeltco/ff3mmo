-- FCEUX Lua: dump PPU tile data for low HP (kneeling) pose
-- During battle, sets character 1 HP to 1 to trigger "near fatal" status
-- Waits for sprite frame $7D83 to change to $03 (kneel), then dumps PPU tiles + OAM
--
-- Usage: Load in FCEUX during a battle, press P. Script sets HP=1 and waits
-- for the kneel pose to appear, then dumps everything to kneel-tiles.txt.

local outpath = "/home/joeltco/projects/ff3mmo/tools/kneel-tiles.txt"
local dumped = false
local waiting = false
local p_was_down = false
local wait_frames = 0

emu.registerbefore(function()
  if dumped then return end

  local keys = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down and not waiting then
    waiting = true
    wait_frames = 0
    emu.message("Setting HP=1, waiting for kneel pose ($7D83=$03)...")
  end
  p_was_down = p_down

  if not waiting then return end

  wait_frames = wait_frames + 1

  -- Keep character 1 HP at 1 every frame
  -- Char 1 battle struct at $7575, HP at offset +$03 = $7578 (16-bit LE)
  memory.writebyte(0x7578, 1)  -- HP low byte = 1
  memory.writebyte(0x7579, 0)  -- HP high byte = 0

  if wait_frames > 600 then
    waiting = false
    emu.message("Timeout — make sure you're in a battle, press P again")
    return
  end

  -- Wait at least 10 frames for animation system to update
  if wait_frames < 10 then return end

  -- Check sprite frame at $7D83 (char 1 animation frame)
  -- $03 = kneel pose for normal characters
  local sprite_frame = AND(memory.readbyte(0x7D83), 0x7F)
  if sprite_frame ~= 0x03 then
    if wait_frames % 60 == 0 then
      emu.message(string.format("Waiting... $7D83=$%02X (need $03) f=%d",
        memory.readbyte(0x7D83), wait_frames))
    end
    return
  end

  -- Found kneeling pose! Dump everything
  dumped = true
  local f = io.open(outpath, "w")

  f:write("=== KNEEL POSE DUMP ===\n")
  f:write(string.format("Captured at wait_frames=%d\n", wait_frames))
  f:write(string.format("$7D83=$%02X (frame %d)\n\n", memory.readbyte(0x7D83), sprite_frame))

  -- Character battle HP for reference
  local hp_lo = memory.readbyte(0x7578)
  local hp_hi = memory.readbyte(0x7579)
  local maxhp_lo = memory.readbyte(0x757A)
  local maxhp_hi = memory.readbyte(0x757B)
  f:write(string.format("HP: %d / %d\n\n", hp_lo + hp_hi * 256, maxhp_lo + maxhp_hi * 256))

  local PT_BASE = 0x1000

  -- Sprite palettes ($3F10-$3F1F)
  f:write("=== Sprite Palettes ===\n")
  for p = 0, 3 do
    local s = string.format("pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    f:write(s .. "\n")
  end
  f:write("\n")

  -- Full OAM dump (visible sprites only)
  f:write("=== OAM (visible) ===\n")
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y > 0 and y < 240 then
      local tile = memory.readbyte(base + 1)
      local attr = memory.readbyte(base + 2)
      local x = memory.readbyte(base + 3)
      f:write(string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s\n",
        i, x, y, tile, attr,
        AND(attr, 0x03),
        AND(attr, 0x40) ~= 0 and "H" or "-",
        AND(attr, 0x80) ~= 0 and "V" or "-"))
    end
  end
  f:write("\n")

  -- Dump tiles $00-$5F from sprite pattern table (PPU $1000)
  -- This covers all possible character sprite tiles
  f:write("=== PPU Tiles $00-$5F (sprite pattern table $1000) ===\n\n")
  for tid = 0x00, 0x5F do
    f:write(string.format("=== Tile $%02X ===\n", tid))
    local base = PT_BASE + tid * 16
    local raw = ""
    for b = 0, 15 do
      raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
    end
    f:write("RAW: " .. raw .. "\n")
    -- Visual decode
    for row = 0, 7 do
      local lo = ppu.readbyte(base + row)
      local hi = ppu.readbyte(base + row + 8)
      local line = ""
      for bit = 7, 0, -1 do
        local px = AND(SHIFT(lo, bit), 1) + AND(SHIFT(hi, bit), 1) * 2
        if px == 0 then line = line .. "."
        elseif px == 1 then line = line .. "1"
        elseif px == 2 then line = line .. "2"
        else line = line .. "3"
        end
      end
      f:write(line .. "\n")
    end
    f:write("\n")
  end

  f:close()
  emu.message("KNEEL POSE CAPTURED to kneel-tiles.txt!")
end)

emu.message("Kneel dumper loaded — enter a battle, then press P!")
