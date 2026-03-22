-- FCEUX Lua: dump EVERY FRAME of the attack animation
-- Watches arm sprites at y=99-115 (OAM spr region).
-- When any sprite in that y-band changes tile ID from idle ($1D-$22) to
-- anything else, starts dumping every 2 frames for 60 frames total.
-- Output: tools/attack-frames-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/attack-frames-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local capturing = false
local capture_start = 0
local CAPTURE_FRAMES = 60   -- dump for this many frames after trigger
local CAPTURE_EVERY = 1     -- dump every N frames during capture
local dumps_done = 0
local MAX_DUMPS = 30

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  log("=== DONE ===")
  f:close()
  emu.message("Done! Check attack-frames-dump.txt")
end

function dump_tiles(label)
  if dumps_done >= MAX_DUMPS then finish(); return end
  dumps_done = dumps_done + 1
  log("=== " .. label .. " ===")
  -- PPU $1000 sprite tiles $00-$4F
  for tile = 0x00, 0x4F do
    local addr = 0x1000 + tile * 16
    local hex = ""
    for b = 0, 15 do
      hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
    end
    log(string.format("  $%02X: %s", tile, hex))
  end
  -- OAM: all visible sprites
  log("-- OAM --")
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y > 0 and y < 240 then
      local x = memory.readbyte(b + 3)
      local t = memory.readbyte(b + 1)
      local a = memory.readbyte(b + 2)
      log(string.format("  spr%02d: x=%3d y=%3d t=$%02X a=$%02X", i, x, y, t, a))
    end
  end
end

-- Get the tile IDs used by sprites in the arm region (y=90-125)
function get_arm_tile_ids()
  local ids = {}
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y >= 90 and y <= 125 then
      local t = memory.readbyte(b + 1)
      table.insert(ids, t)
    end
  end
  return ids
end

-- Is the arm in "idle" state? (all tiles in $1D-$22 range or similar idle range)
function arm_is_idle(ids)
  for _, t in ipairs(ids) do
    if t < 0x1D or t > 0x22 then return false end
  end
  return true
end

local prev_arm_ids = {}

function on_frame()
  if done then return end
  frame = frame + 1

  local mode = memory.readbyte(0x0040)
  -- Only care about battle mode
  if mode ~= 0x20 then return end

  local arm_ids = get_arm_tile_ids()

  if not capturing then
    -- Detect when arm tiles change from idle state
    local was_idle = arm_is_idle(prev_arm_ids)
    local now_idle = arm_is_idle(arm_ids)
    if was_idle and not now_idle and #arm_ids > 0 then
      capturing = true
      capture_start = frame
      log(string.format("[%d] ATTACK DETECTED arm tiles: %s", frame,
        table.concat((function() local s={} for _,v in ipairs(arm_ids) do table.insert(s,string.format("$%02X",v)) end return s end)(), ",")))
      dump_tiles("f=0 (attack triggered)")
    end
  else
    local elapsed = frame - capture_start
    if elapsed % CAPTURE_EVERY == 0 then
      dump_tiles("f=" .. elapsed)
    end
    if elapsed >= CAPTURE_FRAMES then
      log(string.format("[%d] Capture complete (%d dumps)", frame, dumps_done))
      finish()
    end
  end

  prev_arm_ids = arm_ids
end

emu.registerbefore(on_frame)
log("Attack frame dump — waiting for battle mode $20 and arm sprite change")

-- Load save state slot 1 (should be in or near battle)
local ok, err = pcall(function() emu.loadstate(1) end)
if ok then
  log("[Loaded save state slot 1]")
  emu.message("Save state loaded — watching for attack...")
else
  emu.message("No save state — run from title or save slot 1 in battle")
end
