-- FCEUX Lua: knife trace v2 — minimal, crash-resistant
-- Dumps ALL OAM every frame during battle attack, no sprite hash filtering

local f = io.open("/home/joeltco/projects/ff3mmo/tools/knife-trace2.txt", "w")
local fc = 0
local bstart = 0
local state = "title"
local dumps_R = 0
local dumps_L = 0

function log(m) f:write(m.."\n") end

function equip()
  memory.writebyte(0x6138, 0x1E)
  memory.writebyte(0x6139, 0x1E)
  memory.writebyte(0x7E1F, 0x1E)
  memory.writebyte(0x7E20, 0x1E)
  for i=1,3 do
    memory.writebyte(0x6100+i*0x40+0x38, 0)
    memory.writebyte(0x6100+i*0x40+0x39, 0)
  end
end

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
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if fc % 4 == 0 then joypad.set(1, {A=true, start=true}) end
    if fc >= 1500 then state = "walk"; log("WALK") end
    return
  end

  if state == "walk" then
    equip()
    local dir = math.floor(fc/12) % 4
    if dir==0 then joypad.set(1,{right=true})
    elseif dir==1 then joypad.set(1,{up=true})
    elseif dir==2 then joypad.set(1,{left=true})
    else joypad.set(1,{down=true}) end
    if mode >= 0x03 and fc > 1560 then
      state = "bclear"; bstart = fc
      log("BATTLE f="..fc)
    end
    if fc > 8000 then log("TIMEOUT"); f:close(); return end
    return
  end

  if state == "bclear" then
    equip(); joypad.set(1, {})
    if fc - bstart >= 120 then
      state = "fight"
      log(string.format("FIGHT Rwpn=$%02X Lwpn=$%02X", memory.readbyte(0x7E1F), memory.readbyte(0x7E20)))
    end
    return
  end

  if state == "fight" then
    equip()
    local bf = fc - bstart
    if bf % 2 == 0 then joypad.set(1,{A=true}) else joypad.set(1,{}) end

    local cd = memory.readbyte(0xCD)

    -- Scan for slash tiles only
    for i=0,63 do
      local base = 0x0200 + i*4
      local y = memory.readbyte(base)
      local t = memory.readbyte(base+1)
      local attr = memory.readbyte(base+2)
      local x = memory.readbyte(base+3)
      if y>0 and y<240 and t>=0x49 and t<=0x50 and x<180 then
        log(string.format("spr%02d x=%d y=%d t=$%02X a=$%02X cd=%d bf=%d",
          i,x,y,t,attr,cd,bf))
        if cd==0 and dumps_R==0 then dumps_R=1; dump_ppu("R") end
        if cd==1 and dumps_L==0 then dumps_L=1; dump_ppu("L") end
      end
    end

    if dumps_R>0 and dumps_L>0 then
      log("DONE"); f:close(); emu.exit(); return
    end
    if bf > 3600 then
      log("TIMEOUT R="..dumps_R.." L="..dumps_L); f:close(); emu.exit(); return
    end
    return
  end

  if fc > 12000 then log("HARD TIMEOUT"); f:close(); return end
end

emu.registerbefore(on_frame)
log("knife-trace2: both hands, minimal")
