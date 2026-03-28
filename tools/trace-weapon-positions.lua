-- FCEUX Lua: trace exact weapon sprite x/y vs body x/y for all attack poses
-- Based on dump-all-battle-sprites.lua (EXACT same launch/title/pressing/battle state machine)
-- In battle: every frame weapon tiles $49-$4C are visible, logs:
--   pose#, weapon x/y, body-ref x/y, offset_x, hflip (back-swing=Y / fwd-swing=N)
-- Equips knife (R) + dagger (L) so both hands are active
-- Output: tools/weapon-positions-trace.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/weapon-positions-trace.txt"
local f = io.open(OUTPUT, "w")
if not f then emu.message("ERROR: cannot open output!"); return end

local frame       = 0
local done        = false
local state       = "title"
local battle_start= 0
local last_mode   = 0xFF
local name_timer  = 0
local battle_frames = 0
local MAX_BATTLE_FRAMES = 1800

-- Weapon tile IDs in PPU slot space
local WEAPON_TILES = { [0x49]=true, [0x4A]=true, [0x4B]=true, [0x4C]=true }

-- Per-pose tracking (log once per continuous weapon-visible run)
local pose_count    = 0
local in_pose       = false
local last_pose_key = nil

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  log("=== DONE ===")
  f:close()
  emu.message("Done! weapon-positions-trace.txt")
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
    memory.writebyte(base + 0x03, 0x1E)  -- right: Knife
    memory.writebyte(base + 0x05, 0x1F)  -- left:  Dagger
  end
end

function scan_oam()
  -- Returns: has_weapon, weapon_hflip, weapon_x_min, weapon_y_min,
  --          body_x_min (leftmost head/torso tile x), body_y_min,
  --          full OAM table
  local oam = {}
  local has_weapon   = false
  local w_hflip      = false
  local w_x          = 999
  local w_y          = 999
  local body_x       = 999
  local body_y       = 999

  for i = 0, 63 do
    local b   = 0x0200 + i * 4
    local sy  = memory.readbyte(b)
    if sy > 0 and sy < 240 then
      local st = memory.readbyte(b + 1)
      local sa = memory.readbyte(b + 2)
      local sx = memory.readbyte(b + 3)
      table.insert(oam, {i=i, x=sx, y=sy, t=st, a=sa})

      if WEAPON_TILES[st] then
        has_weapon = true
        if bit.band(sa, 0x40) ~= 0 then w_hflip = true end
        if sx < w_x then w_x = sx end
        if sy < w_y then w_y = sy end
      end

      -- Head/torso reference tiles: t=$01-$06 palette 0 (a & $03 == 0)
      -- These are the body head tiles that stay fixed across all poses
      if st >= 0x01 and st <= 0x06 and bit.band(sa, 0x03) == 0 then
        if sx < body_x then body_x = sx end
        if sy < body_y then body_y = sy end
      end
    end
  end

  return has_weapon, w_hflip, w_x, w_y, body_x, body_y, oam
end

function log_full_oam(oam, label)
  log("  -- OAM " .. label .. " --")
  for _, s in ipairs(oam) do
    log(string.format("    spr%02d: x=%3d y=%3d t=$%02X a=$%02X", s.i, s.x, s.y, s.t, s.a))
  end
end

function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- ── TITLE ──────────────────────────────────────────────────────────────────
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

  -- ── PRESSING ───────────────────────────────────────────────────────────────
  if state == "pressing" then
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if mode == 0x20 then
      state = "battle"
      battle_start = frame
      battle_frames = 0
      log(string.format("[%d] BATTLE START", frame))
      log("Columns: pose# | bf | swing-type | hflip | weapon_x weapon_y | body_x body_y | offset_x offset_y")
      log("")
      emu.message("In battle! Tracing weapon positions...")
    end
    last_mode = mode
    return
  end

  -- ── BATTLE ─────────────────────────────────────────────────────────────────
  if state == "battle" then
    keep_monsters_alive()
    equip_weapons()
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end

    battle_frames = battle_frames + 1

    local has_wpn, w_hflip, w_x, w_y, body_x, body_y, oam = scan_oam()

    if has_wpn then
      local swing    = w_hflip and "BACK-SWING" or "FWD-SWING "
      local pose_key = swing .. (w_hflip and "Y" or "N") .. w_x .. "_" .. body_x

      if not in_pose then
        in_pose = true
        pose_count = pose_count + 1
        last_pose_key = nil
      end

      if pose_key ~= last_pose_key then
        last_pose_key = pose_key
        local ox = (body_x < 999) and (w_x - body_x) or 999
        local oy = (body_y < 999) and (w_y - body_y) or 999
        log(string.format("POSE #%d  bf=%-4d  %s  hflip=%s  weapon x=%-3d y=%-3d  body x=%-3d y=%-3d  offset_x=%-4d offset_y=%-3d",
          pose_count, battle_frames, swing,
          w_hflip and "Y" or "N",
          w_x, w_y, body_x, body_y, ox, oy))
        log_full_oam(oam, swing)
        log("")
      end
    else
      in_pose = false
      last_pose_key = nil
    end

    if mode == 0x05 then
      log(string.format("[%d] Battle ended — %d poses captured", frame, pose_count))
      finish(); return
    end
    if battle_frames >= MAX_BATTLE_FRAMES then
      log(string.format("Timeout — %d battle frames, %d poses", battle_frames, pose_count))
      finish(); return
    end

    last_mode = mode
    return
  end
end

emu.registerbefore(on_frame)
log("Weapon positions trace — knife(R) + dagger(L), watching $49-$4C in OAM")
log("")

-- Load save state slot 0 (Final Fantasy III (Japan).fc0)
local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0 — fast-forwarding to battle]")
  emu.message("Save state loaded — heading to battle!")
else
  log("[No save state slot 0 — running from title screen]")
  emu.message("No save state — running from title")
end
