-- FCEUX Lua: capture miss display — dumps nametable + sprites + palettes
-- Miss text is BG tiles in nametable, not OAM sprites

local f = io.open("/home/joeltco/projects/ff3mmo/tools/miss-trace-v2.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local state = "title"
local battle_frames = 0
local dumped = false

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

function dump_nametable_region()
  -- Battle message area: top-right of nametable 0 ($2000)
  -- Dump rows 0-7, cols 16-31 (right half of screen, top area)
  log("-- nametable $2000 rows 0-15 cols 0-31 --")
  for row = 0, 15 do
    local s = string.format("  row%02d:", row)
    for col = 0, 31 do
      local addr = 0x2000 + row * 32 + col
      s = s .. string.format(" %02X", ppu.readbyte(addr))
    end
    log(s)
  end
end

function dump_sprites_compact()
  for i = 0, 15 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x = memory.readbyte(base + 3)
    if y > 0 and y < 240 then
      log(string.format("  spr%02d: x=%3d y=%3d tile=$%02X attr=$%02X pal=%d",
        i, x, y, tile, bit.band(attr, 3), bit.band(attr, 3)))
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
      log("=== Input cleared, starting A spam ===")
    end
    return
  end

  if state == "battle" then
    unequip_all()
    local bf = frame_count - battle_start

    -- Spam A to attack
    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Every 30 frames, dump everything so we catch whatever state the battle is in
    if bf % 30 == 0 and bf >= 150 then
      battle_frames = battle_frames + 1
      log(string.format("=== DUMP %d bf=%d mode=$%02X ===", battle_frames, bf, mode))
      dump_sprites_compact()
      dump_palettes()
      dump_nametable_region()

      if battle_frames >= 40 then
        finish()
        return
      end
    end

    if bf > 2400 then finish() end
    return
  end

  if frame_count > 12000 then finish() end
end

emu.registerbefore(on_frame)
log("Miss trace v2 - periodic nametable + sprite + palette dumps")
