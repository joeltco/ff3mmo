-- FCEUX Lua: capture critical hit sprite/tile/palette data
-- Forces crits by setting $CB=1 and crit probability to 255, captures all sprite+palette changes

local f = io.open("/home/joeltco/projects/ff3mmo/tools/crit-trace.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local state = "title"
local last_sprite_hash = ""
local capture_frames = 0
local MAX_CAPTURE_FRAMES = 120

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

function force_crit()
  -- Set crit probability to max so every hit crits
  memory.writebyte(0x7430, 0xFF)  -- crit probability = 255 (random 0..99 always < 255)
  memory.writebyte(0x7431, 0x20)  -- crit bonus
  -- Also set the crit flags directly
  memory.writebyte(0x29, 1)       -- crit flag (ZP)
  memory.writebyte(0xCB, 1)       -- crit flag (battle animation)
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
  log("-- bg palettes --")
  for p = 0, 3 do
    local s = string.format("  bgpal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F00 + p * 4 + i))
    end
    log(s)
  end
  -- Backdrop color ($3F00)
  log(string.format("  backdrop: $%02X", ppu.readbyte(0x3F00)))
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

function dump_battle_state()
  local cb = memory.readbyte(0xCB)
  local zp29 = memory.readbyte(0x29)
  local b6 = memory.readbyte(0xB6)
  local b7 = memory.readbyte(0xB7)
  local cd = memory.readbyte(0xCD)
  local mode = memory.readbyte(0x0040)
  local backdrop = ppu.readbyte(0x3F00)
  log(string.format("  CB(crit)=$%02X ZP29=$%02X B6=$%02X B7=$%02X CD=$%02X mode=$%02X backdrop=$%02X",
    cb, zp29, b6, b7, cd, mode, backdrop))
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
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
      log("=== Input cleared, forcing crits, starting A spam ===")
    end
    return
  end

  if state == "battle" then
    force_crit()
    local bf = frame_count - battle_start

    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Log every sprite or palette change
    local backdrop = ppu.readbyte(0x3F00)
    local h = sprite_hash() .. string.format("_%02X", backdrop)
    if h ~= last_sprite_hash then
      log(string.format("--- bf=%d ---", bf))
      dump_battle_state()
      log_all_sprites()
      dump_palettes()

      -- Check for non-standard backdrop (crit flash = $27 orange)
      if backdrop ~= 0x0F then
        log(string.format("  *** CRIT FLASH: backdrop=$%02X ***", backdrop))
      end

      -- Dump hit effect tiles and damage number tiles
      for i = 0, 23 do
        local base = 0x0200 + i * 4
        local y = memory.readbyte(base)
        local tile = memory.readbyte(base + 1)
        local x = memory.readbyte(base + 3)
        if y > 0 and y < 240 and tile >= 0x46 then
          dump_tiles(tile, math.min(0xFF, tile + 1), 0x0000)
        end
      end

      capture_frames = capture_frames + 1
      last_sprite_hash = h
    end

    if capture_frames >= MAX_CAPTURE_FRAMES or bf > 1800 then
      log("=== Done ===")
      finish()
    end
    return
  end

  if frame_count > 12000 then finish() end
end

emu.registerbefore(on_frame)
log("Critical hit trace - forces crits and captures sprite/palette/backdrop data")
