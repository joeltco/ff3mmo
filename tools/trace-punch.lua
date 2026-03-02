-- FCEUX Lua: trace battle punch animation v4
-- Strategy: mash A every few frames through entire battle, log all OAM changes

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-trace.txt", "w")
local frame_count = 0
local in_battle = false
local last_sprite_hash = ""

function log(msg)
  f:write(msg .. "\n")
  f:flush()
end

function sprite_hash()
  -- Hash of visible OAM to detect changes
  local h = ""
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y > 0 and y < 240 then
      local tile = memory.readbyte(base + 1)
      h = h .. string.format("%02X", tile)
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

function on_frame()
  frame_count = frame_count + 1

  -- Phase 1: mash A/Start to get through title (first 1200 frames = 20 sec)
  if frame_count <= 1200 then
    if frame_count % 3 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count == 1200 then
      log("=== Done title mashing, starting walk ===")
    end
    return
  end

  -- Phase 2: walk to trigger encounter (frames 1200-3000)
  if frame_count <= 3000 and not in_battle then
    local dir = math.floor(frame_count / 10) % 4
    if dir == 0 then joypad.set(1, {right=true})
    elseif dir == 1 then joypad.set(1, {up=true})
    elseif dir == 2 then joypad.set(1, {left=true})
    else joypad.set(1, {down=true})
    end

    -- Detect battle by checking mode byte and sprite changes
    local mode = memory.readbyte(0x0040)
    if mode >= 0x80 then
      in_battle = true
      log(string.format("=== BATTLE at frame %d, mode=$%02X ===", frame_count, mode))
    end
    return
  end

  -- Phase 3: in battle - mash A and trace sprites
  if in_battle then
    -- Mash A every 8 frames to navigate menus and advance
    if frame_count % 8 == 0 then
      joypad.set(1, {A=true})
    end

    -- Check if sprite set changed
    local h = sprite_hash()
    local b6 = memory.readbyte(0xB6)
    local cd = memory.readbyte(0xCD)

    if h ~= last_sprite_hash then
      log(string.format("--- frame=%d B6=$%02X CD=$%02X ---", frame_count, b6, cd))
      log_sprites()
      last_sprite_hash = h
    end

    -- Exit after 1500 frames in battle
    if frame_count > 4500 then
      log("=== Done ===")
      f:close()
      emu.exit()
    end
  end

  -- Hard timeout
  if frame_count > 5000 then
    log("=== TIMEOUT ===")
    f:close()
    emu.exit()
  end
end

emu.registerbefore(on_frame)
log("Punch trace v4")
