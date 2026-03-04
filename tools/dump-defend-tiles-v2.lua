-- FCEUX Lua: dump PPU tile data for defend pose + sparkle tiles
-- Press P to start. Waits until OAM[00] shows tile $43 (defend body),
-- then dumps tiles from $1000 pattern table.

local outpath = "/home/joeltco/projects/ff3mmo/tools/defend-tiles-v2.txt"
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
    emu.message("Waiting for defend animation (tile $43 in OAM)...")
  end
  p_was_down = p_down

  if not waiting then return end

  wait_frames = wait_frames + 1
  if wait_frames > 600 then
    waiting = false
    emu.message("Timeout — press P and select Defend again")
    return
  end

  -- Check if OAM[00] has tile $43 (defend body top-left)
  local oam0_tile = memory.readbyte(0x0201)
  if oam0_tile ~= 0x43 then return end

  -- Found it! Dump everything
  dumped = true
  local f = io.open(outpath, "w")

  local PT_BASE = 0x1000

  -- Sprite palettes
  f:write("=== Sprite Palettes ===\n")
  for p = 0, 3 do
    local s = string.format("pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    f:write(s .. "\n")
  end
  f:write("\n")

  -- OAM[00-09]
  f:write("=== OAM[00-09] ===\n")
  for i = 0, 9 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    f:write(string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s\n",
      i, x, y, tile, attr,
      AND(attr, 0x03),
      AND(attr, 0x40) ~= 0 and "H" or "-",
      AND(attr, 0x80) ~= 0 and "V" or "-"))
  end
  f:write("\n")

  -- Body tiles $43-$48, sparkle tiles $49-$4C
  local tiles = {0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
                 0x49, 0x4A, 0x4B, 0x4C}

  for _, tid in ipairs(tiles) do
    f:write(string.format("=== Tile $%02X ===\n", tid))
    local base = PT_BASE + tid * 16
    local raw = ""
    for b = 0, 15 do
      raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
    end
    f:write("RAW: " .. raw .. "\n")
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
  emu.message("DEFEND TILES CAPTURED!")
end)

emu.message("Defend dumper v2 — press P then select Defend!")
