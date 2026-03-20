-- FCEUX Lua: Dump composited Sight screen logo pixels (BG + sprites combined)
-- Run in FCEUX with FF3J ROM + end-game save state. Cast Sight spell, then run this.
-- Captures the actual rendered frame, not raw tile data.

local OUT = "sight_logo_composite.txt"

-- Logo position in the NES frame: nametable row 3 col 6, 20 tiles wide, 2 tiles tall
-- Pixel coords: x=48..207, y=24..39 (160x16 pixels)
local LOGO_X = 48
local LOGO_Y = 24
local LOGO_W = 160
local LOGO_H = 16

-- Detect Sight screen by checking nametable
local function isSightScreen()
  local val = ppu.readbyte(0x2066)
  return val == 0x18
end

local function dumpComposite()
  local f = io.open(OUT, "w")
  f:write("-- Sight screen logo composite pixel dump (BG+sprites)\n")
  f:write("-- Format: row of 160 hex color values (NES palette indices from gui.getpixel)\n")
  f:write("-- Position: x=48..207, y=24..39 (160x16)\n")
  f:write("-- Each value is an RGB triplet: R,G,B\n\n")

  for y = 0, LOGO_H - 1 do
    f:write(string.format("ROW_%02d: [", y))
    local pixels = {}
    for x = 0, LOGO_W - 1 do
      local r, g, b = emu.getscreenpixel(LOGO_X + x, LOGO_Y + y, false)
      table.insert(pixels, string.format("%d,%d,%d", r, g, b))
    end
    f:write(table.concat(pixels, "|"))
    f:write("]\n")
  end

  -- Also dump the BG palettes for reference
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

  -- And sprite palettes
  f:write("\n-- Sprite Palettes:\n")
  for p = 0, 3 do
    f:write(string.format("SPR_PAL%d: [", p))
    local cols = {}
    for i = 0, 3 do
      table.insert(cols, string.format("0x%02X", ppu.readbyte(0x3F10 + p*4 + i)))
    end
    f:write(table.concat(cols, ","))
    f:write("]\n")
  end

  f:close()
  emu.message("Dumped composite to " .. OUT)
  print("Dumped sight logo composite pixels to " .. OUT)
end

-- Poll until Sight screen appears
local found = false
while not found do
  emu.frameadvance()
  if isSightScreen() then
    -- Wait extra frames for sprites to settle
    for i = 1, 30 do emu.frameadvance() end
    dumpComposite()
    found = true
  end
end
