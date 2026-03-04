-- FF1 SFX Trace — captures ZP writes around Start button presses
-- Run in FCEUX with FF1&2 ROM. Press Start to open/close menu.
-- Logs all zero-page writes for 30 frames after each Start press.

local capturing = false
local capture_frames = 0
local seen = {}

emu.registerafter(function()
  -- Check controller 1 Start button (bit 3 of $4016 read)
  local joy = joypad.read(1)
  if joy.start then
    if not capturing then
      capturing = true
      capture_frames = 0
      seen = {}
      print("=== START pressed — capturing ZP writes for 30 frames ===")
    end
  end

  if capturing then
    capture_frames = capture_frames + 1
    if capture_frames > 30 then
      capturing = false
      print("=== capture done ===\n")
    end
  end
end)

-- Monitor ZP writes $40-$80 (sound engine area) — only during capture
for addr = 0x40, 0x80 do
  memory.registerwrite(addr, function()
    if not capturing then return end
    local val = memory.readbyte(addr)
    local key = string.format("%02X_%02X", addr, val)
    if not seen[key] then
      seen[key] = true
      print(string.format("  ZP $%02X = $%02X (%d)  frame %d", addr, val, val, capture_frames))
    end
  end)
end

-- Hook Music_NewSong
memory.registerexec(0xB003, function()
  if not capturing then return end
  local a = memory.getregister("a")
  print(string.format("  Music_NewSong A=$%02X  frame %d", a, capture_frames))
end)

print("FF1 SFX Trace — press Start to open/close menu, captures 30 frames of ZP writes")
