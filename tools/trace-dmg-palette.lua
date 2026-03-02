-- FCEUX Lua: capture sprite palettes during damage number display
-- Triggers palette dump every frame that spr08-11 show damage digits ($58-$5F range)

local f = io.open("/home/joeltco/projects/ff3mmo/tools/dmg-palette-trace.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local state = "title"
local dump_count = 0
local MAX_DUMPS = 30  -- capture 30 frames of palette data then stop

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

function dump_palettes_and_sprites()
  -- Dump all 4 sprite palettes from PPU
  log("-- sprite palettes (PPU $3F10-$3F1F) --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
  end
  -- Also dump BG palettes for reference
  log("-- bg palettes (PPU $3F00-$3F0F) --")
  for p = 0, 3 do
    local s = string.format("  bgpal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F00 + p * 4 + i))
    end
    log(s)
  end
end

function check_damage_sprites()
  -- Look for damage number sprites (tiles $58-$5F in spr04-11)
  local found = false
  for i = 4, 11 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    if y > 0 and y < 240 and tile >= 0x58 and tile <= 0x5F then
      found = true
      local pal = bit.band(attr, 3)
      log(string.format("  spr%02d: x=%3d y=%3d tile=$%02X attr=$%02X pal=%d",
        i, x, y, tile, attr, pal))
    end
  end
  return found
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

  -- === TITLE ===
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

  -- === WALKING ===
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

    if frame_count > 8000 then
      log("=== TIMEOUT ===")
      finish()
    end
    return
  end

  -- === BATTLE_CLEAR: no input for 120 frames ===
  if state == "battle_clear" then
    unequip_all()
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
      log("=== Input cleared, starting A spam ===")
    end
    return
  end

  -- === BATTLE ===
  if state == "battle" then
    unequip_all()
    local bf = frame_count - battle_start

    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Check for damage number sprites every frame
    local has_dmg = check_damage_sprites()
    if has_dmg then
      dump_count = dump_count + 1
      log(string.format("--- DMG FRAME %d (bf=%d) ---", dump_count, bf))
      dump_palettes_and_sprites()

      -- Also dump the digit tile data from PPU
      if dump_count == 1 then
        log("-- damage digit tiles (PPU pattern table $1000) --")
        for tile = 0x58, 0x5F do
          local addr = 0x1000 + tile * 16
          local hex = ""
          for b = 0, 15 do
            hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
          end
          log(string.format("  tile $%02X: %s", tile, hex))
        end
      end

      if dump_count >= MAX_DUMPS then
        log("=== Got enough palette data ===")
        finish()
        return
      end
    end

    if bf > 1800 then
      log("=== Done ===")
      finish()
    end
    return
  end

  if frame_count > 12000 then
    log("=== HARD TIMEOUT ===")
    finish()
  end
end

emu.registerbefore(on_frame)
log("Damage palette trace - captures PPU palettes during damage number display")
