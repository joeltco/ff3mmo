-- FCEUX Lua: Walk sprite trace — auto-captures all directions
-- Just run and walk in all 4 directions. No keys needed.
-- Output: tools/walk-sprite-trace.txt

local OUT = "/home/joeltco/projects/ff3mmo/tools/walk-sprite-trace.txt"
local f = io.open(OUT, "w")
local frame_count = 0
local capture_count = 0

local PLAYER_X_MIN = 96
local PLAYER_X_MAX = 160
local PLAYER_Y_MIN = 80
local PLAYER_Y_MAX = 144

function log(msg) f:write(msg .. "\n") f:flush() end

function dump_ppu_tile(id)
  local base = 0x1000 + id * 16
  local b = {}
  for i = 0, 15 do b[i+1] = ppu.readbyte(base + i) end
  return b
end

function hex_bytes(b)
  local p = {}
  for _, v in ipairs(b) do p[#p+1] = string.format("0x%02X", v) end
  return table.concat(p, ", ")
end

-- Full fingerprint of PPU $1000-$10FF (tiles $00-$0F, all 16 bytes each)
function ppu_fingerprint()
  local parts = {}
  for id = 0, 15 do
    local base = 0x1000 + id * 16
    parts[#parts+1] = string.format("%02X%02X%02X%02X",
      ppu.readbyte(base), ppu.readbyte(base+4),
      ppu.readbyte(base+8), ppu.readbyte(base+12))
  end
  return table.concat(parts)
end

function find_player_oam()
  local sprites = {}
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local oam_y = memory.readbyte(base)
    local tile  = memory.readbyte(base + 1)
    local attr  = memory.readbyte(base + 2)
    local oam_x = memory.readbyte(base + 3)
    local screen_y = oam_y + 1
    if oam_x >= PLAYER_X_MIN and oam_x <= PLAYER_X_MAX and
       screen_y >= PLAYER_Y_MIN and screen_y <= PLAYER_Y_MAX and
       oam_y < 0xEF then
      sprites[#sprites+1] = { x=oam_x, y=screen_y, tile=tile, attr=attr,
        pal=bit.band(attr,3), hflip=bit.band(attr,0x40)~=0, idx=i }
    end
  end
  table.sort(sprites, function(a,b)
    if a.y ~= b.y then return a.y < b.y end
    return a.x < b.x
  end)
  return sprites
end

function pos_label(sprites, i)
  if #sprites < 4 then return "?" end
  local mx, my = 999, 999
  for _,s in ipairs(sprites) do
    if s.x < mx then mx=s.x end
    if s.y < my then my=s.y end
  end
  local dx,dy = sprites[i].x-mx, sprites[i].y-my
  if dy==0 and dx==0 then return "TL"
  elseif dy==0 and dx>=7 then return "TR"
  elseif dy>=7 and dx==0 then return "BL"
  elseif dy>=7 and dx>=7 then return "BR"
  else return "?" end
end

-- Track seen combos: ppu_fp + oam_fp → already captured
local seen = {}
local last_ppu_fp = ""
local last_oam_fp = ""
local dir_num = 0
local dir_label = "DIR_?"

function oam_fp(sprites)
  local p = {}
  for _,s in ipairs(sprites) do p[#p+1]=string.format("%02X%02X",s.tile,s.attr) end
  return table.concat(p)
end

function try_capture(sprites)
  if #sprites ~= 4 then return end
  local fp = ppu_fp_current .. "|" .. oam_fp(sprites)
  if seen[fp] then return end
  seen[fp] = true
  capture_count = capture_count + 1

  local has_hflip = false
  local tl,tr,bl,br = -1,-1,-1,-1
  for i,s in ipairs(sprites) do
    local pos = pos_label(sprites,i)
    if pos=="TL" then tl=s.tile elseif pos=="TR" then tr=s.tile
    elseif pos=="BL" then bl=s.tile elseif pos=="BR" then br=s.tile end
    if s.hflip then has_hflip=true end
  end

  log(string.format("\n[CAPTURE #%d] dir=%s f=%d", capture_count, dir_label, frame_count))
  log(string.rep("-",60))
  for i,s in ipairs(sprites) do
    local pos=pos_label(sprites,i)
    log(string.format("  [%s] x=%3d y=%3d tile=$%02X attr=$%02X%s",
      pos, s.x, s.y, s.tile, s.attr, s.hflip and " HFLIP" or ""))
  end
  log("Sprite palettes:")
  for p=0,3 do
    local v={}
    for i=0,3 do v[i+1]=string.format("$%02X",ppu.readbyte(0x3F10+p*4+i)) end
    log(string.format("  pal%d: %s",p,table.concat(v," ")))
  end
  log("PPU tile bytes (PPU $1000):")
  local dumped={}
  for i,s in ipairs(sprites) do
    if not dumped[s.tile] then
      dumped[s.tile]=true
      local pos=pos_label(sprites,i)
      log(string.format("  tile $%02X [%s]: new Uint8Array([%s]),",
        s.tile, pos, hex_bytes(dump_ppu_tile(s.tile))))
    end
  end
  log(string.format("  // dir=%s tiles:[$%02X,$%02X,$%02X,$%02X] flip:%s",
    dir_label,tl,tr,bl,br,tostring(has_hflip)))

  print(string.format("#%d dir=%s $%02X/$%02X/$%02X/$%02X flip=%s",
    capture_count,dir_label,tl,tr,bl,br,tostring(has_hflip)))
end

ppu_fp_current = ""

function on_frame()
  frame_count = frame_count + 1
  if frame_count % 2 ~= 0 then return end

  local new_ppu_fp = ppu_fingerprint()

  -- Detect CHR bank switch = direction change
  if new_ppu_fp ~= last_ppu_fp then
    last_ppu_fp = new_ppu_fp
    ppu_fp_current = new_ppu_fp
    if not seen["tileset|"..new_ppu_fp] then
      seen["tileset|"..new_ppu_fp] = true
      dir_num = dir_num + 1
      dir_label = "DIR_" .. dir_num
      log(string.format("\n=== NEW DIRECTION TILESET: %s (f=%d) ===", dir_label, frame_count))
      print("New direction: " .. dir_label)
    end
  end

  local sprites = find_player_oam()
  local fp = oam_fp(sprites)
  if fp ~= last_oam_fp then
    last_oam_fp = fp
    try_capture(sprites)
  end
end

function on_gui()
  gui.text(2, 2,  "WALK TRACE: "..capture_count.." captures", "white")
  gui.text(2, 12, "dir: "..dir_label, "yellow")
  gui.text(2, 22, "walk all 4 directions!", "cyan")
end

emu.registerbefore(on_frame)
emu.registerafter(on_gui)

log("=== FF3 Walk Sprite Trace ===")
log("Walk in all 4 directions. Auto-detecting direction changes.")
log("")
print("Walk trace running — walk all 4 directions!")
