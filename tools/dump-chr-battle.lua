-- FCEUX Lua script to dump CHR-RAM tiles during FF3 battle hit animation
-- Writes PPM images of specific tile ranges for visual inspection

local rom_path = "Final Fantasy III (Japan).nes"
local frame_count = 0
local dumped = false

-- NES system palette (64 colors)
local nes_pal = {
  [0x00]={84,84,84},   [0x01]={0,30,116},    [0x02]={8,16,144},    [0x03]={48,0,136},
  [0x04]={68,0,100},    [0x05]={92,0,48},     [0x06]={84,4,0},      [0x07]={60,24,0},
  [0x08]={32,42,0},     [0x09]={8,58,0},      [0x0A]={0,64,0},      [0x0B]={0,60,0},
  [0x0C]={0,50,60},     [0x0D]={0,0,0},       [0x0E]={0,0,0},       [0x0F]={0,0,0},
  [0x10]={152,150,152}, [0x11]={8,76,196},    [0x12]={48,50,236},   [0x13]={92,30,228},
  [0x14]={136,20,176},  [0x15]={160,20,100},  [0x16]={152,34,32},   [0x17]={120,60,0},
  [0x18]={84,90,0},     [0x19]={40,114,0},    [0x1A]={8,124,0},     [0x1B]={0,118,40},
  [0x1C]={0,102,120},   [0x1D]={0,0,0},       [0x1E]={0,0,0},       [0x1F]={0,0,0},
  [0x20]={236,238,236}, [0x21]={76,154,236},  [0x22]={120,124,236}, [0x23]={176,98,236},
  [0x24]={228,84,236},  [0x25]={236,88,180},  [0x26]={236,106,100}, [0x27]={212,136,32},
  [0x28]={160,170,0},   [0x29]={116,196,0},   [0x2A]={76,208,32},   [0x2B]={56,204,108},
  [0x2C]={56,180,204},  [0x2D]={60,60,60},    [0x2E]={0,0,0},       [0x2F]={0,0,0},
  [0x30]={236,238,236}, [0x31]={168,204,236}, [0x32]={188,188,236}, [0x33]={212,178,236},
  [0x34]={236,174,236}, [0x35]={236,174,212}, [0x36]={236,180,176}, [0x37]={228,196,144},
  [0x38]={204,210,120}, [0x39]={180,222,120}, [0x3A]={168,226,144}, [0x3B]={152,226,180},
  [0x3C]={160,214,228}, [0x3D]={160,162,160}, [0x3E]={0,0,0},       [0x3F]={0,0,0},
}

-- Read an 8x8 tile from CHR-RAM (PPU address space)
function read_chr_tile(ppu_addr)
  local pixels = {}
  for y = 0, 7 do
    local lo = ppu.readbyte(ppu_addr + y)
    local hi = ppu.readbyte(ppu_addr + y + 8)
    for x = 7, 0, -1 do
      local val = bit.band(bit.rshift(lo, x), 1) + bit.lshift(bit.band(bit.rshift(hi, x), 1), 1)
      table.insert(pixels, val)
    end
  end
  return pixels
end

-- Dump a range of tiles as a PPM image
function dump_tiles_ppm(filename, start_tile, num_tiles, palette, cols)
  cols = cols or 16
  local rows = math.ceil(num_tiles / cols)
  local w = cols * 8
  local h = rows * 8

  local f = io.open(filename, "wb")
  f:write(string.format("P6\n%d %d\n255\n", w, h))

  for row = 0, rows - 1 do
    for py = 0, 7 do
      for col = 0, cols - 1 do
        local tile_idx = row * cols + col
        if tile_idx < num_tiles then
          local ppu_addr = 0x1000 + (start_tile + tile_idx) * 16
          local lo = ppu.readbyte(ppu_addr + py)
          local hi = ppu.readbyte(ppu_addr + py + 8)
          for px = 7, 0, -1 do
            local val = bit.band(bit.rshift(lo, px), 1) + bit.lshift(bit.band(bit.rshift(hi, px), 1), 1)
            local nes_col = palette[val + 1] or 0x0F
            local rgb = nes_pal[nes_col] or {0,0,0}
            f:write(string.char(rgb[1], rgb[2], rgb[3]))
          end
        else
          for px = 0, 7 do
            f:write(string.char(0, 0, 0))
          end
        end
      end
    end
  end

  f:close()
  emu.message("Dumped " .. filename)
