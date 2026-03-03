-- FCEUX Lua: dump PPU tile bytes during punch animation
-- Reuses v8 approach but dumps PPU pattern table when hit effect appears

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-ppu-dump.txt", "w")
local frame_count = 0
local done = false
local state = "title"
local battle_start = 0
local dumped = false

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  f:close()
end

function unequip_all()
  for i = 0, 3 do
    local base = 0x6100 + i * 0x40
    memory.writebyte(base + 0x38, 0)
    memory.writebyte(base + 0x39, 0)
  end
  memory.writebyte(0x7E1F, 0)
  memory.writebyte(0x7E20, 0)
end

function dump_ppu_tiles()
  -- Dump sprite pattern table tiles $49-$55 (both hands)
  -- Sprites could use either $0000 or $1000 pattern table
  -- Try both and dump all
  log("=== PPU TILE DUMP ===")
  for _, base in ipairs({0x0000, 0x1000}) do
    log(string.format("-- Pattern table base $%04X --", base))
    for tile = 0x49, 0x55 do
      local addr = base + tile * 16
      local hex = ""
      for b = 0, 15 do
        hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
      end
      log(string.format("  tile $%02X @ $%04X: %s", tile, addr, hex))
    end
  end
  -- Also dump sprite palette 3 (PPU $3F18-$3F1B)
  log("-- Sprite palette 3 --")
  local pal = ""
  for i = 0, 3 do
    pal = pal .. string.format("$%02X ", ppu.readbyte(0x3F18 + i))
  end
  log("  " .. pal)
  -- And all sprite palettes for reference
  log("-- All sprite palettes --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
  end
end

function on_frame()
  if done then return end
  frame_count = frame_count + 1

  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
    end
    return
  end

  if state == "walking" then
    unequip_all()
    local dir = math.floor(frame_count / 12) % 4
    if dir == 0 then joypad.set(1, {right=true})
    elseif dir == 1 then joypad.set(1, {up=true})
    elseif dir == 2 then joypad.set(1, {left=true})
    else joypad.set(1, {down=true})
    end
    if mode >= 0x03 and frame_count > 1560 then
      state = "battle_clear"
      battle_start = frame_count
    end
    if frame_count > 8000 then
      log("TIMEOUT walking")
      finish()
    end
    return
  end

  if state == "battle_clear" then
    unequip_all()
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
    end
    return
  end

  if state == "battle" then
    unequip_all()
    local bf = frame_count - battle_start
    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Check for hit effect sprites in OAM (x < 180 = non-party area)
    if not dumped then
      for i = 0, 63 do
        local base = 0x0200 + i * 4
        local y = memory.readbyte(base)
        local x = memory.readbyte(base + 3)
        local tile = memory.readbyte(base + 1)
        if y > 0 and y < 240 and x < 180 and tile >= 0x49 and tile <= 0x55 then
          log(string.format("=== HIT EFFECT FOUND at bf=%d spr%d x=%d y=%d tile=$%02X ===",
            bf, i, x, y, tile))
          dump_ppu_tiles()
          dumped = true
          -- Keep going a bit then exit
          state = "finishing"
          battle_start = frame_count
          break
        end
      end
    end

    if bf > 1800 then
      log("TIMEOUT battle - no hit effect seen")
      finish()
    end
    return
  end

  if state == "finishing" then
    if frame_count - battle_start > 30 then
      finish()
    end
    return
  end
end

emu.registerbefore(on_frame)
log("PPU dump script")
