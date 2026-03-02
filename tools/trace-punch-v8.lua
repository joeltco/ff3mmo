-- FCEUX Lua: trace unarmed punch v8
-- Brute force: A every 2 frames, log ALL sprite changes, long runtime
-- Enemies are BG tiles so only party + hit effects show in OAM

local f = io.open("/home/joeltco/projects/ff3mmo/tools/punch-trace-v8.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local last_sprite_hash = ""
local state = "title"
local in_battle = false
local ppu_dumped = false

function log(msg)
  if done then return end
  f:write(msg .. "\n")
  f:flush()
end

function finish()
  if done then return end
  done = true
  log("=== FINISHED ===")
  f:close()
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
  local count = 0
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
      count = count + 1
    end
  end
  return count
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

  local mode = memory.readbyte(0x0040)

  -- Log mode changes always
  if mode ~= last_mode then
    log(string.format("[f%d] mode $%02X->$%02X (%s)", frame_count,
      last_mode >= 0 and last_mode or 0, mode, state))
    last_mode = mode
  end

  -- === TITLE ===
  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
      log("=== Walking ===")
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

    if mode >= 0x03 and frame_count > 1560 then
      state = "battle_clear"
      battle_start = frame_count
      log(string.format("=== Battle at f%d mode=$%02X ===", frame_count, mode))
    end

    if frame_count > 8000 then
      log("=== TIMEOUT ===")
      finish()
    end
    return
  end

  -- === BATTLE_CLEAR: no input for 120 frames to flush directions ===
  if state == "battle_clear" then
    unequip_all()
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
      log("=== Input cleared, starting A spam + full capture ===")
    end
    return
  end

  -- === BATTLE: press A every 2 frames, log ALL sprite changes ===
  if state == "battle" then
    unequip_all()
    local bf = frame_count - battle_start

    -- Press A every 2 frames (1 frame on, 1 frame off for new-press detection)
    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Log ALL sprite changes
    local h = sprite_hash()
    if h ~= last_sprite_hash then
      local b6 = memory.readbyte(0xB6)
      local cd = memory.readbyte(0xCD)
      local slot = memory.readbyte(0x0052)
      log(string.format("--- bf=%d B6=$%02X CD=$%02X slot=%d mode=$%02X ---",
        bf, b6, cd, slot, mode))
      local n = log_sprites()
      -- Flag if we see sprites outside the normal party area (x < 200)
      -- Those would be hit effect sprites!
      local found_effect = false
      for i = 0, 63 do
        local base = 0x0200 + i * 4
        local y = memory.readbyte(base)
        local x = memory.readbyte(base + 3)
        if y > 0 and y < 240 and x < 180 then
          local t = memory.readbyte(base+1)
          log(string.format("  *** NON-PARTY SPRITE spr%02d at x=%d y=%d tile=$%02X ***",
            i, x, y, t))
          if t >= 0x49 and t <= 0x55 then found_effect = true end
        end
      end
      -- Dump PPU tile bytes once when hit effect is on screen
      if found_effect and not ppu_dumped then
        ppu_dumped = true
        log("=== PPU TILE DUMP ===")
        for _, ptbase in ipairs({0x0000, 0x1000}) do
          log(string.format("-- pattern table $%04X --", ptbase))
          for tile = 0x49, 0x55 do
            local addr = ptbase + tile * 16
            local hex = ""
            for b = 0, 15 do
              hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
            end
            log(string.format("  tile $%02X: %s", tile, hex))
          end
        end
        log("-- sprite palettes --")
        for p = 0, 3 do
          local s = string.format("  pal%d:", p)
          for i = 0, 3 do
            s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
          end
          log(s)
        end
      end
      last_sprite_hash = h
    end

    -- Run for 1800 frames in battle (30 sec)
    if bf > 1800 then
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
log("Punch trace v8 - brute force A + full sprite capture")
