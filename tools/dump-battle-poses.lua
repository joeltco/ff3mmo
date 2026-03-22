-- FCEUX Lua: dump PPU tiles for attack pose AND damage-taken pose
-- Auto-plays through title, walks into encounter, captures tiles during:
--   1. Player attack (tile $39 appears in OAM)
--   2. Enemy attack / damage taken (char1 spr00 y-position shakes from 43)
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
local prev_char_hp = {-1,-1,-1,-1}  -- track char HP to detect hits
local name_timer = 0    -- timer within a single name entry sequence
local last_mode = 0xFF  -- previous frame's mode, for edge detection

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

-- Find char1's top-left sprite (tile $01, pal0, y~43) → return its current y
function get_char1_y()
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    local t = memory.readbyte(b + 1)
    local a = memory.readbyte(b + 2)
    local x = memory.readbyte(b + 3)
    -- char1 TL sprite: tile $01, pal0 (a&3==0), x around 200-220, y around 30-60
    if t == 0x01 and bit.band(a, 3) == 0 and x >= 190 and x <= 230 and y >= 30 and y <= 70 then
      return y, x
    end
  end
  return nil, nil
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

-- Keep all monsters alive (HP at $7675 + m*$40 + $03/04)
-- Only touch slots with max HP > 0 (active enemies)
function keep_monsters_alive()
  for m = 0, 7 do
    local base = 0x7675 + m * 0x40
    local maxhp = memory.readbyte(base + 0x05)
    if maxhp > 0 then
      memory.writebyte(base + 0x03, 0xFF)
      memory.writebyte(base + 0x04, 0x00)
    end
  end
end

