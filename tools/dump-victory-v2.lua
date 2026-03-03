-- FCEUX Lua: capture victory pose tiles with valid palette
-- Monitors tile $01 data every frame after battle, dumps when it changes + palette valid
-- Output: tools/victory-dump-v2.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/victory-dump-v2.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local battle_start = 0
local idle_tile01 = nil
local victory_dumped = false
local tile_change_logged = false

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  log("=== DONE ===")
  f:close()
  emu.message("Done! Check victory-dump-v2.txt")
end

function get_tile_hex(tile_id)
  local addr = 0x1000 + tile_id * 16
  local hex = ""
  for b = 0, 15 do
    hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
  end
  return hex
end

function dump_tiles(label)
  log("=== " .. label .. " ===")
  for tile = 0x00, 0x3F do
    log(string.format("  $%02X: %s", tile, get_tile_hex(tile)))
  end
  log("-- OAM --")
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y > 0 and y < 240 then
      local x = memory.readbyte(b + 3)
      local t = memory.readbyte(b + 1)
      local a = memory.readbyte(b + 2)
      log(string.format("  spr%02d: x=%3d y=%3d t=$%02X a=$%02X", i, x, y, t, a))
    end
  end
  log("-- Sprite palettes --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
  end
end

function zero_weapons()
  for c = 0, 3 do
    local base = 0x6100 + c * 0x40
    memory.writebyte(base + 0x38, 0x00)
    memory.writebyte(base + 0x39, 0x00)
  end
  memory.writebyte(0x7E1F, 0x00)
  memory.writebyte(0x7E20, 0x00)
end

function on_frame()
  if done then return end
  frame = frame + 1
  zero_weapons()
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if frame % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame >= 1500 then
      state = "walking"
      emu.message("Walking...")
      log(string.format("[%d] Walking", frame))
    end
    return
  end

  if state == "walking" then
    local dir = math.floor(frame / 12) % 4
    if dir == 0 then joypad.set(1, {right=true})
    elseif dir == 1 then joypad.set(1, {up=true})
    elseif dir == 2 then joypad.set(1, {left=true})
    else joypad.set(1, {down=true})
    end
    if mode == 0x20 then
      state = "battle_wait"
      battle_start = frame
      emu.message("Battle!")
      log(string.format("[%d] Battle start", frame))
    end
    if frame > 18000 then finish() end
    return
  end

  if state == "battle_wait" then
    joypad.set(1, {})
    if frame - battle_start >= 120 then
      state = "fighting"
      idle_tile01 = get_tile_hex(0x01)
      emu.message("Fighting (idle stored)")
      log(string.format("[%d] Fighting, idle $01=%s", frame, idle_tile01))
    end
    return
  end

  if state == "fighting" then
    if mode ~= 0x20 then
      state = "victory_wait"
      battle_start = frame
      joypad.set(1, {})
      log(string.format("[%d] Battle ended mode=$%02X", frame, mode))
      emu.message("Victory wait...")
      return
    end
    -- Press A every 30 frames to advance battle
    if frame % 30 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end
    if frame - battle_start > 18000 then finish() end
    return
  end

  if state == "victory_wait" then
    -- Press A every 120 frames to advance victory text (but not too fast)
    if frame % 120 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    if not victory_dumped then
      local current = get_tile_hex(0x01)
      local pal0_1 = ppu.readbyte(0x3F11)

      if current ~= idle_tile01 then
        if pal0_1 ~= 0x0F then
          -- IDEAL: tile changed + valid palette
          log(string.format("[%d] VICTORY FOUND: tile changed + pal0[1]=$%02X", frame, pal0_1))
          log(string.format("  idle $01: %s", idle_tile01))
          log(string.format("  victory $01: %s", current))
          dump_tiles("VICTORY POSE")
          victory_dumped = true
        else
          -- Tile changed but palette still fading
          if not tile_change_logged then
            log(string.format("[%d] tile $01 changed (pal=$0F, waiting for fade-in...)", frame))
            log(string.format("  idle: %s", idle_tile01))
            log(string.format("  curr: %s", current))
            tile_change_logged = true
          end
        end
      else
        -- Tile still matches idle
        if tile_change_logged then
          -- It reverted! Log this
          log(string.format("[%d] WARNING: tile $01 reverted to idle!", frame))
          tile_change_logged = false
        end
        -- Even if tile hasn't changed, check if palette is valid
        -- (victory tiles might load later)
        if pal0_1 ~= 0x0F and frame - battle_start >= 180 then
          log(string.format("[%d] Valid palette ($%02X) but tile unchanged after 180f", frame, pal0_1))
          -- Don't dump yet, keep waiting for tile change
        end
      end
    end

    -- Timeout after 1200 frames (20 seconds)
    if frame - battle_start > 1200 then
      if not victory_dumped then
        log(string.format("[%d] TIMEOUT — dumping fallback", frame))
        dump_tiles("VICTORY FALLBACK")
        victory_dumped = true
      end
      finish()
    end

    if victory_dumped and frame - battle_start > 300 then
      finish()
    end
    return
  end
end

emu.registerbefore(on_frame)
log("Victory pose capture v2 (tile change detection)")
emu.message("Victory v2 loaded")
