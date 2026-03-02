-- FCEUX Lua: trace unarmed punch v6
-- Diagnostic: log game mode ($0040) throughout to find battle properly
-- Also: protect against writing to closed file

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-trace-v6.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_detected = false
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

  -- Always log mode changes
  if mode ~= last_mode then
    log(string.format("[frame %d] mode changed: $%02X -> $%02X (state=%s)",
      frame_count, last_mode >= 0 and last_mode or 0, mode, state))
    last_mode = mode
  end

  -- === TITLE: mash A+Start for 1500 frames (25 sec) ===
  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
      log(string.format("=== Title done at frame %d, mode=$%02X ===", frame_count, mode))
    end
    return
  end

  -- === WALKING: unequip + walk + detect battle ===
  if state == "walking" then
    unequip_all()

    local dir = math.floor(frame_count / 12) % 4
    if dir == 0 then joypad.set(1, {right=true})
    elseif dir == 1 then joypad.set(1, {up=true})
    elseif dir == 2 then joypad.set(1, {left=true})
    else joypad.set(1, {down=true})
    end

    -- Try multiple detection methods for battle
    -- Method 1: mode >= $80
    -- Method 2: check for monster sprite tiles appearing in OAM
    -- Log periodically so we can see what's happening
    if frame_count % 120 == 0 then
      local char_slot = memory.readbyte(0x0052)
      local b6 = memory.readbyte(0xB6)
      log(string.format("  walk: frame=%d mode=$%02X B6=$%02X slot=%d",
        frame_count, mode, b6, char_slot))
    end

    -- Detect battle: mode byte changes significantly during battle transition
    -- In FF3, walking mode is typically low ($00-$0F range)
    -- Battle mode is higher
    if mode >= 0x03 and frame_count > 1560 then
      -- Might be battle or transition - log more detail
      local b6 = memory.readbyte(0xB6)
      local char_slot = memory.readbyte(0x0052)
      log(string.format("=== Possible battle: frame=%d mode=$%02X B6=$%02X slot=%d ===",
        frame_count, mode, b6, char_slot))
      state = "battle_wait"
      battle_frame = 0
    end

    if frame_count > 8000 then
      log("=== TIMEOUT walking ===")
      finish()
      return
    end
    return
  end

  -- === BATTLE_WAIT: let battle init finish, keep unequipping ===
  if state == "battle_wait" then
    battle_frame = battle_frame + 1
    unequip_all()

    if battle_frame % 30 == 0 then
      local b6 = memory.readbyte(0xB6)
      local char_slot = memory.readbyte(0x0052)
      local btn = memory.readbyte(0x0012)
      log(string.format("  wait: bf=%d mode=$%02X B6=$%02X slot=%d btn=$%02X",
        battle_frame, mode, b6, char_slot, btn))
    end

    -- If mode drops back below 3, it was a false positive (room transition etc.)
    if mode < 0x03 and battle_frame > 30 then
      log("=== False battle detect, back to walking ===")
      state = "walking"
      return
    end

    -- After 180 frames, start commanding
    if battle_frame >= 180 then
      state = "commanding"
      battle_frame = 0
      a_cooldown = 0
      log("=== Init done, commanding ===")
    end
    return
  end

  -- === COMMANDING: press A to navigate Fight -> Target for all 4 chars ===
  if state == "commanding" then
    battle_frame = battle_frame + 1
    unequip_all()

    local b6 = memory.readbyte(0xB6)
    local char_slot = memory.readbyte(0x0052)

    if battle_frame % 15 == 0 then
      local btn = memory.readbyte(0x0012)
      log(string.format("  cmd: bf=%d mode=$%02X B6=$%02X slot=%d btn=$%02X",
        battle_frame, mode, b6, char_slot, btn))
    end

    -- Press A every 15 frames
    if a_cooldown == 0 then
      joypad.set(1, {A=true})
      a_cooldown = 15
      log(string.format("  >> A at cmd frame %d", battle_frame))
    end

    -- Detect animation: look for B6 changing, new sprite tiles, etc.
    local h = sprite_hash()
    if h ~= last_sprite_hash and battle_frame > 30 then
      -- Sprite set changed - might be animation
      last_sprite_hash = h
    end

    if battle_frame > 600 then
      state = "spam_and_capture"
      battle_frame = 0
      log("=== Command timeout, spam + capture everything ===")
    end
    return
  end

  -- === SPAM_AND_CAPTURE: press A faster, log all sprite changes ===
  if state == "spam_and_capture" then
    battle_frame = battle_frame + 1

    if battle_frame % 4 == 0 then
      joypad.set(1, {A=true})
    end

    local b6 = memory.readbyte(0xB6)
    local cd = memory.readbyte(0xCD)
    local h = sprite_hash()

    if h ~= last_sprite_hash then
      log(string.format("--- sc frame %d B6=$%02X CD=$%02X mode=$%02X ---",
        battle_frame, b6, cd, mode))
      log_sprites()
      last_sprite_hash = h
    end

    if battle_frame > 600 then
      log("=== Done ===")
      finish()
      return
    end
    return
  end

  -- Hard timeout
  if frame_count > 12000 then
    log("=== HARD TIMEOUT ===")
    finish()
  end
end

emu.registerbefore(on_frame)
log("Punch trace v6")
