-- FCEUX Lua: knife trace v4 — capture ALL portrait-area sprites + wider PPU range
-- Dumps ALL OAM sprites near portrait (x>=160), and PPU tiles $46-$55

local f = io.open("/home/joeltco/projects/ff3mmo/tools/knife-trace4.txt", "w")
local dumped = false
local fc = 0

function log(m) f:write(m.."\n"); f:flush() end

function dump_all()
  -- Check sprite size mode
  local ppuctrl = ppu.readbyte(0x2000)
  local sprSize = AND(ppuctrl, 0x20) ~= 0 and "8x16" or "8x8"
  log("PPUCTRL=$"..string.format("%02X", ppuctrl).."  sprite size: "..sprSize)

  -- Dump PPU tiles $46-$55 (covers $48 pair for 8x16 mode)
  log("=== PPU tiles $46-$55 ===")
  for t=0x46,0x55 do
    local addr = 0x1000 + t*16
    local h = ""
    for b=0,15 do h = h..string.format("%02X", ppu.readbyte(addr+b)) end
    log("  $"..string.format("%02X",t)..": "..h)
  end

  -- Dump sprite palettes
  for p=0,3 do
    local s = "  pal"..p..":"
    for i=0,3 do s = s..string.format(" $%02X", ppu.readbyte(0x3F10+p*4+i)) end
    log(s)
  end

  -- Dump ALL 64 OAM entries (not just filtered)
  log("=== ALL OAM sprites ===")
  for i=0,63 do
    local base = 0x0200 + i*4
    local y = memory.readbyte(base)
    local t = memory.readbyte(base+1)
    local attr = memory.readbyte(base+2)
    local x = memory.readbyte(base+3)
    if y > 0 and y < 240 then
      log(string.format("  spr%02d x=%3d y=%3d t=$%02X a=$%02X", i, x, y, t, attr))
    end
  end

  dumped = true
  log("DONE")
  emu.message("Knife trace v4 captured!")
end

function on_frame()
  fc = fc + 1
  if dumped then return end

  -- Trigger on any blade sprite ($49) at portrait area (x>=160)
  for i=0,63 do
    local base = 0x0200 + i*4
    local y = memory.readbyte(base)
    local t = memory.readbyte(base+1)
    local x = memory.readbyte(base+3)
    if y > 0 and y < 240 and t == 0x49 and x >= 160 then
      log("Triggered on spr"..i.." at frame "..fc)
      dump_all()
      return
    end
  end
end

emu.registerbefore(on_frame)
log("knife-trace4: waiting for knife attack at portrait position...")
emu.message("Knife tracer v4 — attack with knife!")
