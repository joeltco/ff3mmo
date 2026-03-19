-- dump-enemy-sprite.lua
-- During a random encounter, press P to dump the enemy's BG tile data.
-- Run this for each unique enemy (Carbuncle, Eye Fang, Blue Wisp).
-- Output appended to: tools/enemy-sprite-dump.txt

local OUT = "/home/joeltco/projects/ff3mmo/tools/enemy-sprite-dump.txt"
local dump_count = 0
local prev_p = false

local function log_file(f, s) f:write(s.."\n") end

-- Read one PPU tile (16 bytes, 2bpp) from BG pattern table $0000
local function read_bg_tile(tile_id)
  local base = tile_id * 16
  local t = {}
  for i = 0, 15 do t[i+1] = ppu.readbyte(base + i) end
  return t
end

-- Get palette index (0-3) for a nametable cell (col 0-31, row 0-29)
local function cell_palette(col, row)
  local block = math.floor(row/4)*8 + math.floor(col/4)
  local ab = ppu.readbyte(0x23C0 + block)
  local sub = math.floor((row%4)/2)*2 + math.floor((col%4)/2)
  return bit.band(bit.rshift(ab, sub*2), 0x03)
end

local function do_dump()
  dump_count = dump_count + 1
  local f = io.open(OUT, "a")
  local log = function(s) log_file(f, s) end

  log(string.format("\n=== Dump #%d ===", dump_count))
  log("(label this dump with the enemy name after you see it)")

  -- BG palettes
  log("\n-- BG Palettes ($3F00-$3F0F):")
  for p = 0, 3 do
    local b = 0x3F00 + p*4
    log(string.format("  pal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(b), ppu.readbyte(b+1), ppu.readbyte(b+2), ppu.readbyte(b+3)))
  end

  -- Scan nametable for enemy area (left viewport, rows 3-13, cols 1-14)
  -- Battle BG has enemies on the left ~half of the screen
  log("\n-- Nametable scan (rows 3-13, cols 1-14) — non-zero tiles:")
  local seen = {}   -- tile_id -> palette_index
  local grid = {}   -- [row][col] = tile_id

  for row = 3, 13 do
    grid[row] = {}
    for col = 1, 17 do
      local tile = ppu.readbyte(0x2000 + row*32 + col)
      grid[row][col] = tile
      if tile ~= 0x00 and not seen[tile] then
        seen[tile] = cell_palette(col, row)
      end
    end
  end

  -- Print nametable grid (condensed)
  for row = 3, 13 do
    local line = string.format("  row%02d:", row)
    for col = 1, 17 do
      line = line .. string.format(" %02X", grid[row][col])
    end
    log(line)
  end

  -- Sort unique tiles
  local tile_ids = {}
  for id in pairs(seen) do tile_ids[#tile_ids+1] = id end
  table.sort(tile_ids)

  -- Dump tile bytes in JS-ready format
  log("\n-- Tile bytes (PPU $0000, JS-ready new Uint8Array):")
  log(string.format("-- %d unique non-blank tiles found", #tile_ids))
  for _, tid in ipairs(tile_ids) do
    local bytes = read_bg_tile(tid)
    local hex = ""
    for _, b in ipairs(bytes) do hex = hex .. string.format("%02X", b) end
    log(string.format("  Tile $%02X (pal%d): %s", tid, seen[tid], hex))
  end

  -- Tile-palette mapping hint (ordered by tile_id)
  log("\n-- TILE_PAL hint (palette index per tile, in tile_id order):")
  local pal_arr = {}
  for _, tid in ipairs(tile_ids) do pal_arr[#pal_arr+1] = seen[tid] end
  log("  [" .. table.concat(pal_arr, ",") .. "]")

  -- Tile IDs in order (for building JS array)
  log("\n-- Tile IDs in order:")
  local id_arr = {}
  for _, tid in ipairs(tile_ids) do id_arr[#id_arr+1] = string.format("0x%02X", tid) end
  log("  [" .. table.concat(id_arr, ", ") .. "]")

  f:close()
  print(string.format("[dump #%d] wrote to %s  (%d tiles)", dump_count, OUT, #tile_ids))
end

function on_gui()
  gui.text(2,  2, "ENEMY SPRITE DUMP", "white")
  gui.text(2, 12, "P = dump current enemy", "yellow")
  gui.text(2, 22, "dumps so far: " .. dump_count, "cyan")
  gui.text(2, 32, "fight Carbuncle, Eye Fang,", "white")
  gui.text(2, 42, "Blue Wisp — dump each one", "white")
end

function on_frame()
  local keys = input.get()
  local p_now = keys["P"] == true
  if p_now and not prev_p then
    do_dump()
  end
  prev_p = p_now
end

emu.registerbefore(on_frame)
emu.registerafter(on_gui)

-- Write header on first run
local f = io.open(OUT, "a")
f:write("\n=== FF3 Enemy Sprite Dump Session ===\n")
f:write("Enemies: Carbuncle ($01), Eye Fang ($02), Blue Wisp ($03)\n")
f:close()

print("Enemy sprite dump loaded. Press P in battle to capture!")
