-- FCEUX Lua: press P to capture 5 seconds (300 frames) of sprite data
-- Dumps OAM + sprite palettes + relevant PPU tiles each frame
-- Output: tools/capture-attack.txt

local OUT = "/home/joeltco/projects/ff3mmo/tools/capture-attack.txt"
local DURATION = 600  -- 10 seconds at 60fps
local capturing = false
local frameCount = 0
local f = nil

function dump_frame()
  frameCount = frameCount + 1
  f:write("=== FRAME " .. frameCount .. " ===\n")

  -- Sprite palettes
  for p = 0, 3 do
    local s = "pal" .. p .. ":"
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    f:write(s .. "\n")
  end

  -- OAM — only visible sprites
  f:write("=== OAM (visible) ===\n")
  local tiles_seen = {}
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local t = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    if y > 0 and y < 240 then
      local pal = AND(attr, 0x03)
      local hflip = AND(attr, 0x40) ~= 0 and "H" or "-"
      local vflip = AND(attr, 0x80) ~= 0 and "V" or "-"
      f:write(string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s\n",
        i, x, y, t, attr, pal, hflip, vflip))
      tiles_seen[t] = true
    end
  end

  -- Dump PPU tile data for all tiles referenced in OAM
  f:write("=== PPU tiles ===\n")
  for t = 0, 255 do
    if tiles_seen[t] then
      local addr = 0x1000 + t * 16
      local raw = ""
      for b = 0, 15 do
        raw = raw .. string.format("%02X", ppu.readbyte(addr + b))
      end
      f:write(string.format("  $%02X: %s\n", t, raw))
    end
  end

  f:flush()

  if frameCount >= DURATION then
    capturing = false
    f:write("\n=== CAPTURE COMPLETE (" .. DURATION .. " frames) ===\n")
    f:close()
    emu.message("Capture done! " .. DURATION .. " frames saved.")
  end
end

function on_frame()
  if capturing then
    dump_frame()
    return
  end

  -- Check for P key
  local keys = input.get()
  if keys["P"] or keys["p"] then
    if not f then
      f = io.open(OUT, "w")
      capturing = true
      frameCount = 0
      emu.message("Capturing " .. DURATION .. " frames...")
    end
  end
end

emu.registerbefore(on_frame)
emu.message("Press P to capture 5 seconds of sprite data")
