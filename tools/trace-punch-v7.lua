-- FCEUX Lua: trace unarmed punch v7
-- Fix: NO directional input during battle (was switching target to allies)
-- Only press A with clean frames between presses

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-trace-v7.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_frame = 0
local a_cooldown = 0
local last_sprite_hash = ""
local state = "title"

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  f:close()
end

function sprite_hash()
  local h = ""
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y > 0 and y < 240 then
      h = h .. string.format("%02X%02X", memory.readbyte(base+1), memory.readbyte(base+2))
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
      log(string.format("  spr%02d: x=%3d y=%3d tile=$%02X attr=$%02X", i, x, y, tile, attr))
    end
  end
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

function on_frame()
  if done then return end
  frame_count = frame_count + 1
  if a_cooldown > 0 then a_cooldown = a_cooldown - 1 end

  local mode = memory.readbyte(0x0040)

  -- Log mode changes
  if mode ~= last_mode then
    log(string.format("[frame %d] mode: $%02X -> $%02X (state=%s)",
      frame_count, last_mode >= 0 and last_mode or 0, mode, state))
    last_mode = mode
  end

  -- === TITLE: mash A+Start ===
  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
      log("=== Title done ===")
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

    -- Detect battle
    if mode >= 0x03 and frame_count > 1560 then
      state = "battle_clear"
      battle_frame = 0
      log(string.format("=== Battle detected frame=%d mode=$%02X ===", frame_count, mode))
    end

    if frame_count > 8000 then
      log("=== TIMEOUT ===")
      finish()
    end
    return
  end

  -- === BATTLE_CLEAR: release ALL buttons for 60 frames to flush stale input ===
  if state == "battle_clear" then
    battle_frame = battle_frame + 1
    unequip_all()
    -- Explicitly set NO buttons (clear any stale directional input)
    joypad.set(1, {})

    if battle_frame % 30 == 0 then
      log(string.format("  clear: bf=%d mode=$%02X", battle_frame, mode))
    end

    -- If mode drops back, false positive
    if mode < 0x03 and battle_frame > 30 then
      state = "walking"
      log("=== False detect, back to walking ===")
      return
    end

    -- Wait 240 frames (4 sec) with NO input for battle to fully init
    if battle_frame >= 240 then
      state = "commanding"
      battle_frame = 0
      a_cooldown = 0
      log("=== Cleared, commanding (A only, no directions) ===")
    end
    return
  end

  -- === COMMANDING: ONLY press A, never any direction ===
  if state == "commanding" then
    battle_frame = battle_frame + 1
    unequip_all()

    -- IMPORTANT: on non-A frames, explicitly clear all input
    -- This ensures no directional bleed from any source
    if a_cooldown == 0 then
      -- Press A this frame
      joypad.set(1, {A=true})
      a_cooldown = 20  -- wait 20 frames before next A
      log(string.format("  >> A at bf=%d mode=$%02X", battle_frame, mode))
    else
      -- Clear frame - NO buttons at all
      joypad.set(1, {})
    end

    -- Log state periodically
    if battle_frame % 30 == 0 then
      local b6 = memory.readbyte(0xB6)
      local cd = memory.readbyte(0xCD)
      local slot = memory.readbyte(0x0052)
      log(string.format("  cmd: bf=%d mode=$%02X B6=$%02X CD=$%02X slot=%d",
        battle_frame, mode, b6, cd, slot))
    end

    -- After enough A presses (8 needed for 4 chars × fight+target), start capturing
    -- 8 presses × 20 frame spacing = 160 frames, wait a bit more
    if battle_frame > 200 then
      state = "capturing"
      battle_frame = 0
      last_sprite_hash = ""
      log("=== Commands sent, capturing animation ===")
    end
    return
  end

  -- === CAPTURING: log all sprite changes during attack animations ===
  if state == "capturing" then
    battle_frame = battle_frame + 1

    local b6 = memory.readbyte(0xB6)
    local cd = memory.readbyte(0xCD)
    local h = sprite_hash()

    if h ~= last_sprite_hash then
      log(string.format("--- anim bf=%d B6=$%02X CD=$%02X mode=$%02X ---",
        battle_frame, b6, cd, mode))
      log_sprites()
      last_sprite_hash = h
    end

    -- Don't press anything during capture - just watch
    joypad.set(1, {})

    if battle_frame > 600 then
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
log("Punch trace v7 - no directional bleed")
