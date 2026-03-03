-- FCEUX Lua: dump PPU sprite palettes every 60 frames
-- Just start the game normally, walk around, and let this capture everything

local f = io.open("/home/joeltco/projects/ff3mmo/tools/map-sprite-pal-trace.txt", "w")
local frame_count = 0
local dump_count = 0

function log(msg)
  f:write(msg .. "\n")
  f:flush()
end

function on_frame()
  frame_count = frame_count + 1

  -- Dump every 60 frames (~1 sec)
  if frame_count % 60 == 0 then
    dump_count = dump_count + 1
    local mode = memory.readbyte(0x0040)
    log(string.format("=== DUMP %d f%d mode=$%02X ===", dump_count, frame_count, mode))

    -- PPU sprite palettes
    log("-- sprite palettes --")
    for p = 0, 3 do
      local s = string.format("  spr_pal%d:", p)
      for i = 0, 3 do
        s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
      end
      log(s)
    end

    -- PPU bg palettes
    log("-- bg palettes --")
    for p = 0, 3 do
      local s = string.format("  bg_pal%d:", p)
      for i = 0, 3 do
        s = s .. string.format(" $%02X", ppu.readbyte(0x3F00 + p * 4 + i))
      end
      log(s)
    end

    -- First 8 OAM sprites
    log("-- OAM 0-7 --")
    for i = 0, 7 do
      local base = 0x0200 + i * 4
      local y = memory.readbyte(base)
      local tile = memory.readbyte(base + 1)
      local attr = memory.readbyte(base + 2)
      local x = memory.readbyte(base + 3)
      if y > 0 and y < 240 then
        log(string.format("  spr%d: x=%3d y=%3d tile=$%02X attr=$%02X pal=%d",
          i, x, y, tile, attr, bit.band(attr, 3)))
      end
    end

    if dump_count >= 120 then
      log("=== FINISHED ===")
      f:close()
      return
    end
  end
end

emu.registerbefore(on_frame)
log("Map sprite palette trace - dumping every 60 frames")
log("Play normally - walk on overworld and in town to capture palettes")
