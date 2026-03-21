-- FCEUX Lua: dump EVERY frame of battle (OAM + PPU) for first 120 frames
-- Uses same title/name-entry/battle navigation as dump-all-battle-sprites.lua
-- Output: tools/every-frame-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/every-frame-dump.txt"
local f = io.open(OUTPUT, "w")
local frame = 0
local done = false
local state = "title"
local last_mode = 0xFF
local name_timer = 0
local battle_frames = 0
local MAX_BATTLE_FRAMES = 120  -- dump every frame for 2 seconds

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
  emu.message("Done! Check every-frame-dump.txt")
end

function dump_frame(label)
  log("=== FRAME " .. label .. " ===")
  -- PPU $1000 tiles $00-$5F
  for tile = 0x00, 0x5F do
    local addr = 0x1000 + tile * 16
    local hex = ""
    for b = 0, 15 do
      hex = hex .. string.format("%02X", ppu.readbyte(addr + b))
    end
    log(string.format("  $%02X: %s", tile, hex))
  end
  -- Palettes
  log("-- palettes --")
  for p = 0, 3 do
    local s = string.format("  pal%d:", p)
    for i = 0, 3 do
      s = s .. string.format(" $%02X", ppu.readbyte(0x3F10 + p * 4 + i))
    end
    log(s)
  end
  -- Full OAM
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

function equip_weapons()
  for c = 0, 3 do
    local base = 0x6200 + c * 0x40
    memory.writebyte(base + 0x03, 0x1E)
    memory.writebyte(base + 0x05, 0x1F)
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

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  if state == "title" then
    if mode == 0xA8 then
      if last_mode ~= 0xA8 then name_timer = 0 end
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
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      log(string.format("[%d] heading to battle", frame))
    end
    last_mode = mode
    return
  end

  if state == "pressing" then
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true})
    else joypad.set(1, {}) end
    if mode == 0x20 then
      state = "battle"
      battle_frames = 0
      log(string.format("[%d] BATTLE START", frame))
      emu.message("In battle! Dumping every frame...")
    end
    last_mode = mode
    return
  end

  if state == "battle" then
    keep_monsters_alive()
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true})
    else joypad.set(1, {}) end

    dump_frame(battle_frames)
    battle_frames = battle_frames + 1

    if battle_frames >= MAX_BATTLE_FRAMES then
      log(string.format("[%d] Done — %d frames dumped", frame, battle_frames))
      finish()
    end
    return
  end
end

emu.registerbefore(on_frame)
log("Every-frame dump — OAM+PPU every frame for first " .. MAX_BATTLE_FRAMES .. " battle frames")

local ok = pcall(function() emu.loadstate(1) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 1]")
  emu.message("Save state loaded — heading to battle!")
else
  emu.message("No save state — running from title")
end
