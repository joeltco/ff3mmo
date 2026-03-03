-- FCEUX Lua: knife trace v3 — NO MACROS, just capture
-- User plays manually. Script only logs OAM + PPU when slash tiles appear.

local f = io.open("/home/joeltco/projects/ff3mmo/tools/knife-trace3.txt", "w")
local dumps_R = 0
local dumps_L = 0
local fc = 0

function log(m) f:write(m.."\n"); f:flush() end

function dump_ppu(label)
  log("=== PPU: "..label.." ===")
  for t=0x49,0x55 do
    local addr = 0x1000 + t*16
    local h = ""
    for b=0,15 do h = h..string.format("%02X", ppu.readbyte(addr+b)) end
    log("  $"..string.format("%02X",t)..": "..h)
  end
  for p=0,3 do
    local s = "  pal"..p..":"
    for i=0,3 do s = s..string.format(" $%02X", ppu.readbyte(0x3F10+p*4+i)) end
    log(s)
  end
end

function on_frame()
  fc = fc + 1
  if dumps_R > 0 and dumps_L > 0 then return end

  local cd = memory.readbyte(0xCD)

  for i=0,63 do
    local base = 0x0200 + i*4
    local y = memory.readbyte(base)
    local t = memory.readbyte(base+1)
    local attr = memory.readbyte(base+2)
    local x = memory.readbyte(base+3)
    if y>0 and y<240 and t>=0x49 and t<=0x50 and x<180 then
      log(string.format("spr%02d x=%d y=%d t=$%02X a=$%02X cd=%d f=%d",
        i,x,y,t,attr,cd,fc))
      if cd==0 and dumps_R==0 then dumps_R=1; dump_ppu("R") end
      if cd==1 and dumps_L==0 then dumps_L=1; dump_ppu("L") end
    end
  end

  if dumps_R > 0 and dumps_L > 0 then
    log("DONE — both hands captured")
    emu.message("DONE — both hands captured!")
  end
end

emu.registerbefore(on_frame)
log("knife-trace3: passive capture, user plays")
emu.message("Knife tracer loaded — play normally, attack with both hands")
