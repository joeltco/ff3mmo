-- FCEUX Lua: trace DEFEND action — every frame for OAM[00-11]
-- Logs EVERY frame during capture (not just changes) to catch diagonal movement.
-- Press P to start/stop capture.

local outpath = "/home/joeltco/projects/ff3mmo/tools/defend-trace.txt"
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
      emu.message("CAPTURE ON")
    else
      capturing = false
      log(string.format("\n=== Capture stopped frame %d (+%d frames) ===", fc, fc - capture_start))
      emu.message("CAPTURE OFF — saved")
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

  -- Log OAM[00-11] EVERY frame (these are the effect/shadow sprites)
  local has_visible = false
  for i = 0, 11 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y < 0xEF then has_visible = true end
  end

  -- Only log frames where at least one of OAM[00-11] is visible
  if not has_visible then return end

  local actor = memory.readbyte(0x95)
  local phase = memory.readbyte(0x7E91)
  local cmd = memory.readbyte(0x2E)
  local anim = memory.readbyte(0xB6)

  log(string.format("f%05d (+%03d) actor=%d phase=$%02X cmd=$%02X anim=$%02X",
    fc, fc - capture_start, actor, phase, cmd, anim))
  log(dump_spr_pal())

  -- Dump character flags
  local fs = "FLAGS:"
  for i = 0, 3 do
    fs = fs .. string.format(" [%d]=$%02X", i, memory.readbyte(0x7D83 + i))
  end
  log(fs)

  -- OAM[00-11] every frame
  for i = 0, 11 do
    local s = fmt_oam(i)
    if s then log(s) end
  end
end)

-- Keep the exec traces
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

log("=== Defend Trace v2 — every frame OAM[00-11] ===")
log("Press P to start/stop. Logs every frame with visible effect sprites.")
log("")
emu.message("Defend tracer v2 — press P to capture!")
