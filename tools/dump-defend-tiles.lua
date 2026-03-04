-- FCEUX Lua: dump PPU tile data for defend sparkle tiles $49-$4C
-- Press P to dump. Run during battle when defend effect is visible.

local outpath = "/home/joeltco/projects/ff3mmo/tools/defend-tiles.txt"
local dumped = false
local p_was_down = false

emu.registerbefore(function()
  local keys = input.get()
  local p_down = keys["P"] == true
  if p_down and not p_was_down and not dumped then
    dumped = true
    local f = io.open(outpath, "w")

    -- Also dump the pose tiles $43-$48
    local tiles = {0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
                   0x49, 0x4A, 0x4B, 0x4C}

    for _, tid in ipairs(tiles) do
      f:write(string.format("=== Tile $%02X ===\n", tid))
      local base = tid * 16  -- sprite pattern table at $0000
      -- Dump raw 16 bytes
      local raw = ""
      for b = 0, 15 do
        raw = raw .. string.format("%02X ", ppu.readbyte(base + b))
      end
      f:write("RAW: " .. raw .. "\n")
      -- Decode 2BPP to pixel grid
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
    emu.message("Tiles dumped!")
  end
  p_was_down = p_down
end)

emu.message("Defend tile dumper — press P during battle!")
