-- trace-battle-item.lua
-- Comprehensive battle item animation tracer.
-- Captures: all OAM sprites, PPU tile bytes for new tiles, BG nametable diffs,
--           SFX writes ($7F49/$CA), sprite+BG palettes, all battle state vars.
--
-- USAGE:
--   1. Load ROM in FCEUX, get into a battle
--   2. Load this script
--   3. Open Item menu, select the item, pick a target
--   4. Press P just before you confirm — capture runs until you press P again (or 600 frames)
--   5. Output: tools/battle-item-trace.txt

local OUT   = "/home/joeltco/projects/ff3mmo/tools/battle-item-trace.txt"
local MAX_FRAMES = 600

local f           = io.open(OUT, "w")
local fc          = 0
local capturing   = false
local cap_start   = 0
local p_was_down  = false

-- tile IDs we've already dumped raw bytes for
local dumped_tiles = {}
-- nametable snapshot from previous frame (rows 0-29, cols 0-31)
local prev_nt     = {}

function log(m) f:write(m.."\n"); f:flush() end

-- ── helpers ──────────────────────────────────────────────────────────────────

function dump_spr_pal()
  local s = "SPR_PAL:"
  for i = 0, 15 do s = s .. string.format(" %02X", ppu.readbyte(0x3F10 + i)) end
  return s
end

function dump_bg_pal()
  local s = "BG_PAL:"
  for i = 0, 15 do s = s .. string.format(" %02X", ppu.readbyte(0x3F00 + i)) end
  return s
end

-- dump raw PPU $1000 tile bytes (16 bytes, 2bpp) in JS-ready hex
function dump_ppu_tile(tid)
  if dumped_tiles[tid] then return end
  dumped_tiles[tid] = true
  local base = 0x1000 + tid * 16
  local hex = ""
  for i = 0, 15 do hex = hex .. string.format("%02X", ppu.readbyte(base + i)) end
  -- sprite palette index from attr bits (written by caller)
  log(string.format("  TILE $%02X PPU$1000: %s", tid, hex))
end

-- format one OAM entry (4 bytes at $0200 + slot*4)
function fmt_oam(slot)
  local base = 0x0200 + slot * 4
  local y    = memory.readbyte(base)
  local tile = memory.readbyte(base + 1)
  local attr = memory.readbyte(base + 2)
  local x    = memory.readbyte(base + 3)
  if y >= 0xEF then return nil, nil end   -- off-screen / unused
  local pal  = AND(attr, 0x03)
  local hflip = AND(attr, 0x40) ~= 0 and "H" or "-"
  local vflip = AND(attr, 0x80) ~= 0 and "V" or "-"
  local pri   = AND(attr, 0x20) ~= 0 and "B" or "F"  -- behind/front BG
  return string.format("  OAM[%02d] x=%3d y=%3d t=$%02X attr=$%02X pal%d %s%s%s",
    slot, x, y+1, tile, attr, pal, hflip, vflip, pri),
    tile
end

-- snapshot current nametable (rows 0-29, all 32 cols) into a table
function snapshot_nt()
  local snap = {}
  for row = 0, 29 do
    snap[row] = {}
    for col = 0, 31 do
      snap[row][col] = ppu.readbyte(0x2000 + row * 32 + col)
    end
  end
  return snap
end

