-- FF1 Music Trace — logs song IDs passed to Music_NewSong ($B003)
-- Run in FCEUX with the FF1&2 compilation ROM.
-- Navigate to the menu/pause screen and watch the output.

-- Music_NewSong at $B003 expects song ID in A register
-- Song IDs: $41=song1, $42=song2, ..., $4C=song12, etc.
-- music_track stored at zero page $4B

local song_names = {
  [0x41] = "Prelude",
  [0x42] = "Opening Theme",
  [0x43] = "Ending Theme",
  [0x44] = "Main Theme (Overworld)",
  [0x45] = "Ship",
  [0x46] = "Airship",
  [0x47] = "Town",
  [0x48] = "Castle",
  [0x49] = "Volcano/Ice Cave",
  [0x4A] = "Dungeon",
  [0x4B] = "Temple of Fiends",
  [0x4C] = "Menu Screen?",
  [0x4D] = "Shop",
  [0x4E] = "Battle",
  [0x4F] = "Dead Music",
  [0x50] = "Victory Fanfare",
  [0x51] = "Saved Theme",
  [0x52] = "Inn",
  [0x53] = "Final Battle",
  [0x54] = "Floating Castle",
  [0x55] = "Prelude (repeat)",
  [0x56] = "Bridge Scene",
  [0x57] = "Ending Fanfare",
}

local last_song = -1

-- Hook execution at $B003 (Music_NewSong entry)
memory.registerexec(0xB003, function()
  local a = memory.getregister("a")
  local name = song_names[a] or ("unknown $" .. string.format("%02X", a))
  if a ~= last_song then
    emu.message("Song: $" .. string.format("%02X", a) .. " = " .. name)
    print("Music_NewSong called with A=$" .. string.format("%02X", a) .. " = " .. name)
    last_song = a
  end
end)

-- Also watch writes to music_track ($4B)
memory.registerwrite(0x4B, function()
  local val = memory.readbyte(0x4B)
  print("  music_track ($4B) = $" .. string.format("%02X", val) .. " (song " .. val .. ")")
end)

print("FF1 Music Trace active — navigate the game and watch for song changes")
