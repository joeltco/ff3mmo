-- FCEUX Lua: dump PPU tile data for potion/heal effect sprites
-- Press P to start. Captures OAM snapshot + dumps PPU tiles for all
-- visible effect sprites (OAM[00-15]) plus a broad range of effect tiles.
-- Triggers on first frame where OAM[00-05] shows any non-body tile
-- (not in the idle/attack body tile range $01-$48).

local outpath = "/home/joeltco/projects/ff3mmo/tools/potion-tiles.txt"
local dumped = false
local waiting = false
local p_was_down = false
local wait_frames = 0
local PT_BASE = 0x1000

-- Known body/pose tiles to exclude from trigger detection
-- (we want to trigger on NEW effect tiles, not character body)
local body_tiles = {}
for t = 0x01, 0x48 do body_tiles[t] = true end

emu.registerbefore(function()
  if dumped then return end

  local keys = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down and not waiting then
    waiting = true
    wait_frames = 0
    emu.message("Waiting for heal effect sprites in OAM...")
  end
  p_was_down = p_down

  if not waiting then return end

  wait_frames = wait_frames + 1
  if wait_frames > 900 then
    waiting = false
    emu.message("Timeout — press P and use Potion again")
    return
  end

  -- Check OAM[00-05] for non-body effect tiles
  local found_effect = false
  local effect_tiles = {}
  for i = 0, 15 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    if y < 0xEF and not body_tiles[tile] then
      found_effect = true
      effect_tiles[tile] = true
    end
  end

  if not found_effect then return end

  -- Found effect sprites! Dump everything
  dumped = true
  local f = io.open(outpath, "w")

  -- Sprite palettes
  f:write("=== Sprite Palettes ===\n")
  for p = 0, 3 do
    local s = string.format("pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    f:write(s .. "\n")
  end
  f:write("\n")

  -- Full OAM dump (all 64 sprites)
  f:write("=== OAM (all visible) ===\n")
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    if y < 0xEF then
      f:write(string.format("  [%02d] x=%3d y=%3d t=$%02X a=$%02X p%d %s%s\n",
        i, x, y, tile, attr,
        AND(attr, 0x03),
        AND(attr, 0x40) ~= 0 and "H" or "-",
        AND(attr, 0x80) ~= 0 and "V" or "-"))
    end
  end
  f:write("\n")

  -- Collect all unique tile IDs from visible OAM
  local all_tiles = {}
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    if y < 0xEF then
      all_tiles[tile] = true
    end
  end

  -- Also add a range around discovered effect tiles (neighbors might be relevant)
  for t, _ in pairs(effect_tiles) do
    for off = -2, 2 do
      local tid = t + off
      if tid >= 0 and tid <= 0xFF then
        all_tiles[tid] = true
      end
    end
  end

  -- Sort tile IDs
  local sorted = {}
  for t, _ in pairs(all_tiles) do
    sorted[#sorted + 1] = t
  end
  table.sort(sorted)

  -- Dump each tile's PPU data
  for _, tid in ipairs(sorted) do
    f:write(string.format("=== Tile $%02X %s===\n", tid,
      effect_tiles[tid] and "(EFFECT) " or ""))
    local base = PT_BASE + tid * 16
    local raw = ""
    for b = 0, 15 do
      raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
    end
    f:write("RAW: " .. raw .. "\n")
    for row = 0, 7 do
      local lo = ppu.readbyte(base + row)
      local hi = ppu.readbyte(base + row + 8)
      local line = ""
      for bit = 7, 0, -1 do
        local px = AND(SHIFT(lo, bit), 1) + AND(SHIFT(hi, bit), 1) * 2
        if px == 0 then line = line .. "."
        elseif px == 1 then line = line .. "1"
        elseif px == 2 then line = line .. "2"
        else line = line .. "3"
        end
      end
      f:write(line .. "\n")
    end
    f:write("\n")
  end

  f:close()
  emu.message("POTION TILES CAPTURED! See potion-tiles.txt")
end)

emu.message("Potion dumper — press P then use a Potion in battle!")
