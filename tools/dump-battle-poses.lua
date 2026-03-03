-- FCEUX Lua: dump PPU tiles for attack pose AND damage-taken pose
-- Auto-plays through title, walks into encounter, captures tiles during:
--   1. Player attack (tile $39 appears in OAM during mode $20)
--   2. Enemy attack / damage taken (player y-position shakes)
-- Output: tools/battle-poses-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/battle-poses-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local battle_start = 0
local prev_mode = 0
local got_attack = false
local got_hit = false
local prev_char1_y = 0

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
  emu.message("Done! Check battle-poses-dump.txt")
end

function dump_tiles(label)
  log("=== " .. label .. " ===")
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
      log(string.format("[%d] Battle start", frame))
    end
    if frame > 12000 then finish() end
    prev_mode = mode
    return
  end

  if state == "battle_wait" then
    joypad.set(1, {})
    if frame - battle_start >= 120 then
      state = "fighting"
      emu.message("Fighting...")
    end
    prev_mode = mode
    return
  end

  if state == "fighting" then
    if mode ~= 0x20 then
      -- Battle ended
      state = "done_wait"
      battle_start = frame
      log(string.format("[%d] Battle ended mode=$%02X", frame, mode))
      prev_mode = mode
      return
    end

    -- Press A every 30 frames
    if frame % 30 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Check OAM for attack pose: any sprite with tile $39 while in mode $20
    if not got_attack then
      for i = 0, 63 do
        local b = 0x0200 + i * 4
        local y = memory.readbyte(b)
        local t = memory.readbyte(b + 1)
        local x = memory.readbyte(b + 3)
        -- Attack pose: tile $39, character x < 208 (moved forward from idle position)
        if y > 0 and y < 240 and t == 0x39 and x < 205 then
          log(string.format("[%d] ATTACK POSE found: spr%d x=%d y=%d t=$%02X", frame, i, x, y, t))
          dump_tiles("ATTACK POSE")
          got_attack = true
          break
        end
      end
    end

    -- Check for damage taken: char 1 (spr40) y-position changes (shake)
    -- Normal char1 y=43. During shake it shifts by ±1-2
    local char1_b = 0x0200 + 40 * 4
    local char1_y = memory.readbyte(char1_b)
    if not got_hit and got_attack and char1_y > 0 and char1_y < 240 then
      if prev_char1_y > 0 and math.abs(char1_y - prev_char1_y) >= 1 and math.abs(char1_y - 43) >= 1 then
        log(string.format("[%d] DAMAGE TAKEN: char1 y=%d (was %d)", frame, char1_y, prev_char1_y))
        dump_tiles("DAMAGE TAKEN")
        got_hit = true
      end
      prev_char1_y = char1_y
    end

    -- If we got both, we're done
    if got_attack and got_hit then
      state = "done_wait"
      battle_start = frame
    end

    if frame - battle_start > 14400 then
      log("TIMEOUT")
      if not got_attack then dump_tiles("TIMEOUT FALLBACK") end
      finish()
    end
    prev_mode = mode
    return
  end

  if state == "done_wait" then
    joypad.set(1, {})
    if frame - battle_start > 60 then finish() end
    prev_mode = mode
    return
  end

  prev_mode = mode
end

emu.registerbefore(on_frame)
log("Battle poses dump (attack + damage taken)")
emu.message("Battle poses dump loaded")
