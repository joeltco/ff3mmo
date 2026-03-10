-- FCEUX Lua: trace POTION use in battle — every frame for OAM[00-15]
-- Captures sprite positions, tile IDs, palettes, and game state during heal animation.
-- Press P to start/stop capture.
-- Usage: Get into battle, open Item menu, select Potion, press P, then use it.

local outpath = "/home/joeltco/projects/ff3mmo/tools/potion-trace.txt"
local f = io.open(outpath, "w")
local fc = 0
local capturing = false
local capture_start = 0
local MAX_FRAMES = 600
local p_was_down = false

function log(m) f:write(m.."\n"); f:flush() end

function fmt_oam(i)
  local base = 0x0200 + i * 4
  local y = memory.readbyte(base)
  local tile = memory.readbyte(base + 1)
  local attr = memory.readbyte(base + 2)
  local x = memory.readbyte(base + 3)
  if y >= 0xEF then return nil end
  return string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s",
    i, x, y, tile, attr,
    AND(attr, 0x03),
    AND(attr, 0x40) ~= 0 and "H" or "-",
    AND(attr, 0x80) ~= 0 and "V" or "-")
end

function dump_spr_pal()
  local s = "SPR_PAL:"
  for i = 0, 15 do
    s = s .. string.format(" %02X", ppu.readbyte(0x3F10 + i))
  end
  return s
end

function dump_bg_pal()
  local s = "BG_PAL:"
  for i = 0, 15 do
    s = s .. string.format(" %02X", ppu.readbyte(0x3F00 + i))
  end
  return s
end

-- Frame handler
emu.registerbefore(function()
  fc = fc + 1

  local keys = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down then
    if not capturing then
      capturing = true
      capture_start = fc
      log(string.format("=== Capture started frame %d ===", fc))
      log(dump_spr_pal())
      log(dump_bg_pal())
      emu.message("CAPTURE ON")
    else
      capturing = false
      log(string.format("\n=== Capture stopped frame %d (+%d frames) ===", fc, fc - capture_start))
      emu.message("CAPTURE OFF — saved to potion-trace.txt")
    end
  end
  p_was_down = p_down

  if not capturing then return end
  if fc - capture_start > MAX_FRAMES then
    capturing = false
    log("\n=== Capture ended (max frames) ===")
    emu.message("Capture done (max frames)")
    return
  end

  -- Check if any OAM[00-15] is visible (effect/shadow sprites)
  local has_visible = false
  for i = 0, 15 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y < 0xEF then has_visible = true end
  end

  -- Log every frame during capture (even empty ones, to see timing gaps)
  local actor = memory.readbyte(0x95)
  local phase = memory.readbyte(0x7E91)
  local cmd = memory.readbyte(0x2E)
  local anim = memory.readbyte(0xB6)

  log(string.format("f%05d (+%03d) actor=%d phase=$%02X cmd=$%02X anim=$%02X visible=%s",
    fc, fc - capture_start, actor, phase, cmd, anim, has_visible and "Y" or "N"))

  -- Sprite palettes on first frame and whenever they change
  if fc == capture_start + 1 or (fc - capture_start) % 30 == 0 then
    log(dump_spr_pal())
  end

  -- Character flags
  local fs = "FLAGS:"
  for i = 0, 3 do
    fs = fs .. string.format(" [%d]=$%02X", i, memory.readbyte(0x7D83 + i))
  end
  log(fs)

  -- OAM[00-15] — wider range to catch all heal effect sprites
  if has_visible then
    for i = 0, 15 do
      local s = fmt_oam(i)
      if s then log(s) end
    end
  end
end)

-- Execution traces for relevant battle routines
memory.registerexecute(0xB38E, function()
  if capturing then
    log(string.format("f%05d  EXEC $B38E (step forward) actor=%d", fc, memory.readbyte(0x95)))
  end
end)

memory.registerexecute(0xB68D, function()
  if capturing then
    log(string.format("f%05d  EXEC $B68D (hit animation) actor=%d", fc, memory.readbyte(0x95)))
  end
end)

log("=== Potion Trace — OAM[00-15] every frame ===")
log("Press P to start/stop. Use a Potion in battle during capture.")
log("")
emu.message("Potion tracer — press P to capture!")
