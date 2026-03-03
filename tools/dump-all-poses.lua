-- FCEUX Lua: brute force dump PPU tiles every 60 frames during battle
-- Also dumps after battle for victory pose (waits for valid palette)
-- Output: tools/all-poses-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/all-poses-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local battle_start = 0
local prev_mode = 0
local dump_count = 0
local victory_dumped = false

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
  emu.message("Done! " .. dump_count .. " dumps")
end

function dump_tiles(label)
  dump_count = dump_count + 1
  log("=== " .. label .. " (dump #" .. dump_count .. ") ===")
  local base = 0x1000
  for tile = 0x00, 0x3F do
    local addr = base + tile * 16
    local hex = ""
    for b = 0, 15 do
      hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
    end
    log(string.format("  $%02X: %s", tile, hex))
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
      log(string.format("[%d] Battle start", frame))
    end
    if frame > 18000 then finish() end
    prev_mode = mode
    return
  end

  if state == "battle_wait" then
    joypad.set(1, {})
    if frame - battle_start >= 120 then
      state = "fighting"
      emu.message("Fighting...")
      log(string.format("[%d] Fighting", frame))
    end
    prev_mode = mode
    return
  end

  if state == "fighting" then
    if mode ~= 0x20 then
      state = "victory_wait"
      battle_start = frame
      joypad.set(1, {})
      log(string.format("[%d] Battle ended mode=$%02X", frame, mode))
      emu.message("Victory wait...")
      prev_mode = mode
      return
    end

    -- Press A every 30 frames
    if frame % 30 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Dump tiles every 60 frames during battle
    if (frame - battle_start) % 60 == 0 then
      -- Check char1 position for context
      local cx = "?"
      for i = 0, 63 do
        local b = 0x0200 + i * 4
        local y = memory.readbyte(b)
        local t = memory.readbyte(b + 1)
        if t == 0x01 and y > 30 and y < 60 then
          cx = memory.readbyte(b + 3)
          break
        end
      end
      log(string.format("[%d] BATTLE DUMP (char1 x=%s)", frame, tostring(cx)))
      dump_tiles("BATTLE f=" .. (frame - battle_start))
    end

    if frame - battle_start > 18000 then finish() end
    prev_mode = mode
    return
  end

  if state == "victory_wait" then
    joypad.set(1, {})

    -- Wait for valid palette (not all $0F) before dumping
    if not victory_dumped then
      local pal0_1 = ppu.readbyte(0x3F11)
      if pal0_1 ~= 0x0F and frame - battle_start >= 30 then
        log(string.format("[%d] VICTORY DUMP (pal0[1]=$%02X)", frame, pal0_1))
        dump_tiles("VICTORY")
        victory_dumped = true
      end
    end

    if frame - battle_start > 600 then
      if not victory_dumped then
        log(string.format("[%d] VICTORY FALLBACK", frame))
        dump_tiles("VICTORY FALLBACK")
        victory_dumped = true
      end
      finish()
    end

    if victory_dumped and frame - battle_start > 120 then
      finish()
    end
    prev_mode = mode
    return
  end

  prev_mode = mode
end

emu.registerbefore(on_frame)
log("Brute force pose dump (every 60f during battle + victory)")
emu.message("Brute force dump loaded")