function on_frame()
  if done then return end
  frame = frame + 1
  zero_weapons()
  keep_monsters_alive()
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    -- Detect entry into name entry screen (mode $A8)
    if mode == 0xA8 then
      -- Name entry: repeat Down x7 then A every 120 frames (handles all 4 characters)
      if last_mode ~= 0xA8 then
        name_timer = 0
        log(string.format("[%d] Name entry screen", frame))
      end
      name_timer = name_timer + 1
      local t = name_timer % 120
      joypad.set(1, {})
      -- Explicit sequence. Cursor persists between chars so 1 Down per char (after char 1)
      -- advances to next row: A→F→K→P  (unique names)
      -- Each char: 6 A presses fills all slots → auto-confirms
      -- Char 1: A at t=20,28,36,44,52,60
      -- Wait 120 frames for transition (char 2 screen ~t=90)
      -- Char 2: Down at t=180, A at t=195,203,211,219,227,235
      -- Wait 120 frames (char 3 ~t=265)
      -- Char 3: Down at t=355, A at t=370,378,386,394,402,410
      -- Wait 120 frames (char 4 ~t=440)
      -- Char 4: Down at t=530, A at t=545,553,561,569,577,585
      -- 7th A press per char = confirm (hits auto-selected End after name is full)
      local seq = {
        [20]="A",[28]="A",[36]="A",[44]="A",[52]="A",[60]="A",[70]="A",
        [190]="D",
        [205]="A",[213]="A",[221]="A",[229]="A",[237]="A",[245]="A",[255]="A",
        [375]="D",
        [390]="A",[398]="A",[406]="A",[414]="A",[422]="A",[430]="A",[440]="A",
        [560]="D",
        [575]="A",[583]="A",[591]="A",[599]="A",[607]="A",[615]="A",[625]="A",
      }
      local act = seq[name_timer]
      if act == "A" then
        joypad.set(1, {A=true})
        if name_timer == 195 or name_timer == 370 or name_timer == 545 then
          log(string.format("[%d] Filling char name (t=%d)", frame, name_timer))
        end
      elseif act == "D" then
        joypad.set(1, {down=true})
      end
    else
      -- Not name entry: mash A+start to advance
      if frame % 4 < 2 then
        joypad.set(1, {A=true, start=true})
      else
        joypad.set(1, {})
      end
    end

    -- Log mode changes
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    -- Once name entry is done (name_timer > 700) and mode left $A8,
    -- switch to press-A-forever state — no need to detect exact battle mode
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      battle_start = frame
      log(string.format("[%d] Past name entry, mode=$%02X — pressing A", frame, mode))
      emu.message("Pressing A...")
    end
    last_mode = mode
    prev_mode = mode
    return
  end

  if state == "pressing" then
    -- Mash A: press on even frames, release on odd (game needs press+release)
    if frame % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end
    -- Log mode changes
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    -- Dump tiles every 60 frames to catch any animation
    local elapsed = frame - battle_start
    if elapsed > 60 and elapsed % 60 == 0 then
      dump_tiles("PERIODIC f=" .. elapsed)
    end
    -- Detect attack pose: tile $39 in OAM
    if not got_attack then
      for i = 0, 63 do
        local b = 0x0200 + i * 4
        local y = memory.readbyte(b)
        local t = memory.readbyte(b + 1)
        local x = memory.readbyte(b + 3)
        if y > 0 and y < 240 and t == 0x39 then
          log(string.format("[%d] ATTACK POSE: spr%d x=%d y=%d", frame, i, x, y))
          dump_tiles("ATTACK POSE")
          got_attack = true
          break
        end
      end
    end
    -- Detect player being hit: watch for HP decrease on any character
    -- Only after got_attack=true so we know battle is active (not prologue init)
    if not got_hit and got_attack then
      for c = 0, 3 do
        local hp = memory.readbyte(0x7575 + c * 0x40 + 0x03)
        if prev_char_hp[c+1] >= 0 and hp < prev_char_hp[c+1] and prev_char_hp[c+1] < 200 then
          log(string.format("[%d] CHAR %d HIT: hp %d->%d", frame, c, prev_char_hp[c+1], hp))
          dump_tiles("PLAYER HIT char" .. c)
          got_hit = true
        end
        prev_char_hp[c+1] = hp
      end
    end
    if got_attack and got_hit then
      finish()
      return
    end
    if frame > 72000 then
      log("TIMEOUT")
      finish()
    end
    last_mode = mode
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
      -- Snapshot char1 idle y so we know baseline
      local y, x = get_char1_y()
      if y then
        prev_char1_y = y
        log(string.format("[%d] Fighting — char1 baseline y=%d x=%d", frame, y, x))
      end
    end
    prev_mode = mode
    return
  end

  if state == "fighting" then
    -- Only end on field mode ($05), ignore transient states like $FF
    if mode == 0x05 then
      state = "done_wait"
      battle_start = frame
      log(string.format("[%d] Battle ended mode=$%02X", frame, mode))
      prev_mode = mode
      return
    end

    -- Press A every 60 frames to select Fight (confirm menu choices)
    local elapsed = frame - battle_start
    if elapsed % 60 == 0 then
      joypad.set(1, {A=true})
    elseif elapsed % 60 == 1 then
      joypad.set(1, {})
    end

    -- Detect attack pose: any OAM sprite tile $39
    if not got_attack then
      for i = 0, 63 do
        local b = 0x0200 + i * 4
        local y = memory.readbyte(b)
        local t = memory.readbyte(b + 1)
        local x = memory.readbyte(b + 3)
        if y > 0 and y < 240 and t == 0x39 then
          log(string.format("[%d] ATTACK POSE: spr%d x=%d y=%d", frame, i, x, y))
          dump_tiles("ATTACK POSE")
          got_attack = true
          break
        end
      end
    end

    -- Detect damage taken: char1 TL sprite y-position deviates from baseline
    -- During hit animation NES shakes the sprite ±1-4 pixels
    local cur_y, cur_x = get_char1_y()
    if not got_hit and cur_y then
      if prev_char1_y > 0 and cur_y ~= prev_char1_y then
        local diff = math.abs(cur_y - prev_char1_y)
        if diff >= 1 and diff <= 8 then
          log(string.format("[%d] DAMAGE TAKEN: char1 y=%d (was %d, diff=%d) x=%d", frame, cur_y, prev_char1_y, diff, cur_x))
          dump_tiles("DAMAGE TAKEN")
          got_hit = true
        end
      end
      prev_char1_y = cur_y
    end

    -- Brute-force: dump tiles every 30 frames to catch hit pose
    local elapsed = frame - battle_start
    if elapsed > 120 and elapsed % 30 == 0 and elapsed <= 3600 then
      dump_tiles("PERIODIC f=" .. elapsed)
    end

    if got_attack and got_hit then
      state = "done_wait"
      battle_start = frame
    end

    if frame - battle_start > 14400 then
      log("TIMEOUT — got_attack=" .. tostring(got_attack) .. " got_hit=" .. tostring(got_hit))
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

-- Try to load save state slot 1 (battle start) to skip name entry
-- If the state exists, we'll jump straight to battle detection
local ok, err = pcall(function() emu.loadstate(1) end)
if ok then
  state = "battle_wait"
  battle_start = 0
  log("[Loaded save state slot 1 — skipping name entry]")
  emu.message("Save state loaded — in battle!")
else
  emu.message("No save state — running from title")
end
