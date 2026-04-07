-- FCEUX Lua: dump poison status effect sprite tiles from PPU
-- Forces poison on char 1, executes a full turn via input, captures OAM during poison anim.
-- Output: tools/poison-sprite-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/poison-sprite-dump.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame       = 0
local done        = false
local state       = "title"
local last_mode   = 0xFF
local name_timer  = 0
local battle_frames = 0
local settle_timer  = 0
local SETTLE_FRAMES = 90
local turn_timer    = 0
local snapshot_count = 0
local last_oam_hash = ""

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  log(string.format("[%d] FINISHED — %d snapshots taken", frame, snapshot_count))
  f:close()
  emu.message("Done! " .. snapshot_count .. " snapshots")
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

function force_poison()
  -- Char 1 battle status at $7635+$02=$7637, bit 1 = poison
  local s1 = memory.readbyte(0x7637)
  memory.writebyte(0x7637, bit.bor(s1, 0x02))
  -- Display status: $78BC bit 6 = poison
  local d = memory.readbyte(0x78BC)
  memory.writebyte(0x78BC, bit.bor(d, 0x40))
  -- Also set the field status so it persists across turns
  -- Char 1 field data at $6102, bit 1 = poison
  local fs = memory.readbyte(0x6102)
  memory.writebyte(0x6102, bit.bor(fs, 0x02))
  log(string.format("[%d] Forced poison on char 1", frame))
end

function dump_snapshot(label)
  snapshot_count = snapshot_count + 1
  log(string.format("=== %s (frame %d, snapshot #%d) ===", label, frame, snapshot_count))

  -- OAM
  log("  OAM:")
  local tileIds = {}
  local sprites = {}
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y    = memory.readbyte(base)
    local tile = memory.readbyte(base + 1)
    local attr = memory.readbyte(base + 2)
    local x    = memory.readbyte(base + 3)
    if y < 0xEF then
      log(string.format("    [%02d] Y=%3d tile=$%02X attr=$%02X X=%3d pal=%d hf=%d vf=%d",
        i, y, tile, attr, x, bit.band(attr,3), bit.band(bit.rshift(attr,6),1), bit.band(bit.rshift(attr,7),1)))
      table.insert(tileIds, tile)
      table.insert(sprites, {i=i, y=y, tile=tile, attr=attr, x=x})
    end
  end

  -- Sprite palettes
  log("  SPRITE PALETTES:")
  for p = 0, 3 do
    local base = 0x3F10 + p * 4
    log(string.format("    pal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end

  -- PPU tile raw data for all unique tiles
  local seen = {}
  log("  PPU TILES:")
  for _, tid in ipairs(tileIds) do
    if not seen[tid] then
      seen[tid] = true
      local addr = 0x1000 + tid * 16
      local bytes = {}
      for b = 0, 15 do table.insert(bytes, string.format("0x%02x", ppu.readbyte(addr + b))) end
      log(string.format("    tile $%02X: new Uint8Array([%s])", tid, table.concat(bytes, ",")))
    end
  end

  -- Battle action script state
  local actionScript = memory.readbyte(0x7860)
  local battlePhase = memory.readbyte(0x7858)
  log(string.format("  actionScript=$%02X  battlePhase=$%02X", actionScript, battlePhase))
end

function get_oam_hash()
  local h = ""
  for i = 0, 63 do
    local base = 0x0200 + i * 4
    local y = memory.readbyte(base)
    if y < 0xEF then
      h = h .. string.format("%02x%02x", memory.readbyte(base+1), y)
    end
  end
  return h
end

-- ═══════════════════════════════════════════════════════════════════
-- State machine
-- ═══════════════════════════════════════════════════════════════════
function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- TITLE
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
      log(string.format("[%d] Past name entry — heading to battle", frame))
      emu.message("Heading to battle...")
    end
    last_mode = mode
    return
  end

  -- PRESSING A to get into battle
  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode == 0x20 then
      state = "battle_settle"
      settle_timer = 0
      log(string.format("[%d] BATTLE START", frame))
      emu.message("Battle!")
    end
    last_mode = mode
    return
  end

  -- SETTLE — wait for battle to render
  if state == "battle_settle" then
    keep_monsters_alive()
    settle_timer = settle_timer + 1
    if settle_timer >= SETTLE_FRAMES then
      force_poison()
      dump_snapshot("BASELINE (before turn)")
      state = "execute_turn"
      turn_timer = 0
      log(string.format("[%d] Executing turn — pressing A to select Fight + confirm", frame))
      emu.message("Executing turn...")
    end
    return
  end

  -- EXECUTE TURN — press A to Fight, A to confirm target, then watch
  if state == "execute_turn" then
    keep_monsters_alive()
    turn_timer = turn_timer + 1

    -- Press A at specific intervals to: select Fight (frame ~5), confirm target (frame ~20)
    if turn_timer < 40 then
      if turn_timer % 8 < 4 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    else
      joypad.set(1, {})
    end

    -- After input phase, start capturing every 2 frames to catch the poison animation
    if turn_timer >= 30 then
      local hash = get_oam_hash()
      if hash ~= last_oam_hash then
        dump_snapshot(string.format("TURN frame %d (OAM changed)", turn_timer))
        last_oam_hash = hash
      elseif turn_timer % 10 == 0 then
        dump_snapshot(string.format("TURN frame %d (periodic)", turn_timer))
      end
    end

    -- After 600 frames (~10 seconds), should have captured everything
    if turn_timer >= 600 then
      finish()
    end
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Poison Status Sprite Dump v2")
log("Forces poison, executes turn, captures OAM changes during poison animation")
log("")

local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0]")
  emu.message("Save state loaded!")
else
  log("[No save state — running from title]")
  emu.message("No save state — from title")
end
