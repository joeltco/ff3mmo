-- Battle Run Sprite Trace — captures OAM around "Ran away..." message
-- Records continuously, press P to dump.

local log = {}
local log_idx = 0
local capture_frames = 0
local MAX_CAPTURE = 180

local function hexb(v) return string.format("$%02X", v) end

local function snapshot_oam()
  for i = 0, 23 do
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

-- Trigger OAM capture when "Ran away..." ($1E) or "Can't run" ($1F) appears
memory.registerwrite(0x78DA, function()
  local val = memory.readbyte(0x78DA)
  local fc = emu.framecount()
  log_idx = log_idx + 1
  log[log_idx] = string.format("[frame %d] MSG $78DA = %s", fc, hexb(val))
  if val == 0x1E or val == 0x1F then
    capture_frames = MAX_CAPTURE
    log_idx = log_idx + 1
    log[log_idx] = string.format(">>> CAPTURING OAM for %d frames <<<", MAX_CAPTURE)
    snapshot_oam()
  end
end)

-- Track OAM changes every 10 frames during capture
local prev_oam_hash = ""
emu.registerafter(function()
  if capture_frames > 0 then
    capture_frames = capture_frames - 1
    local fc = emu.framecount()
    -- Build a hash of visible OAM to detect changes
    local hash = ""
    for i = 0, 23 do
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
      log_idx = log_idx + 1
      log[log_idx] = string.format("[frame %d] OAM CHANGED:", fc)
      snapshot_oam()
      prev_oam_hash = hash
    end
  end

  local inp = input.get()
  if inp.P then
    print("=== RUN SPRITE TRACE (" .. log_idx .. " entries) ===")
    for i = 1, log_idx do
      print(log[i])
    end
    print("=== END ===")
    log = {}
    log_idx = 0
    prev_oam_hash = ""
  end
end)

print("Run Sprite Trace — captures OAM on Ran away/Can't run. Press P to dump.")
