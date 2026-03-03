-- FCEUX Lua: trace ALL battle SFX writes to $7F49
-- Uses memory.registerwrite to catch the EXACT moment SFX is requested,
-- before the sound engine consumes/clears it.

local f = io.open("/home/joeltco/projects/ff3mmo/tools/battle-sfx-log.txt", "w")
local fc = 0

function log(m) f:write(m.."\n"); f:flush() end

function on_frame()
  fc = fc + 1
end

function on_sfx_write(addr, size, val)
  -- val is the byte being written to $7F49
  if val == 0 then return end  -- skip clears

  local phase = memory.readbyte(0x7E91)
  local actor = memory.readbyte(0x95)
  local hand = memory.readbyte(0xCD)
  local wtype = memory.readbyte(0x32)

  local sfx_id = AND(val, 0x7F)
  local is_sfx = AND(val, 0x80) ~= 0
  local label = is_sfx and "SFX" or "SONG"
  local nsf_track = is_sfx and (sfx_id + 0x41) or sfx_id

  log(string.format("f%05d  $7F49=$%02X  %s $%02X  (NSF=$%02X)  phase=$%02X actor=%d hand=%d wtype=%d",
    fc, val, label, sfx_id, nsf_track, phase, actor, hand, wtype))
end

emu.registerbefore(on_frame)
memory.registerwrite(0x7F49, 1, on_sfx_write)

log("=== Battle SFX Trace v2 (write callback) ===")
log("Catches every write to $7F49 as it happens.")
log("Format: SFX = high bit set ($80|id), SONG = direct track id")
log("")
emu.message("SFX tracer v2 loaded — enter a battle!")
