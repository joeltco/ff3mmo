-- FCEUX Lua: capture sweat/near-fatal animation during battle IDLE phase
-- Waits for kneel pose + idle OAM (no attack/walk), then captures 240 frames
-- Also dumps OAM slots 0-39 (unused by body sprites 40-63) to catch extra sprites
--
-- Usage: Get into battle, load script, press P. Wait at menu — DON'T attack.

local outpath = "/home/joeltco/projects/ff3mmo/tools/sweat-v2.txt"
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
    emu.message("Forcing near-fatal... DON'T ATTACK, stay at menu!")
  end
  p_was_down = p_down

  if not waiting and not capturing then return end

  -- Force HP=1 and all near-fatal status bits every frame
  memory.writebyte(0x7578, 1)
  memory.writebyte(0x7579, 0)
  local st2 = memory.readbyte(0x7D9C)
  memory.writebyte(0x7D9C, OR(st2, 0x04))
  local st2b = memory.readbyte(0x78BC)
  memory.writebyte(0x78BC, OR(st2b, 0x04))
  local nf = memory.readbyte(0x7CEC)
  memory.writebyte(0x7CEC, OR(nf, 0x01))

  if waiting then
    wait_frames = wait_frames + 1
    if wait_frames > 1200 then
      waiting = false
      emu.message("Timeout")
      return
    end

    -- Wait for kneel frame AND character at resting position (x=208)
    local sprite_frame = AND(memory.readbyte(0x7D83), 0x7F)
    local char1_x = memory.readbyte(0x0203) -- OAM[00] x
    local char1_t = memory.readbyte(0x0201) -- OAM[00] tile

    if wait_frames % 60 == 0 then
      emu.message(string.format("f=%d $7D83=$%02X oam0_t=$%02X oam0_x=%d",
        wait_frames, memory.readbyte(0x7D83), char1_t, char1_x))
    end

    -- Kneel must be active AND no attack animation (char at rest position)
    if sprite_frame ~= 0x03 then return end
    if wait_frames < 60 then return end -- give animation system time

    -- Start capturing
    waiting = false
    capturing = true
    capture_frames = 0
    f = io.open(outpath, "w")
    f:write("=== SWEAT ANIMATION CAPTURE v2 ===\n\n")

    -- Palettes
    f:write("=== Sprite Palettes ===\n")
    for p = 0, 3 do
      local s = string.format("pal%d:", p)
      for i = 0, 3 do
        s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
      end
      f:write(s .. "\n")
    end
    f:write("\n")

    -- Dump ALL tiles $00-$5F
    f:write("=== PPU Tiles $00-$5F ===\n")
    for tid = 0x00, 0x5F do
      local base = 0x1000 + tid * 16
      local raw = ""
      for b = 0, 15 do
        raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
      end
      f:write(string.format("$%02X: %s\n", tid, raw))
    end
    f:write("\n")

    emu.message("Capturing 240 frames of ALL OAM...")
    return
  end

  if capturing then
    capture_frames = capture_frames + 1

    -- Dump ALL 64 OAM entries every 2 frames (catch fast animations)
    if capture_frames % 2 == 0 then
      f:write(string.format("--- Frame %d ($B7=$%02X $7D83=$%02X) ---\n",
        capture_frames, memory.readbyte(0xB7), memory.readbyte(0x7D83)))
      for i = 0, 63 do
        local base = 0x0200 + i * 4
        local y = memory.readbyte(base)
        local tile = memory.readbyte(base + 1)
        local attr = memory.readbyte(base + 2)
        local x = memory.readbyte(base + 3)
        -- Show ALL entries, mark hidden ones
        local vis = (y > 0 and y < 240) and "" or " [hidden]"
        f:write(string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s%s\n",
          i, x, y, tile, attr,
          AND(attr, 0x03),
          AND(attr, 0x40) ~= 0 and "H" or "-",
          AND(attr, 0x80) ~= 0 and "V" or "-",
          vis))
      end
    end

    if capture_frames >= 240 then
      capturing = false
      dumped = true
      f:write("\n=== CAPTURE COMPLETE ===\n")
      f:close()
      emu.message("Done! 240 frames → sweat-v2.txt")
    end
  end
end)

emu.message("Sweat v2 — enter battle, press P, then DON'T ATTACK!")