-- log any cells that differ between prev_nt and current
function log_nt_diffs(cur)
  local diffs = {}
  for row = 0, 29 do
    for col = 0, 31 do
      local old = prev_nt[row] and prev_nt[row][col] or 0
      local new = cur[row][col]
      if old ~= new then
        diffs[#diffs+1] = string.format("    BG[r%02d c%02d] $%02X→$%02X", row, col, old, new)
      end
    end
  end
  if #diffs > 0 then
    log("  BG_DIFFS:")
    for _, d in ipairs(diffs) do log(d) end
  end
end

-- ── SFX / song writes ─────────────────────────────────────────────────────────

function on_sfx_write(addr, size, val)
  if val == 0 then return end
  local sfx_id    = AND(val, 0x7F)
  local is_sfx    = AND(val, 0x80) ~= 0
  local label     = is_sfx and "SFX" or "SONG"
  local nsf_track = is_sfx and (sfx_id + 0x41) or sfx_id
  local phase     = memory.readbyte(0x7E91)
  local spell     = memory.readbyte(0x7E88)
  local animid    = memory.readbyte(0x7E9D)
  local msg = string.format("f%05d  $7F49=$%02X  %s id=$%02X (NSF $%02X)  phase=$%02X spell=$%02X anim=$%02X",
    fc, val, label, sfx_id, nsf_track, phase, spell, animid)
  if capturing then log("  >>> " .. msg) end
  -- always print to FCEUX console so SFX is visible even outside capture
  print(msg)
end

function on_ca_write(addr, size, val)
  if val == 0 then return end
  local phase  = memory.readbyte(0x7E91)
  local spell  = memory.readbyte(0x7E88)
  local animid = memory.readbyte(0x7E9D)
  local msg = string.format("f%05d  $CA=$%02X (deferred SFX $%02X, NSF $%02X)  phase=$%02X spell=$%02X anim=$%02X",
    fc, val, val, val + 0x41, phase, spell, animid)
  if capturing then log("  >>> " .. msg) end
  print(msg)
end

memory.registerwrite(0x7F49, 1, on_sfx_write)
memory.registerwrite(0x00CA, 1, on_ca_write)

-- ── per-frame capture ─────────────────────────────────────────────────────────

emu.registerbefore(function()
  fc = fc + 1

  -- P key toggle
  local keys   = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down then
    if not capturing then
      capturing  = true
      cap_start  = fc
      dumped_tiles = {}
      prev_nt    = snapshot_nt()
      log(string.format("\n=== CAPTURE START  frame %d ===", fc))
      log(dump_spr_pal())
      log(dump_bg_pal())
      emu.message("CAPTURING — press P to stop")
    else
      capturing = false
      log(string.format("\n=== CAPTURE STOP  frame %d  (+%d frames) ===", fc, fc - cap_start))
      emu.message("Capture done → battle-item-trace.txt")
    end
  end
  p_was_down = p_down

  if not capturing then return end
  if fc - cap_start > MAX_FRAMES then
    capturing = false
    log(string.format("\n=== CAPTURE END (max %d frames) ===", MAX_FRAMES))
    emu.message("Capture done (max frames)")
    return
  end

  local rel    = fc - cap_start
  local phase  = memory.readbyte(0x7E91)
  local actor  = memory.readbyte(0x95)
  local cmd    = memory.readbyte(0x2E)
  local anim   = memory.readbyte(0xB6)
  local hand   = memory.readbyte(0xCD)
  local spell  = memory.readbyte(0x7E88)
  local animid = memory.readbyte(0x7E9D)
  local item   = memory.readbyte(0x7E8C)   -- current item ID in battle

  log(string.format("f%05d (+%03d)  phase=$%02X actor=%d cmd=$%02X anim=$%02X hand=%d spell=$%02X animid=$%02X item=$%02X",
    fc, rel, phase, actor, cmd, anim, hand, spell, animid, item))

  -- sprite palettes every 30 frames
  if rel % 30 == 0 then
    log(dump_spr_pal())
    log(dump_bg_pal())
  end

  -- all 64 OAM slots — log visible ones + dump new tile bytes from PPU $1000
  local any_oam = false
  for slot = 0, 63 do
    local line, tile = fmt_oam(slot)
    if line then
      log(line)
      if tile then dump_ppu_tile(tile) end
      any_oam = true
    end
  end
  if not any_oam then log("  (no visible OAM sprites)") end

  -- BG nametable diff
  local cur_nt = snapshot_nt()
  log_nt_diffs(cur_nt)
  prev_nt = cur_nt
end)

-- ── init ─────────────────────────────────────────────────────────────────────

log("=== battle-item-trace.lua ===")
log("Captures: OAM (all 64), PPU tile bytes, BG nametable diffs, SFX writes, battle state")
log("SFX writes are also logged OUTSIDE capture (check FCEUX console)")
log("")
log("HOW TO USE:")
log("  1. Get into a battle")
log("  2. Open Item menu, select item, pick target")
log("  3. Press P just before confirm")
log("  4. Confirm item use — watch the animation")
log("  5. Press P again to stop (or wait 600 frames)")
log("")
emu.message("battle-item-trace loaded — press P in battle during item use!")
