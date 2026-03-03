-- FCEUX Lua: trace victory sequence (palette + OAM + nametable)
-- Play manually. Get into a random encounter, fight and win.
-- Captures all PPU changes from battle start through map return.
-- Output: tools/victory-trace.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/victory-trace.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local in_battle = false
local bf = 0  -- battle-relative frame
local post_battle = 0

-- Change detection
local prev_pal = ""
local prev_oam = ""
local prev_nt = ""
local prev_mode = -1

function log(s)
  if not done then f:write(s .. "\n"); f:flush() end
end

function finish()
  if done then return end
  done = true
  log("=== FINISHED ===")
  f:close()
end

-- All 32 palette bytes
function mk_pal_hash()
  local h = ""
  for i = 0, 31 do h = h .. string.format("%02X", ppu.readbyte(0x3F00 + i)) end
  return h
end

-- Visible OAM sprites
function mk_oam_hash()
  local h = ""
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y > 0 and y < 240 then
      h = h .. string.format("%d:%02X%02X%02X%02X|", i,
        memory.readbyte(b+3), y, memory.readbyte(b+1), memory.readbyte(b+2))
    end
  end
  return h
end

-- Nametable $2000 rows 10-29 + attribute table rows 2-7
function mk_nt_hash()
  local h = ""
  for addr = 0x2000 + 10*32, 0x2000 + 30*32 - 1 do
    h = h .. string.format("%02X", ppu.readbyte(addr))
  end
  for i = 16, 63 do
    h = h .. string.format("%02X", ppu.readbyte(0x23C0 + i))
  end
  return h
end

function dump_pal()
  log("  [PAL]")
  for p = 0, 3 do
    local s = string.format("    bg%d:", p)
    for i = 0, 3 do s = s .. string.format(" $%02X", ppu.readbyte(0x3F00 + p*4 + i)) end
    log(s)
  end
  for p = 0, 3 do
    local s = string.format("    spr%d:", p)
    for i = 0, 3 do s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p*4 + i)) end
    log(s)
  end
end

function dump_oam()
  log("  [OAM]")
  local n = 0
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y > 0 and y < 240 then
      local x = memory.readbyte(b + 3)
      local t = memory.readbyte(b + 1)
      local a = memory.readbyte(b + 2)
      log(string.format("    spr%02d: x=%3d y=%3d t=$%02X a=$%02X p=%d h=%d v=%d",
        i, x, y, t, a, bit.band(a,3), bit.band(bit.rshift(a,6),1), bit.band(bit.rshift(a,7),1)))
      n = n + 1
    end
  end
  if n == 0 then log("    (none)") end
end

function dump_nt()
  log("  [NT rows 10-29]")
  for row = 10, 29 do
    local s = string.format("    r%02d:", row)
    for col = 0, 31 do
      s = s .. string.format(" %02X", ppu.readbyte(0x2000 + row*32 + col))
    end
    log(s)
  end
  log("  [ATTR rows 2-7]")
  for i = 2, 7 do
    local s = string.format("    a%d:", i)
    for j = 0, 7 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x23C0 + i*8 + j))
    end
    log(s)
  end
end

-- Also dump nametable $2400 bottom rows (in case of mirroring)
function dump_nt2()
  log("  [NT2 $2400 rows 10-29]")
  for row = 10, 29 do
    local s = string.format("    r%02d:", row)
    for col = 0, 31 do
      s = s .. string.format(" %02X", ppu.readbyte(0x2400 + row*32 + col))
    end
    log(s)
  end
end

local nt2_dumped = false

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- Mode changes — always log
  if mode ~= prev_mode then
    log(string.format("[f%d] MODE $%02X->$%02X", frame, prev_mode >= 0 and prev_mode or 0, mode))
    prev_mode = mode
  end

  -- Detect battle start (mode $20 = battle, $05 = battle transition)
  if not in_battle and (mode == 0x20 or mode == 0x05) and frame > 60 then
    in_battle = true
    bf = 0
    log(string.format("=== BATTLE START f%d mode=$%02X ===", frame, mode))
    dump_pal()
    dump_oam()
    dump_nt()
    -- One-time dump of nametable 2 for mirroring check
    dump_nt2()
    nt2_dumped = true
    prev_pal = mk_pal_hash()
    prev_oam = mk_oam_hash()
    prev_nt = mk_nt_hash()
    return
  end

  if not in_battle then return end
  bf = bf + 1

  -- Check for changes
  local ph = mk_pal_hash()
  local oh = mk_oam_hash()
  local nh = mk_nt_hash()
  local dp = ph ~= prev_pal
  local do_ = oh ~= prev_oam
  local dn = nh ~= prev_nt

  if dp or do_ or dn then
    local w = (dp and "PAL " or "") .. (do_ and "OAM " or "") .. (dn and "NT " or "")
    log(string.format("[f%d bf%d] %smode=$%02X", frame, bf, w, mode))
    if dp then dump_pal(); prev_pal = ph end
    if do_ then dump_oam(); prev_oam = oh end
    if dn then dump_nt(); prev_nt = nh end
  end

  -- Post-battle: mode returns to map (>= $60)
  if mode >= 0x60 then
    post_battle = post_battle + 1
    if post_battle > 180 then
      log(string.format("=== MAP RETURN f%d mode=$%02X ===", frame, mode))
      finish()
    end
  else
    post_battle = 0
  end

  -- Hard timeout: 10 min
  if bf > 36000 then
    log("=== TIMEOUT ===")
    finish()
  end
end

emu.registerbefore(on_frame)
log("Victory trace — play manually, fight and win a battle")
log("Captures PAL/OAM/NT changes from battle start through map return")
