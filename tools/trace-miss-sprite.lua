-- FCEUX Lua: capture miss sprite/tile data
-- Forces misses by setting hit rate to 0, captures all sprite changes during miss display

local f = io.open("/home/joeltco/projects/ff3mmo/tools/miss-sprite-trace.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local state = "title"
local last_sprite_hash = ""
local miss_frames = 0
local MAX_MISS_FRAMES = 60

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  log("=== FINISHED ===")
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

function force_miss()
  -- Zero out hit rate / accuracy for party members
  -- Battle RAM: $7E00+ area, character attack stats
  -- Set hit% to 0 for all party members
  for i = 0, 3 do
    local base = 0x7E00 + i * 0x40
    memory.writebyte(base + 0x23, 0)  -- hit rate
    memory.writebyte(base + 0x24, 0)  -- hit count
  end
end

function sprite_hash()
  local h = ""
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y > 0 and y < 240 then
      h = h .. string.format("%02X%02X%02X%02X",
        memory.readbyte(base+3), y, memory.readbyte(base+1), memory.readbyte(base+2))
    end
  end
  return h
end

function log_all_sprites()
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    if y > 0 and y < 240 then
      local pal = bit.band(attr, 3)
      local hf = bit.band(bit.rshift(attr, 6), 1)
      local vf = bit.band(bit.rshift(attr, 7), 1)
      log(string.format("  spr%02d: x=%3d y=%3d tile=$%02X attr=$%02X pal=%d hf=%d vf=%d",
        i, x, y, tile, attr, pal, hf, vf))
    end
  end
end

function dump_palettes()
  log("-- sprite palettes --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
  end
end

function dump_tiles(start_tile, end_tile, ptable)
  log(string.format("-- tiles $%02X-$%02X from pattern table $%04X --", start_tile, end_tile, ptable))
  for tile = start_tile, end_tile do
    local addr = ptable + tile * 16
    local hex = ""
    for b = 0, 15 do
      hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
    end
    log(string.format("  tile $%02X: %s", tile, hex))
  end
end

function on_frame()
  if done then return end
  frame_count = frame_count + 1

  local mode = memory.readbyte(0x0040)

  if mode ~= last_mode then
    log(string.format("[f%d] mode $%02X->$%02X (%s)", frame_count,
      last_mode >= 0 and last_mode or 0, mode, state))
    last_mode = mode
  end

  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
      log("=== Walking ===")
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
      log(string.format("=== Battle at f%d mode=$%02X ===", frame_count, mode))
    end

    if frame_count > 8000 then finish() end
    return
  end

  if state == "battle_clear" then
    unequip_all()
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
      log("=== Input cleared, forcing misses, starting A spam ===")
    end
    return
  end

  if state == "battle" then
    unequip_all()
    force_miss()
    local bf = frame_count - battle_start

    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Log every sprite change
    local h = sprite_hash()
    if h ~= last_sprite_hash then
      local b6 = memory.readbyte(0xB6)
      local cd = memory.readbyte(0xCD)
      log(string.format("--- bf=%d B6=$%02X CD=$%02X mode=$%02X ---", bf, b6, cd, mode))
      log_all_sprites()
      dump_palettes()

      -- Check for any non-party sprites (x < 180) that might be miss text
      for i = 0, 15 do
        local base = 0x0200 + i * 4
        local y = memory.readbyte(base)
        local tile = memory.readbyte(base + 1)
        local x = memory.readbyte(base + 3)
        if y > 0 and y < 240 and (tile >= 0x56 or (x < 180 and i < 12)) then
          log(string.format("  *** POSSIBLE MISS SPRITE spr%02d tile=$%02X x=%d y=%d ***", i, tile, x, y))
          -- Dump this tile and neighbors from both pattern tables
          local t_start = math.max(0, tile - 2)
          local t_end = math.min(0xFF, tile + 2)
          dump_tiles(t_start, t_end, 0x0000)
          dump_tiles(t_start, t_end, 0x1000)
        end
      end

      miss_frames = miss_frames + 1
      last_sprite_hash = h
    end

    if miss_frames >= MAX_MISS_FRAMES or bf > 1800 then
      log("=== Done ===")
      finish()
    end
    return
  end

  if frame_count > 12000 then finish() end
end

emu.registerbefore(on_frame)
log("Miss sprite trace - forces misses and captures all sprite data")
