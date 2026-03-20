-- FCEUX Lua: Dump clean Sight screen logo tiles from PPU
-- Run in FCEUX with FF3J ROM. Cast Sight spell in-game, then run this script.
-- It waits for the Sight screen nametable to appear, then dumps the tile data.

local OUT = "sight_logo_tiles.txt"

-- Sight screen logo nametable tile IDs (row 3 col 6 and row 4 col 6, 20 tiles each)
local NT_R1 = {0x18,0x19,0x1A,0x09,0x09,0x1D,0x1E,0x18,0x19,0x09,0x09,0x21,0x09,0x09,0x09,0x09,0x09,0x25,0x26,0x27}
local NT_R2 = {0x28,0x29,0x2A,0x2B,0x2C,0x2D,0x09,0x28,0x1F,0x20,0x2F,0x30,0x31,0x32,0x33,0x34,0x09,0x35,0x36,0x37}

-- Collect unique tile IDs we need
local need = {}
for _,t in ipairs(NT_R1) do if t ~= 0x09 then need[t] = true end end
for _,t in ipairs(NT_R2) do if t ~= 0x09 then need[t] = true end end

-- Read PPU nametable at $2066 to detect Sight screen
local function isSightScreen()
  -- Check if nametable byte at $2066 (row 3, col 6) matches first logo tile
  local val = ppu.readbyte(0x2066)
  return val == 0x18
end

local function dumpTiles()
  local f = io.open(OUT, "w")
  f:write("-- Sight screen logo tile dump from PPU\n")
  f:write("-- Format: tile_id: [16 hex bytes (lo plane 8 bytes, hi plane 8 bytes)]\n\n")

  -- Determine which pattern table the BG uses
  -- PPUCTRL ($2000) bit 4: 0=use $0000, 1=use $1000
  local ctrl = ppu.readbyte(0x2000)
  local bgBase = 0x0000
  -- Note: can't read PPUCTRL directly from Lua, try both bases
  -- Check which one has our tile data by reading tile $18 from both

  -- Try $0000 first (default BG pattern table)
  for tid,_ in pairs(need) do
    local addr = tid * 16  -- PPU $0000 + tid*16
    f:write(string.format("0x%02X: [", tid))
    local bytes = {}
    for i = 0, 15 do
      local b = ppu.readbyte(addr + i)
      table.insert(bytes, string.format("0x%02X", b))
    end
    f:write(table.concat(bytes, ","))
    f:write("]\n")
  end

  f:write("\n-- Also dumping from PPU $1000 (sprite pattern table) in case BG uses $1000:\n")
  for tid,_ in pairs(need) do
    local addr = 0x1000 + tid * 16
    f:write(string.format("SPR_0x%02X: [", tid))
    local bytes = {}
    for i = 0, 15 do
      local b = ppu.readbyte(addr + i)
      table.insert(bytes, string.format("0x%02X", b))
    end
    f:write(table.concat(bytes, ","))
    f:write("]\n")
  end

  -- Also dump BG palettes
  f:write("\n-- BG Palettes:\n")
  for p = 0, 3 do
    f:write(string.format("BG_PAL%d: [", p))
    local cols = {}
    for i = 0, 3 do
      table.insert(cols, string.format("0x%02X", ppu.readbyte(0x3F00 + p*4 + i)))
    end
    f:write(table.concat(cols, ","))
    f:write("]\n")
  end

  f:close()
  emu.message("Dumped to " .. OUT)
  print("Dumped sight logo tiles to " .. OUT)
end

-- Poll until Sight screen appears
local found = false
while not found do
  emu.frameadvance()
  if isSightScreen() then
    -- Wait a few more frames to ensure tiles are fully loaded
    for i = 1, 10 do emu.frameadvance() end
    dumpTiles()
    found = true
  end
end
