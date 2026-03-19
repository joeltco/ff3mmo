-- Finds the player direction RAM address and records all 4 directions.
-- Walk in each direction (down, up, left, right). Script auto-detects
-- direction from OAM and scans RAM to find which byte changes.
-- Output: tools/walk-dir-trace.txt

local OUT = "/home/joeltco/projects/ff3mmo/tools/walk-dir-trace.txt"
local f = io.open(OUT, "w")

local function log(s) f:write(s.."\n") f:flush() end
local function hex(v) return string.format("$%02X", v) end

-- Read shadow OAM at $0200
local function get_oam(idx)
  local b = 0x0200 + idx*4
  return {
    y    = memory.readbyte(b),
    tile = memory.readbyte(b+1),
    attr = memory.readbyte(b+2),
    x    = memory.readbyte(b+3),
  }
end

-- Find the player's 4 OAM sprites (clustered near screen center)
local function find_player()
  local s = {}
  for i=0,63 do
    local o = get_oam(i)
    local sx, sy = o.x, o.y+1
    if sx>=96 and sx<=160 and sy>=80 and sy<=144 and o.y<0xEF then
      s[#s+1] = o
    end
  end
  table.sort(s, function(a,b)
    if a.y~=b.y then return a.y<b.y end
    return a.x<b.x
  end)
  return s
end

-- Infer direction from OAM tile IDs and attributes
local function infer_dir(sprites)
  if #sprites < 4 then return "??" end
  local tl = sprites[1]
  local hflip = bit.band(tl.attr, 0x40) ~= 0
  local tile = tl.tile
  if tile <= 0x07 then
    -- DOWN uses $00-$03, UP uses $04-$07 (or both depending on frame)
    -- Check bottom-row flip: DOWN/UP frame1 has bottom HFLIP only
    local bl = sprites[3]
    local bl_hflip = bit.band(bl.attr, 0x40) ~= 0
    if tile <= 0x03 then
      return bl_hflip and "DOWN_f1" or "DOWN_f0"
    else
      return bl_hflip and "UP_f1" or "UP_f0"
    end
  else
    -- $08-$0F = LEFT or RIGHT
    if hflip then
      return tile <= 0x0B and "RIGHT_f0" or "RIGHT_f1"
    else
      return tile <= 0x0B and "LEFT_f0" or "LEFT_f1"
    end
  end
end

-- Snapshot all RAM $00-$FF
local function snap_ram()
  local t = {}
  for i=0,255 do t[i] = memory.readbyte(i) end
  return t
end

-- Compare two RAM snapshots, return list of changed addresses
local function ram_diff(a, b)
  local d = {}
  for i=0,255 do
    if a[i] ~= b[i] then d[#d+1] = {addr=i, from=a[i], to=b[i]} end
  end
  return d
end

local frame = 0
local last_dir = ""
local last_tiles = ""
local last_ram = snap_ram()
local captures = {}

local function tile_sig(sprites)
  if #sprites < 4 then return "" end
  return string.format("%02X%02X%02X%02X_%02X%02X%02X%02X",
    sprites[1].tile, sprites[2].tile, sprites[3].tile, sprites[4].tile,
    sprites[1].attr, sprites[2].attr, sprites[3].attr, sprites[4].attr)
end

function on_frame()
  frame = frame+1
  if frame % 2 ~= 0 then return end

  local sprites = find_player()
  if #sprites ~= 4 then return end

  local sig = tile_sig(sprites)
  local dir = infer_dir(sprites)

  if sig == last_tiles then return end

  -- OAM changed — check RAM diff
  local cur_ram = snap_ram()
  local diff = ram_diff(last_ram, cur_ram)
  last_ram = cur_ram

  local key = dir
  if captures[key] then
    last_tiles = sig
    return
  end
  captures[key] = true

  log(string.format("\n[DIR: %s] f=%d  tiles: $%02X/$%02X/$%02X/$%02X  attr: $%02X/$%02X/$%02X/$%02X",
    dir, frame,
    sprites[1].tile, sprites[2].tile, sprites[3].tile, sprites[4].tile,
    sprites[1].attr, sprites[2].attr, sprites[3].attr, sprites[4].attr))

  -- Log RAM bytes that changed
  if #diff > 0 then
    log("  RAM changes:")
    for _,d in ipairs(diff) do
      log(string.format("    $%02X: $%02X -> $%02X", d.addr, d.from, d.to))
    end
  end

  -- Log candidate direction bytes (low RAM, likely $00-$7F)
  log("  Key RAM bytes (candidates for direction):")
  for _,addr in ipairs({0x37,0x38,0x39,0x3A,0x3B,0x40,0x41,0x50,0x51,0x67,0x68}) do
    log(string.format("    $%02X = $%02X", addr, cur_ram[addr]))
  end

  last_tiles = sig
  print(string.format("Captured dir=%s  tiles=$%02X/$%02X/$%02X/$%02X",
    dir, sprites[1].tile, sprites[2].tile, sprites[3].tile, sprites[4].tile))
end

function on_gui()
  local sprites = find_player()
  local dir = infer_dir(sprites)
  gui.text(2, 2,  "DIR TRACE", "white")
  gui.text(2, 12, "inferred: "..dir, "yellow")
  gui.text(2, 22, "walk all 4 dirs", "cyan")
  local n = 0
  for _ in pairs(captures) do n=n+1 end
  gui.text(2, 32, "captured: "..n.."/8", "white")
end

emu.registerbefore(on_frame)
emu.registerafter(on_gui)

log("=== Walk Direction Trace ===")
log("Walk in all 4 directions. Script infers dir from OAM and logs RAM changes.")
log("")
print("Walk direction trace running. Walk all 4 directions!")
