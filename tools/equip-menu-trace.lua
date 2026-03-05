-- Equip/Item Menu Trace — captures cursor behavior, selected item flash, screen transitions
-- Open the menu in FF3, go to Item or Equip, press P to dump state.
-- Records memory changes continuously. Press P anytime to dump log.

local log = {}
local log_idx = 0

local function hexb(v) return string.format("$%02X", v) end
local function hexw(v) return string.format("$%04X", v) end

-- Snapshot OAM (cursor sprites, flashing indicators)
local function snapshot_oam()
  for i = 0, 63 do
    local base = i * 4
    local y    = memory.readbyte(0x0200 + base)
    local tile = memory.readbyte(0x0201 + base)
    local attr = memory.readbyte(0x0202 + base)
    local x    = memory.readbyte(0x0203 + base)
    if y < 0xF0 then
      local hflip = (AND(attr, 0x40) ~= 0) and "H" or "-"
      local vflip = (AND(attr, 0x80) ~= 0) and "V" or "-"
      local pal   = AND(attr, 0x03)
      log_idx = log_idx + 1
      log[log_idx] = string.format("    OAM[%02d] x=%3d y=%3d tile=%s attr=%s pal=%d %s%s",
        i, x, y, hexb(tile), hexb(attr), pal, hflip, vflip)
    end
  end
end

-- Track menu state bytes (common FF3 menu RAM areas)
local function snapshot_menu_state()
  log_idx = log_idx + 1
  log[log_idx] = string.format("  Menu state bytes:")
  -- Battle menu / general menu cursor
  for _, addr in ipairs({0x78D0, 0x78D1, 0x78D2, 0x78D3, 0x78D4, 0x78D5,
                         0x78D8, 0x78D9, 0x78DA, 0x78DB, 0x78DC, 0x78DD}) do
    log_idx = log_idx + 1
    log[log_idx] = string.format("    [%s] = %s", hexw(addr), hexb(memory.readbyte(addr)))
  end
  -- Item/inventory area ($6100-$613F is inventory in some FF3 builds)
  log_idx = log_idx + 1
  log[log_idx] = "  Inventory area ($6100-$610F):"
  local inv = ""
  for i = 0, 15 do
    inv = inv .. hexb(memory.readbyte(0x6100 + i)) .. " "
  end
  log_idx = log_idx + 1
  log[log_idx] = "    " .. inv
  -- Equipment slots ($6040-$604F typical for char 1 equip)
  log_idx = log_idx + 1
  log[log_idx] = "  Equip area ($6040-$604F):"
  local eq = ""
  for i = 0, 15 do
    eq = eq .. hexb(memory.readbyte(0x6040 + i)) .. " "
  end
  log_idx = log_idx + 1
  log[log_idx] = "    " .. eq
  -- Char 1 data block ($6000-$603F)
  log_idx = log_idx + 1
  log[log_idx] = "  Char1 data ($6000-$600F):"
  local ch = ""
  for i = 0, 15 do
    ch = ch .. hexb(memory.readbyte(0x6000 + i)) .. " "
  end
  log_idx = log_idx + 1
  log[log_idx] = "    " .. ch
end

-- Watch for cursor position changes in common battle/menu RAM
local watch_addrs = {0x78D0, 0x78D1, 0x78D2, 0x78D4, 0x78D5, 0x78D8, 0x78D9}
for _, addr in ipairs(watch_addrs) do
  memory.registerwrite(addr, function()
    local val = memory.readbyte(addr)
    local fc = emu.framecount()
    log_idx = log_idx + 1
    log[log_idx] = string.format("[frame %d] WRITE %s = %s", fc, hexw(addr), hexb(val))
  end)
end

-- Sample OAM every 30 frames to catch cursor flash timing
local sample_counter = 0
local prev_oam_hash = ""
emu.registerafter(function()
  sample_counter = sample_counter + 1

  -- Check OAM for changes every 8 frames (catch flash timing)
  if sample_counter % 8 == 0 then
    local hash = ""
    for i = 0, 15 do
      local base = i * 4
      local y = memory.readbyte(0x0200 + base)
      if y < 0xF0 then
        hash = hash .. string.format("%02X%02X%02X%02X",
          y, memory.readbyte(0x0201 + base),
          memory.readbyte(0x0202 + base),
          memory.readbyte(0x0203 + base))
      end
    end
    if hash ~= prev_oam_hash then
      local fc = emu.framecount()
      log_idx = log_idx + 1
      log[log_idx] = string.format("[frame %d] OAM changed:", fc)
      snapshot_oam()
      prev_oam_hash = hash
    end
  end

  -- P to dump
  local inp = input.get()
  if inp.P then
    local fc = emu.framecount()
    log_idx = log_idx + 1
    log[log_idx] = string.format("[frame %d] === MANUAL DUMP ===", fc)
    snapshot_menu_state()
    snapshot_oam()

    print("=== EQUIP MENU TRACE (" .. log_idx .. " entries) ===")
    for i = 1, log_idx do
      print(log[i])
    end
    print("=== END ===")
    log = {}
    log_idx = 0
    prev_oam_hash = ""
  end
end)

print("Equip Menu Trace loaded. Open menu, navigate to Item/Equip, press P to dump.")
