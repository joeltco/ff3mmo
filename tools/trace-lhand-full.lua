-- FCEUX Lua: capture ALL OAM changes during L-hand attack (dagger in L, nothing in R)
-- Diffs each frame's OAM against a captured idle baseline to find new/moved sprites.
-- This reveals whatever tile IDs the L-hand weapon uses (if any).
-- Calls os.exit(0) when done. Output: tools/weapon-lhand-full.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/weapon-lhand-full.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame          = 0
local done           = false
local state          = "title"
local battle_frames  = 0
local last_mode      = 0xFF
local name_timer     = 0
local MAX_BATTLE_FRAMES = 2400
local MAX_POSES         = 12

local pose_count    = 0
local in_pose       = false
local last_pose_key = nil

-- Baseline idle OAM — captured once battle starts, before first attack
local idle_oam      = nil
local idle_captured = false

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  log("=== DONE ===")
  f:close()
  emu.message("Done! weapon-lhand-full.txt — exiting")
  os.exit(0)
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

function equip_weapons()
  for c = 0, 3 do
    local base = 0x6200 + c * 0x40
    memory.writebyte(base + 0x03, 0x00)  -- right: empty
    memory.writebyte(base + 0x05, 0x1F)  -- left:  Dagger
  end
end

function read_oam()
  local oam = {}
  for i = 0, 63 do
    local b  = 0x0200 + i * 4
    local sy = memory.readbyte(b)
    local st = memory.readbyte(b + 1)
    local sa = memory.readbyte(b + 2)
    local sx = memory.readbyte(b + 3)
    oam[i]   = {x=sx, y=sy, t=st, a=sa}
  end
  return oam
end

function diff_oam(base_oam, cur_oam)
  -- Returns sprites that are newly visible or have moved/changed tile vs baseline
  local diffs = {}
  for i = 0, 63 do
    local b = base_oam[i]
    local c = cur_oam[i]
    local b_vis = b.y > 0 and b.y < 240
    local c_vis = c.y > 0 and c.y < 240
    if c_vis then
      if not b_vis then
        -- sprite newly visible
        table.insert(diffs, {i=i, x=c.x, y=c.y, t=c.t, a=c.a, reason="NEW"})
      elseif c.x ~= b.x or c.y ~= b.y or c.t ~= b.t then
        -- sprite moved or changed tile
        table.insert(diffs, {i=i, x=c.x, y=c.y, t=c.t, a=c.a,
          bx=b.x, by=b.y, bt=b.t, reason="MOVED"})
      end
    end
  end
  return diffs
end

function oam_key(oam)
  -- Compact key for dedup: only visible sprites
  local parts = {}
  for i = 0, 63 do
    local s = oam[i]
    if s.y > 0 and s.y < 240 then
      table.insert(parts, string.format("%d:%d,%d,$%02X", i, s.x, s.y, s.t))
    end
  end
  return table.concat(parts, "|")
end

function log_full_oam(oam, label)
  log("  -- OAM " .. label .. " --")
  for i = 0, 63 do
    local s = oam[i]
    if s.y > 0 and s.y < 240 then
      log(string.format("    spr%02d: x=%3d y=%3d t=$%02X a=$%02X", i, s.x, s.y, s.t, s.a))
    end
  end
end

function log_diffs(diffs, label)
  if #diffs == 0 then return end
  log("  -- DIFF vs idle " .. label .. " --")
  for _, d in ipairs(diffs) do
    if d.reason == "NEW" then
      log(string.format("    spr%02d NEW:   x=%3d y=%3d t=$%02X a=$%02X",
        d.i, d.x, d.y, d.t, d.a))
    else
      log(string.format("    spr%02d MOVED: x=%3d y=%3d t=$%02X a=$%02X  (was x=%3d y=%3d t=$%02X)",
        d.i, d.x, d.y, d.t, d.a, d.bx, d.by, d.bt))
    end
  end
end

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- ── TITLE nav ────────────────────────────────────────────────────────────────
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
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if name_timer > 620 and mode ~= 0xA8 then
      state = "pressing"
      log(string.format("[%d] Past name entry", frame))
    end
    last_mode = mode
    return
  end

  -- ── PRESSING ─────────────────────────────────────────────────────────────────
  if state == "pressing" then
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if mode == 0x20 then
      state = "battle"
      battle_frames = 0
      log(string.format("[%d] BATTLE START — L-HAND ONLY (dagger 0x1F, empty R)", frame))
      log("Strategy: diff every frame vs idle baseline — find ALL changed/new sprites")
      log("")
      emu.message("In battle! Watching ALL OAM changes for L-hand...")
    end
    last_mode = mode
    return
  end

  -- ── BATTLE ───────────────────────────────────────────────────────────────────
  if state == "battle" then
    keep_monsters_alive()
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end

    battle_frames = battle_frames + 1
    local cur_oam = read_oam()

    -- Capture idle baseline after 30 frames (UI settled, before first attack)
    if not idle_captured and battle_frames == 30 then
      idle_oam = cur_oam
      idle_captured = true
      log("Idle baseline captured at bf=30")
      log_full_oam(idle_oam, "IDLE BASELINE")
      log("")
    end

    if idle_captured then
      local diffs = diff_oam(idle_oam, cur_oam)
      local key   = oam_key(cur_oam)

      if #diffs > 0 then
        if not in_pose then
          in_pose    = true
          pose_count = pose_count + 1
          last_pose_key = nil
        end
        if key ~= last_pose_key then
          last_pose_key = key
          log(string.format("POSE #%d  bf=%-4d  (%d sprites changed vs idle)",
            pose_count, battle_frames, #diffs))
          log_diffs(diffs, string.format("(bf=%d)", battle_frames))
          log("")
          if pose_count >= MAX_POSES then
            log(string.format("Captured %d poses — done.", MAX_POSES))
            finish(); return
          end
        end
      else
        in_pose       = false
        last_pose_key = nil
      end
    end

    if mode == 0x05 then
      log(string.format("[%d] Battle ended — %d pose changes captured", frame, pose_count))
      finish(); return
    end
    if battle_frames >= MAX_BATTLE_FRAMES then
      log(string.format("Timeout — %d battle frames, %d pose changes", battle_frames, pose_count))
      finish(); return
    end

    last_mode = mode
    return
  end
end

emu.registerbefore(on_frame)
log("=== L-HAND FULL OAM DIFF trace — dagger in L, nothing in R ===")
log("Watches ALL sprite changes vs idle (not just tiles $49-$4C)")
log("")

local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0]")
else
  state = "title"
  log("[No save state — navigating from title]")
end
