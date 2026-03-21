-- FCEUX Lua: capture EVERY sprite that appears in battle
-- Based on dump-battle-poses.lua (working title+name entry+battle navigation)
-- Once in battle: logs OAM every frame, does full PPU dump whenever a new
-- tile ID first appears in OAM. Captures all poses: back-swing, forward-slash,
-- hit, defend, etc.
-- Output: tools/all-battle-sprites-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/all-battle-sprites-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local battle_start = 0
local last_mode = 0xFF
local name_timer = 0

-- Track which tile IDs we've seen in OAM — do full PPU dump on first appearance
local seen_tiles = {}
local total_ppu_dumps = 0
local MAX_PPU_DUMPS = 60
local battle_frames = 0
local MAX_BATTLE_FRAMES = 1800  -- 30 seconds of battle frames

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
  emu.message("Done! Check all-battle-sprites-dump.txt")
end

function dump_ppu(label)
  if total_ppu_dumps >= MAX_PPU_DUMPS then return end
  total_ppu_dumps = total_ppu_dumps + 1
  log("=== PPU DUMP: " .. label .. " ===")
  for tile = 0x00, 0x5F do
    local addr = 0x1000 + tile * 16
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
end

function log_oam(label)
  log("-- OAM " .. label .. " --")
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

function check_new_tiles(label)
  -- Find any tile ID in OAM we haven't seen before
  local new_tiles = {}
  for i = 0, 63 do
    local b = 0x0200 + i * 4
    local y = memory.readbyte(b)
    if y > 0 and y < 240 then
      local t = memory.readbyte(b + 1)
      if not seen_tiles[t] then
        seen_tiles[t] = true
        table.insert(new_tiles, string.format("$%02X", t))
      end
    end
  end
  if #new_tiles > 0 then
    local tile_list = table.concat(new_tiles, ",")
    log(string.format("[frame %d] NEW TILES: %s — %s", frame, tile_list, label))
    dump_ppu("NEW TILES " .. tile_list .. " @ " .. label)
    log_oam(label)
  end
end

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

function equip_weapons()
  -- sram2 ($6200 + c*$40): +3 = right hand weapon, +5 = left hand weapon
  for c = 0, 3 do
    local base = 0x6200 + c * 0x40
    memory.writebyte(base + 0x03, 0x1E)  -- right hand: Knife
    memory.writebyte(base + 0x05, 0x1F)  -- left hand:  Dagger
  end
end

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- TITLE STATE: use exact same navigation as dump-battle-poses.lua
  if state == "title" then
    if mode == 0xA8 then
      if last_mode ~= 0xA8 then
        name_timer = 0
        log(string.format("[%d] Name entry screen", frame))
      end
      name_timer = name_timer + 1
      joypad.set(1, {})
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
      if act == "A" then joypad.set(1, {A=true})
      elseif act == "D" then joypad.set(1, {down=true}) end
    else
      if frame % 4 < 2 then joypad.set(1, {A=true, start=true})
      else joypad.set(1, {}) end
    end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      battle_start = frame
      log(string.format("[%d] Past name entry — pressing A into battle", frame))
      emu.message("Heading to battle...")
    end
    last_mode = mode
    return
  end

  -- PRESSING STATE: mash A, detect battle mode, then switch to capture
  if state == "pressing" then
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true})
    else joypad.set(1, {}) end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if mode == 0x20 then
      state = "battle"
      battle_start = frame
      battle_frames = 0
      log(string.format("[%d] BATTLE START — capturing all sprites", frame))
      emu.message("In battle! Capturing all sprites...")
      -- Initial full dump
      dump_ppu("BATTLE START")
      log_oam("BATTLE START")
      -- Mark all currently visible tiles as seen
      for i = 0, 63 do
        local b = 0x0200 + i * 4
        local y = memory.readbyte(b)
        if y > 0 and y < 240 then
          seen_tiles[memory.readbyte(b + 1)] = true
        end
      end
    end
    last_mode = mode
    return
  end

  -- BATTLE STATE: mash A every frame, log OAM, PPU dump on new tiles
  if state == "battle" then
    keep_monsters_alive()
    equip_weapons()
    -- Mash A to keep selecting Fight and targets
    if frame % 2 == 0 then joypad.set(1, {A=true})
    else joypad.set(1, {}) end

    battle_frames = battle_frames + 1

    -- Check for new tile IDs every frame
    check_new_tiles("f=" .. battle_frames)

    -- Also log full OAM every 30 frames for reference
    if battle_frames % 30 == 0 then
      log_oam("PERIODIC f=" .. battle_frames)
    end

    -- Stop when battle ends or timeout
    if mode == 0x05 then
      log(string.format("[%d] Battle ended", frame))
      finish()
      return
    end
    if battle_frames >= MAX_BATTLE_FRAMES or total_ppu_dumps >= MAX_PPU_DUMPS then
      log(string.format("[%d] Capture complete: %d PPU dumps, %d battle frames", frame, total_ppu_dumps, battle_frames))
      finish()
      return
    end
    last_mode = mode
    return
  end
end

emu.registerbefore(on_frame)
log("All-battle-sprites dump — every tile that appears in OAM gets a PPU dump")

-- Try save state slot 1
local ok = pcall(function() emu.loadstate(1) end)
if ok then
  state = "pressing"
  battle_start = frame
  log("[Loaded save state slot 1 — fast-forwarding to battle]")
  emu.message("Save state loaded — heading to battle!")
else
  emu.message("No save state — running from title screen")
end
