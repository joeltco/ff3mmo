-- Dump ALL 256 sprite tiles from PPU $1000-$1FFF during battle
-- Reuses existing battle entry state machine

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/all-spr-tiles.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame = 0
local done = false
local state = "title"
local last_mode = 0xFF
local name_timer = 0
local settle_timer = 0

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  f:close()
  emu.message("Done!")
end

function keep_monsters_alive()
  for m = 0, 7 do
    local base = 0x7675 + m * 0x40
    if memory.readbyte(base + 0x05) > 0 then
      memory.writebyte(base + 0x03, 0xFF)
      memory.writebyte(base + 0x04, 0x00)
    end
  end
end

function dump_all()
  log("=== ALL 256 SPRITE TILES (PPU $1000-$1FFF) ===")
  for tid = 0x00, 0xFF do
    local addr = 0x1000 + tid * 16
    local bytes = {}
    local nonzero = 0
    for i = 0, 15 do
      local b = ppu.readbyte(addr + i)
      table.insert(bytes, string.format("0x%02x", b))
      if b ~= 0 then nonzero = nonzero + 1 end
    end
    if nonzero > 0 then
      log(string.format("$%02X: new Uint8Array([%s])  // %d nonzero", tid, table.concat(bytes, ","), nonzero))
    end
  end
  log("")
  log("=== SPRITE PALETTES ===")
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("sprPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
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
    end
    last_mode = mode
    return
  end

  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode == 0x20 then
      state = "battle_settle"
      settle_timer = 0
    end
    last_mode = mode
    return
  end

  if state == "battle_settle" then
    keep_monsters_alive()
    settle_timer = settle_timer + 1
    if settle_timer >= 90 then
      dump_all()
      finish()
    end
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Full Sprite Tile Dump")

local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0]")
else
  log("[No save state — from title]")
end
