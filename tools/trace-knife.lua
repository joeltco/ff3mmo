-- FCEUX Lua: trace Knife attack (both hands)
-- Right hand = Knife ($1E), Left hand = unarmed
-- Captures PPU tile dumps for BOTH hands separately

local f = io.open("/home/joeltco/projects/ff3mmo/tools/knife-trace.txt", "w")
local frame_count = 0
local done = false
local last_mode = -1
local battle_start = 0
local last_sprite_hash = ""
local state = "title"
local ppu_dumped_R = false   -- right hand (knife) PPU captured
local ppu_dumped_L = false   -- left hand (unarmed) PPU captured
local last_cd = -1           -- track hand changes

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

function equip_knife()
  -- Char 0: Knife in BOTH hands
  local base = 0x6100
  memory.writebyte(base + 0x38, 0x1E)  -- R hand = Knife
  memory.writebyte(base + 0x39, 0x1E)  -- L hand = Knife
  -- Chars 1-3: unequip
  for i = 1, 3 do
    local b = 0x6100 + i * 0x40
    memory.writebyte(b + 0x38, 0)
    memory.writebyte(b + 0x39, 0)
  end
  -- Battle RAM weapon bytes
  memory.writebyte(0x7E1F, 0x1E)  -- R wpn = Knife
  memory.writebyte(0x7E20, 0x1E)  -- L wpn = Knife
end

function dump_ppu_tiles(label, tile_start, tile_end)
  log(string.format("=== PPU TILE DUMP: %s (tiles $%02X-$%02X) ===", label, tile_start, tile_end))
  for _, ptbase in ipairs({0x0000, 0x1000}) do
    log(string.format("-- pattern table $%04X --", ptbase))
    for tile = tile_start, tile_end do
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

function on_frame()
  if done then return end
  frame_count = frame_count + 1

  local mode = memory.readbyte(0x0040)

  if mode ~= last_mode then
    log(string.format("[f%d] mode $%02X->$%02X (%s)", frame_count,
      last_mode >= 0 and last_mode or 0, mode, state))
    last_mode = mode
  end

  -- === TITLE: mash A/Start to get through ===
  if state == "title" then
    if frame_count % 4 == 0 then
      joypad.set(1, {A=true, start=true})
    end
    if frame_count >= 1500 then
      state = "walking"
      log("=== Walking (Knife equipped) ===")
    end
    return
  end

  -- === WALKING: equip knife, walk to trigger encounter ===
  if state == "walking" then
    equip_knife()
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

  -- === BATTLE_CLEAR: no input for 120 frames, keep equipping ===
  if state == "battle_clear" then
    equip_knife()
    joypad.set(1, {})
    if frame_count - battle_start >= 120 then
      state = "battle"
      log("=== Input cleared, starting A spam + full capture ===")
      log(string.format("  SRAM R-hand: $%02X  L-hand: $%02X",
        memory.readbyte(0x6138), memory.readbyte(0x6139)))
      log(string.format("  Battle RAM R-wpn: $%02X  L-wpn: $%02X",
        memory.readbyte(0x7E1F), memory.readbyte(0x7E20)))
    end
    return
  end

  -- === BATTLE: press A every 2 frames, capture sprites + PPU ===
  if state == "battle" then
    equip_knife()
    local bf = frame_count - battle_start

    if bf % 2 == 0 then
      joypad.set(1, {A=true})
    else
      joypad.set(1, {})
    end

    -- Track hand counter (CD) changes
    local cd = memory.readbyte(0xCD)
    if cd ~= last_cd then
      log(string.format("[f%d bf=%d] CD changed: $%02X -> $%02X (%s hand)",
        frame_count, bf, last_cd >= 0 and last_cd or 0, cd,
        cd == 0 and "RIGHT/Knife" or "LEFT/Knife"))
      last_cd = cd
    end

    -- Check ALL sprites every frame for effect tiles (lightweight, no hash)
    local found_effect = false
    for i = 0, 63 do
      local base = 0x0200 + i * 4
      local y = memory.readbyte(base)
      local x = memory.readbyte(base + 3)
      local t = memory.readbyte(base + 1)
      if y > 0 and y < 240 and x < 180 and t >= 0x49 and t <= 0x50 then
        local attr = memory.readbyte(base + 2)
        log(string.format("  spr%02d: x=%3d y=%3d tile=$%02X attr=$%02X CD=$%02X bf=%d",
          i, x, y, t, attr, cd, bf))
        found_effect = true
      end
    end

    -- Dump PPU for right hand (knife)
    if found_effect and cd == 0 and not ppu_dumped_R then
      ppu_dumped_R = true
      dump_ppu_tiles("RIGHT HAND (Knife)", 0x49, 0x55)
    end

    -- Dump PPU for left hand (knife)
    if found_effect and cd == 1 and not ppu_dumped_L then
      ppu_dumped_L = true
      dump_ppu_tiles("LEFT HAND (Knife)", 0x49, 0x55)
    end

    -- Done when we have both hands captured, or timeout
    if ppu_dumped_R and ppu_dumped_L then
      log("=== Both hands captured! ===")
      finish()
    end

    if bf > 2400 then
      log(string.format("=== Timeout. R=%s L=%s ===",
        tostring(ppu_dumped_R), tostring(ppu_dumped_L)))
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
log("Knife trace — Knife ($1E) in BOTH hands")
log("Captures PPU tiles for both hands during hit animation")
