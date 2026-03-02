-- FCEUX Lua script: capture screenshots during unarmed punch hit animation
-- Run with: fceux --loadlua tools/capture-punch.lua "Final Fantasy III (Japan).nes"

local frame_count = 0
local state = "title"
local timer = 0
local captures = 0
local battle_entered = false
local attack_started = false

-- Watch for battle hit animation by monitoring RAM
-- $B6 = animation frame counter (battle effects)
-- $CD = hand flag (0=right, nonzero=left)
-- $8C/$8D = sprite X/Y positions

function on_frame()
  frame_count = frame_count + 1
  timer = timer + 1

  -- Title screen: mash Start/A to get into game
  if state == "title" then
    if timer % 20 == 0 then
      joypad.set(1, {start=true, A=true})
    end
    -- After enough presses, assume we're in-game
    if timer > 600 then
      state = "walking"
      timer = 0
      emu.message("Walking to find encounter...")
    end

  -- Walk around to trigger random encounter
  elseif state == "walking" then
    local dir = math.floor(timer / 20) % 4
    if dir == 0 then joypad.set(1, {up=true})
    elseif dir == 1 then joypad.set(1, {right=true})
    elseif dir == 2 then joypad.set(1, {down=true})
    else joypad.set(1, {left=true})
    end

    -- Check if battle started
    local b6 = memory.readbyte(0xB6)
    local ppu_ctrl = memory.readbyte(0x2000)
    -- Battle mode check: look at game mode byte
    local game_mode = memory.readbyte(0x0040)
    if game_mode >= 0x10 and not battle_entered then
      battle_entered = true
      state = "battle_wait"
      timer = 0
      emu.message("Battle! Waiting to attack...")
    end

  -- In battle: wait then select Fight -> Attack
  elseif state == "battle_wait" then
    if timer == 90 then
      joypad.set(1, {A=true})  -- select Fight
      emu.message("Selected Fight")
    elseif timer == 120 then
      joypad.set(1, {A=true})  -- confirm target
      emu.message("Confirmed target")
    elseif timer > 130 then
      state = "capturing"
      timer = 0
      emu.message("Capturing hit animation...")
    end

  -- Capture every frame during hit animation
  elseif state == "capturing" then
    local b6 = memory.readbyte(0xB6)
    local cd = memory.readbyte(0xCD)
    local x8c = memory.readbyte(0x8C)
    local y8d = memory.readbyte(0x8D)

    -- Save screenshot every frame for first 120 frames
    if timer <= 120 then
      local fname = string.format("tools/punch-frame-%03d.png", timer)
      gui.savescreenshotas(fname)
      if timer % 10 == 0 then
        emu.message(string.format("f%d B6=%02X CD=%02X xy=%d,%d", timer, b6, cd, x8c, y8d))
      end
    else
      emu.message("Done capturing! " .. timer .. " frames")
      state = "done"
    end

  elseif state == "done" then
    if timer > 30 then
      emu.exit()
    end
  end

  -- Safety exit
  if frame_count > 5000 then
    emu.message("Timeout - exiting")
    emu.exit()
  end
end

emu.registerafter(on_frame)
emu.message("Punch capture script loaded")
