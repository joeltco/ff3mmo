-- FCEUX Lua: dump PPU tiles during victory pose
-- Stops all input the instant mode leaves $20, waits for $1E, dumps

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/victory-tile-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local battle_start = 0
local dumped = false
local prev_mode = 0
local victory_start = 0

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
  emu.message("Done! Check victory-tile-dump.txt")
end

function dump_tiles()
  log("=== PPU TILE DUMP ===")
  local base = 0x1000
  for tile = 0x00, 0x3F do
    local addr = base + tile * 16
    local hex = ""
    for b = 0, 15 do
      hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
    end
    log(string.format("  $%02X: %s", tile, hex))
  end
  log("-- Sprite palettes --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
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
end

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  if mode ~= prev_mode then
    log(string.format("[%d] MODE $%02X -> $%02X", frame, prev_mode, mode))
  end

  if state == "title" then
    if frame % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame >= 1500 then
      state = "walking"
      emu.message("Walking...")
    end
    prev_mode = mode
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
    end
    if frame > 12000 then finish() end
    prev_mode = mode
    return
  end

  if state == "battle_wait" then
    joypad.set(1, {})
    if frame - battle_start >= 120 then
      state = "fighting"
      emu.message("Fighting (slow A)...")
    end
    prev_mode = mode
    return
  end

  if state == "fighting" then
    if mode == 0x20 then
      -- Press A every 30 frames (slow — don't spam through victory)
      if frame % 30 == 0 then
        joypad.set(1, {A=true})
      else
        joypad.set(1, {})
      end
    else
      -- Mode left $20! Stop ALL input immediately
      joypad.set(1, {})
      state = "victory_wait"
      victory_start = frame
      log(string.format("[%d] Battle ended, waiting for tiles (mode=$%02X)", frame, mode))
      emu.message("Victory! Waiting to dump...")
    end

    if frame - battle_start > 14400 then
      log("TIMEOUT"); finish()
    end
    prev_mode = mode
    return
  end

  if state == "victory_wait" then
    -- No input at all — let victory sequence play
    joypad.set(1, {})

    -- Dump 40 frames after leaving mode $20
    if not dumped and frame - victory_start >= 40 then
      dump_tiles()
      dumped = true
      state = "finishing"
      battle_start = frame
      emu.message("Dumped!")
    end

    if frame - victory_start > 600 then
      if not dumped then dump_tiles(); dumped = true end
      finish()
    end
    prev_mode = mode
    return
  end

  if state == "finishing" then
    if frame - battle_start > 60 then finish() end
    prev_mode = mode
    return
  end

  prev_mode = mode
end

emu.registerbefore(on_frame)
log("Victory tile dump v4 (slow A, stop on mode change)")
emu.message("Victory dump v4 loaded")
