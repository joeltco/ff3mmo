-- FCEUX Lua: trace unarmed punch animation v5
-- Fixes: force unequip via SRAM, monitor battle state RAM, proper menu nav
-- Run: fceux --loadlua tools/trace-punch-v5.lua "Final Fantasy III (Japan).nes"

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-trace-v5.txt", "w")
local frame_count = 0
local state = "title"
local battle_frame = 0
local last_sprite_hash = ""
local a_cooldown = 0  -- frames to wait before next A press

function log(msg)
  f:write(msg .. "\n")
  f:flush()
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

function log_sprites()
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

-- Force all 4 characters unarmed in SRAM
function unequip_all()
  for i = 0, 3 do
    local base = 0x6100 + i * 0x40
    memory.writebyte(base + 0x38, 0)  -- right hand = unarmed
    memory.writebyte(base + 0x39, 0)  -- left hand = unarmed
  end
  -- Also force battle RAM weapon IDs
  memory.writebyte(0x7E1F, 0)
  memory.writebyte(0x7E20, 0)
end

function log_battle_state()
  local mode = memory.readbyte(0x0040)
  local b6 = memory.readbyte(0xB6)
  local cd = memory.readbyte(0xCD)
  local char_slot = memory.readbyte(0x0052)
  local btn = memory.readbyte(0x0012)
  local cmd0 = memory.readbyte(0x78CF)
  local r_wpn = memory.readbyte(0x7E1F)
  local l_wpn = memory.readbyte(0x7E20)
  log(string.format("  state: mode=$%02X B6=$%02X CD=$%02X slot=%d btn=$%02X cmd0=$%02X wpn=%d/%d",
    mode, b6, cd, char_slot, btn, cmd0, r_wpn, l_wpn))
end

function on_frame()
  frame_count = frame_count + 1
  if a_cooldown > 0 then a_cooldown = a_cooldown - 1 end

  -- Phase 1: title screen (2400 frames = 40 sec to be safe for name entry etc.)
  if state == "title" then
    -- Mash A + Start every 4 frames
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count == 2400 then
      state = "unequip"
      log("=== Done title mashing, unequipping ===")
    end
    return
  end

  -- Phase 2: unequip and start walking
  if state == "unequip" then
    unequip_all()
    log("=== Weapons zeroed, walking ===")
    state = "walking"
    return
  end

  -- Phase 3: walk to trigger encounter
  if state == "walking" then
    -- Keep unequipping every frame during walking (in case game re-equips)
    unequip_all()

    local dir = math.floor(frame_count / 12) % 4
    if dir == 0 then joypad.set(1, {right=true})
    elseif dir == 1 then joypad.set(1, {up=true})
    elseif dir == 2 then joypad.set(1, {left=true})
    else joypad.set(1, {down=true})
    end

    local mode = memory.readbyte(0x0040)
    if mode >= 0x80 then
      state = "battle_init"
      battle_frame = 0
      log(string.format("=== BATTLE at frame %d, mode=$%02X ===", frame_count, mode))
      log_battle_state()
    end

    if frame_count > 6000 then
      log("=== TIMEOUT walking ===")
      f:close()
      emu.exit()
    end
    return
  end

  -- Phase 4: battle init - wait for menu, keep forcing unarmed
  if state == "battle_init" then
    battle_frame = battle_frame + 1
    unequip_all()

    -- Log state every 30 frames
    if battle_frame % 30 == 0 then
      log(string.format("--- battle_init frame %d ---", battle_frame))
      log_battle_state()
    end

    -- Wait 180 frames (3 sec) for battle init (intro animations, music, etc.)
    if battle_frame >= 180 then
      state = "commanding"
      battle_frame = 0
      a_cooldown = 0
      log("=== Init done, commanding characters ===")
      log_battle_state()
    end
    return
  end

  -- Phase 5: navigate battle commands for all 4 characters
  -- Each char needs: A (select Fight) then A (confirm target)
  -- Monitor char slot to track progress
  if state == "commanding" then
    battle_frame = battle_frame + 1
    unequip_all()

    local char_slot = memory.readbyte(0x0052)
    local b6 = memory.readbyte(0xB6)

    -- Log every 10 frames
    if battle_frame % 10 == 0 then
      log(string.format("--- commanding frame %d ---", battle_frame))
      log_battle_state()
    end

    -- Press A every 20 frames (gives game time to process each step)
    if a_cooldown == 0 then
      joypad.set(1, {A=true})
      a_cooldown = 20
      log(string.format("  >> A pressed at cmd frame %d, slot=%d", battle_frame, char_slot))
    end

    -- If B6 changes from $04, animation might be starting
    if b6 ~= 0x04 and battle_frame > 10 then
      state = "animating"
      battle_frame = 0
      log(string.format("=== ANIMATION DETECTED B6=$%02X ===", b6))
      log_battle_state()
    end

    -- After 400 frames of commanding (20 sec), something is wrong
    if battle_frame > 400 then
      log("=== Commanding timeout, trying wider A spam ===")
      state = "spam_a"
      battle_frame = 0
    end
    return
  end

  -- Fallback: spam A faster
  if state == "spam_a" then
    battle_frame = battle_frame + 1
    unequip_all()

    if battle_frame % 6 == 0 then
      joypad.set(1, {A=true})
    end

    local b6 = memory.readbyte(0xB6)
    if b6 ~= 0x04 and battle_frame > 5 then
      state = "animating"
      battle_frame = 0
      log(string.format("=== ANIMATION (spam) B6=$%02X ===", b6))
    end

    if battle_frame % 30 == 0 then
      log(string.format("--- spam frame %d ---", battle_frame))
      log_battle_state()
    end

    if battle_frame > 600 then
      log("=== TOTAL TIMEOUT ===")
      f:close()
      emu.exit()
    end
    return
  end

  -- Phase 6: capture animation sprites
  if state == "animating" then
    battle_frame = battle_frame + 1

    local b6 = memory.readbyte(0xB6)
    local cd = memory.readbyte(0xCD)
    local h = sprite_hash()

    -- Log every sprite change
    if h ~= last_sprite_hash then
      log(string.format("--- anim frame %d B6=$%02X CD=$%02X ---", battle_frame, b6, cd))
      log_sprites()
      last_sprite_hash = h
    end

    -- Capture for 300 frames (5 sec should cover full attack sequence)
    if battle_frame >= 300 then
      log("=== Done capturing ===")
      f:close()
      emu.exit()
    end
    return
  end

  -- Hard timeout
  if frame_count > 10000 then
    log("=== HARD TIMEOUT ===")
    f:close()
    emu.exit()
  end
end

emu.registerbefore(on_frame)
log("Punch trace v5 - unarmed, RAM-monitored")
