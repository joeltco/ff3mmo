-- FCEUX Lua: dual-knife trace
-- Based on WORKING trace-knife4.lua trigger (tile $49 at x>=160)
-- Extended to log 200 frames instead of 1
-- Weapon hack: SRAM only, ONCE at startup (not every frame)

local f = io.open("/home/joeltco/projects/ff3mmo/tools/knife-dual-trace.txt", "w")
if not f then emu.message("ERROR: no file!"); return end

local fc = 0
local triggered = false
local startFrame = 0
local done = false

function log(m) f:write(m.."\n"); f:flush() end

-- Hack SRAM once: knife ($1E) in both hands, all 4 chars
for c = 0, 3 do
  local base = 0x6100 + c * 0x40
  memory.writebyte(base + 0x38, 0x1E)
  memory.writebyte(base + 0x39, 0x1E)
end
log("SRAM hacked: knife $1E both hands, all chars")

function dumpPPU(label)
  log("=== PPU DUMP: "..label.." ===")
  for t = 0x00, 0x5F do
    local addr = 0x1000 + t * 16
    local h = ""
    for b = 0, 15 do h = h..string.format("%02X", ppu.readbyte(addr + b)) end
    log("  $"..string.format("%02X", t)..": "..h)
  end
  for p = 0, 3 do
    local s = "  pal"..p..":"
    for i = 0, 3 do s = s..string.format(" $%02X", ppu.readbyte(0x3F10 + p*4 + i)) end
    log(s)
  end
end

function on_frame()
  fc = fc + 1
  if done then return end

  if not triggered then
    -- Same trigger as working trace-knife4.lua
    for i = 0, 63 do
      local base = 0x0200 + i * 4
      local y = memory.readbyte(base)
      local t = memory.readbyte(base + 1)
      local x = memory.readbyte(base + 3)
      if y > 0 and y < 240 and t == 0x49 and x >= 160 then
        triggered = true
        startFrame = fc
        log(string.format("=== TRIGGERED spr%02d x=%d y=%d frame=%d ===", i, x, y, fc))
        dumpPPU("trigger")
        break
      end
    end
  end

  if triggered then
    local dt = fc - startFrame
    log(string.format("--- frame %d (atk+%d) ---", fc, dt))
    -- Zero-page battle counters
    local s = "  ZP $B0-BF:"
    for i = 0, 15 do s = s..string.format(" %02X", memory.readbyte(0xB0 + i)) end
    log(s)
    s = "  ZP $C0-CF:"
    for i = 0, 15 do s = s..string.format(" %02X", memory.readbyte(0xC0 + i)) end
    log(s)
    -- All active OAM
    for i = 0, 63 do
      local base = 0x0200 + i * 4
      local y = memory.readbyte(base)
      local t = memory.readbyte(base + 1)
      local attr = memory.readbyte(base + 2)
      local x = memory.readbyte(base + 3)
      if y > 0 and y < 240 then
        log(string.format("  spr%02d x=%3d y=%3d t=$%02X a=$%02X", i, x, y, t, attr))
      end
    end
    -- Re-dump PPU at frame 50 and 100
    if dt == 50 or dt == 100 then dumpPPU("re-dump atk+"..dt) end
    if dt >= 200 then
      dumpPPU("end")
      log("=== DONE ===")
      done = true
      f:close()
      emu.message("TRACE COMPLETE!")
    end
  end
end

emu.registerbefore(on_frame)
log("Trigger: tile $49 at x>=160")
log("Will log 200 frames after trigger")
log("")
emu.message("Dual knife trace ready — fight!")
