-- FCEUX Lua: trace ALL battle SFX writes to $7F49 + deferred SFX ($CA)
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
  local ca = memory.readbyte(0xCA)
  local c9 = memory.readbyte(0xC9)
  local spell = memory.readbyte(0x7E88)
  local animid = memory.readbyte(0x7E9D)

  local sfx_id = AND(val, 0x7F)
  local is_sfx = AND(val, 0x80) ~= 0
  local label = is_sfx and "SFX" or "SONG"
  local nsf_track = is_sfx and (sfx_id + 0x41) or sfx_id

  log(string.format("f%05d  $7F49=$%02X  %s $%02X  (NSF=$%02X)  phase=$%02X actor=%d hand=%d wtype=%d  CA=$%02X C9=%d spell=$%02X anim=$%02X",
    fc, val, label, sfx_id, nsf_track, phase, actor, hand, wtype, ca, c9, spell, animid))
end

-- Also trace writes to $CA (deferred SFX ID)
function on_ca_write(addr, size, val)
  local phase = memory.readbyte(0x7E91)
  local actor = memory.readbyte(0x95)
  local spell = memory.readbyte(0x7E88)
  local animid = memory.readbyte(0x7E9D)
  log(string.format("f%05d  $CA=$%02X  (deferred SFX $%02X, NSF=$%02X)  phase=$%02X actor=%d spell=$%02X anim=$%02X",
    fc, val, val, val + 0x41, phase, actor, spell, animid))
end

emu.registerbefore(on_frame)
memory.registerwrite(0x7F49, 1, on_sfx_write)
memory.registerwrite(0x00CA, 1, on_ca_write)

log("=== Battle SFX Trace v3 (with deferred $CA + spell/anim IDs) ===")
log("Catches every write to $7F49 AND $CA as it happens.")
log("")
emu.message("SFX tracer v3 loaded — enter a battle!")