end

-- Dump entire sprite pattern table (tiles $00-$FF at PPU $1000-$1FFF)
function dump_full_sprite_table(filename)
  local f = io.open(filename, "wb")
  local w = 16 * 8  -- 16 tiles per row
  local h = 16 * 8  -- 16 rows
  f:write(string.format("P6\n%d %d\n255\n", w, h))

  -- Simple grayscale palette for raw dump
  local gray = {{0,0,0}, {85,85,85}, {170,170,170}, {255,255,255}}

  for row = 0, 15 do
    for py = 0, 7 do
      for col = 0, 15 do
        local tile = row * 16 + col
        local ppu_addr = 0x1000 + tile * 16
        local lo = ppu.readbyte(ppu_addr + py)
        local hi = ppu.readbyte(ppu_addr + py + 8)
        for px = 7, 0, -1 do
          local val = bit.band(bit.rshift(lo, px), 1) + bit.lshift(bit.band(bit.rshift(hi, px), 1), 1)
          local rgb = gray[val + 1]
          f:write(string.char(rgb[1], rgb[2], rgb[3]))
        end
      end
    end
  end

  f:close()
  emu.message("Dumped full sprite table: " .. filename)
end

-- Check if we're in battle by reading battle state from RAM
-- FF3 battle flag is at various RAM locations
-- $7D7A = battle scene type or similar
-- We'll check for specific PPU tile patterns that indicate battle mode

local press_count = 0
local state = "wait_title"
local state_timer = 0

function on_frame()
  frame_count = frame_count + 1
  state_timer = state_timer + 1

  -- Auto-play to get to a battle:
  -- 1. Wait for title screen, press Start
  -- 2. Select New Game
  -- 3. Wait for game to load
  -- 4. Walk around to trigger encounter

  if state == "wait_title" and frame_count > 120 then
    -- Press Start to skip title
    joypad.set(1, {start=true})
    if state_timer > 180 then
      state = "title_press"
      state_timer = 0
    end
  elseif state == "title_press" then
    -- Keep pressing A/Start to get through title
    if state_timer % 30 == 0 then
      joypad.set(1, {A=true, start=true})
      press_count = press_count + 1
    end
    if press_count > 20 then
      state = "in_game"
      state_timer = 0
    end
  elseif state == "in_game" then
    -- Walk around to trigger random encounter
    -- Alternate walking directions
    local dir = math.floor(state_timer / 30) % 4
    if dir == 0 then joypad.set(1, {up=true})
    elseif dir == 1 then joypad.set(1, {right=true})
    elseif dir == 2 then joypad.set(1, {down=true})
    else joypad.set(1, {left=true})
    end

    -- Check if battle started by reading battle RAM
    -- Battle state byte - check common battle indicators
    local battle_flag = memory.readbyte(0x0080) -- battle mode flag area
    if battle_flag > 0 and state_timer > 60 then
      state = "in_battle"
      state_timer = 0
      emu.message("Battle detected!")
    end
  elseif state == "in_battle" then
    -- Wait a bit then select Fight and attack
    if state_timer == 60 then
      joypad.set(1, {A=true}) -- select Fight
    elseif state_timer == 90 then
      joypad.set(1, {A=true}) -- confirm target
    elseif state_timer > 120 and not dumped then
      -- Dump CHR-RAM during hit animation
      dump_full_sprite_table("tools/chr-battle-sprites.ppm")
      -- Also dump tiles $40-$60 range specifically (hit effects area)
      dump_tiles_ppm("tools/chr-hit-tiles.ppm", 0x40, 32, {0x0F, 0x30, 0x10, 0x20}, 8)
      dumped = true
      emu.message("Tiles dumped! Exiting in 30 frames...")
    elseif dumped and state_timer > 160 then
      emu.exit()
    end
  end

  -- Safety: dump after 3000 frames regardless (50 seconds)
  if frame_count > 3000 and not dumped then
    dump_full_sprite_table("tools/chr-sprites-fallback.ppm")
    dumped = true
    emu.message("Fallback dump at frame " .. frame_count)
  end

  -- Hard exit after 4000 frames
  if frame_count > 4000 then
    emu.exit()
  end
end

emu.registerafter(on_frame)
emu.message("Hit tile dumper loaded - will auto-play to battle")
