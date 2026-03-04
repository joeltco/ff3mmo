-- FCEUX Lua: capture sweat drop animation over multiple frames
-- Sets HP=1 AND forces near-fatal status bit, then dumps OAM every 4 frames
-- for 120 frames to catch the bouncing sweat sprite.
--
-- Usage: Load during a battle, press P.

local outpath = "/home/joeltco/projects/ff3mmo/tools/sweat-anim.txt"
local dumped = false
local waiting = false
local capturing = false
local p_was_down = false
local wait_frames = 0
local capture_frames = 0
local f = nil

emu.registerbefore(function()
  if dumped then return end

  local keys = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down and not waiting and not capturing then
    waiting = true
    wait_frames = 0
    emu.message("Setting HP=1 + near-fatal status, waiting for kneel...")
  end
  p_was_down = p_down

  if not waiting and not capturing then return end

  -- Keep character 1 HP at 1
  memory.writebyte(0x7578, 1)  -- HP low = 1
  memory.writebyte(0x7579, 0)  -- HP high = 0

  -- Force near-fatal status bit (status2 bit 2 at $7D9C for char 1)
  -- Also set it in the battle status buffer at $78BC
  local st2 = memory.readbyte(0x7D9C)
  memory.writebyte(0x7D9C, OR(st2, 0x04))  -- bit 2 = near fatal
  local st2b = memory.readbyte(0x78BC)
  memory.writebyte(0x78BC, OR(st2b, 0x04))
  -- Also set near-fatal mask at $7CEC (char 1 = bit 0)
  local nf = memory.readbyte(0x7CEC)
  memory.writebyte(0x7CEC, OR(nf, 0x01))

  if waiting then
    wait_frames = wait_frames + 1

    if wait_frames > 600 then
      waiting = false
      emu.message("Timeout — press P during battle")
      return
    end

    -- Wait for kneel frame ($7D83 = $03)
    if wait_frames < 10 then return end
    local sprite_frame = AND(memory.readbyte(0x7D83), 0x7F)
    if sprite_frame ~= 0x03 then
      if wait_frames % 60 == 0 then
        emu.message(string.format("Waiting... $7D83=$%02X f=%d", memory.readbyte(0x7D83), wait_frames))
      end
      return
    end

    -- Start capturing
    waiting = false
    capturing = true
    capture_frames = 0
    f = io.open(outpath, "w")
    f:write("=== SWEAT DROP ANIMATION CAPTURE ===\n\n")

    -- Dump palettes once
    f:write("=== Sprite Palettes ===\n")
    for p = 0, 3 do
      local s = string.format("pal%d:", p)
      for i = 0, 3 do
        s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
      end
      f:write(s .. "\n")
    end
    f:write("\n")

    -- Dump tile $55 (and neighbors $52-$58 for context)
    f:write("=== Tiles $52-$58 from PPU $1000 ===\n")
    for tid = 0x52, 0x58 do
      local base = 0x1000 + tid * 16
      local raw = ""
      for b = 0, 15 do
        raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
      end
      f:write(string.format("Tile $%02X RAW: %s\n", tid, raw))
    end
    f:write("\n")

    emu.message("Kneel detected — capturing 120 frames of OAM...")
    return
  end

  if capturing then
    capture_frames = capture_frames + 1

    -- Dump OAM every 4 frames
    if capture_frames % 4 == 0 then
      f:write(string.format("--- Frame %d ($B7=$%02X) ---\n", capture_frames, memory.readbyte(0xB7)))
      -- Dump ALL visible OAM entries
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
    end

    if capture_frames >= 120 then
      capturing = false
      dumped = true
      f:write("\n=== CAPTURE COMPLETE ===\n")
      f:close()
      emu.message("Sweat animation captured! 120 frames → sweat-anim.txt")
    end
  end
end)

emu.message("Sweat dumper — enter battle, press P!")
