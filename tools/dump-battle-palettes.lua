-- FCEUX Lua: dump nametable + attribute table for monster battle sprites
-- Based on trace-weapon-positions.lua (EXACT same launch/title/pressing state machine)
-- In battle: reads nametable tile layout + PPU attribute table to extract
-- per-tile palette assignments for every monster sprite on screen.
-- After first battle: kills monsters, mashes victory, walks for next encounter, repeats.
-- Output: tools/battle-palette-dump.txt

local OUTPUT = "/home/joeltco/projects/ff3mmo/tools/battle-palette-dump.txt"
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

local current_set   = 0
local sets_dumped   = 0
local MAX_ENCOUNTERS = 30
local SETTLE_FRAMES  = 60
local settle_timer   = 0
local seen_patterns  = {}

function log(m) if not done then f:write(m.."\n"); f:flush() end end

function finish()
  if done then return end
  done = true
  local pats = {}
  for k in pairs(seen_patterns) do table.insert(pats, k) end
  table.sort(pats)
  log("=== DONE — " .. sets_dumped .. " encounters, patterns: " .. table.concat(pats, ",") .. " ===")
  f:close()
  emu.message("Done! " .. sets_dumped .. " encounters dumped")
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

function kill_all_monsters()
  for m = 0, 7 do
    local base = 0x7675 + m * 0x40
    memory.writebyte(base + 0x03, 0x00)
    memory.writebyte(base + 0x04, 0x00)
  end
end

function get_tile_palette(tileRow, tileCol)
  local attrRow = math.floor(tileRow / 4)
  local attrCol = math.floor(tileCol / 4)
  local attrByte = ppu.readbyte(0x23C0 + attrRow * 8 + attrCol)
  local subRow = math.floor((tileRow % 4) / 2)
  local subCol = math.floor((tileCol % 4) / 2)
  local shift = (subRow * 2 + subCol) * 2
  return bit.band(bit.rshift(attrByte, shift), 0x03)
end

function dump_encounter()
  local encPal0 = memory.readbyte(0x7D69)
  local encPal1 = memory.readbyte(0x7D6A)
  local displayPat = memory.readbyte(0x7D7B)

  local monIds = {}
  local gfxAttrs = {}
  for i = 0, 3 do
    monIds[i] = memory.readbyte(0x7D6B + i)
    gfxAttrs[i] = memory.readbyte(0x7D73 + i)
  end

  log(string.format("=== ENCOUNTER %d (frame %d) ===", current_set, frame))
  log(string.format("  displayPattern: %d", displayPat))
  log(string.format("  encPal0: $%02X  encPal1: $%02X", encPal0, encPal1))

  for p = 0, 3 do
    local base = 0x3F00 + p * 4
    log(string.format("  bgPal%d: $%02X $%02X $%02X $%02X",
      p, ppu.readbyte(base), ppu.readbyte(base+1), ppu.readbyte(base+2), ppu.readbyte(base+3)))
  end

  for i = 0, 3 do
    if monIds[i] ~= 0xFF then
      local cat = bit.rshift(bit.band(gfxAttrs[i], 0xE0), 5)
      local gid = bit.band(gfxAttrs[i], 0x1F)
      log(string.format("  slot%d: monId=$%02X gfxAttr=$%02X cat=%d gfxId=%d", i, monIds[i], gfxAttrs[i], cat, gid))
    end
  end

  log("  nametable:")
  local allTiles = {}
  for row = 3, 15 do
    local line = string.format("    row%02d:", row)
    for col = 0, 19 do
      local tid = ppu.readbyte(0x2000 + row * 32 + col)
      line = line .. string.format(" %02X", tid)
      if tid >= 0x70 then
        table.insert(allTiles, {row=row, col=col, tid=tid, pal=get_tile_palette(row, col)})
      end
    end
    log(line)
  end

  log("  attrTable:")
  for arow = 0, 7 do
    local line = string.format("    row%d:", arow)
    for acol = 0, 7 do
      line = line .. string.format(" %02X", ppu.readbyte(0x23C0 + arow * 8 + acol))
    end
    log(line)
  end

  -- Cluster tiles into sprite groups
  local clusters = {}
  local used = {}
  for i, t in ipairs(allTiles) do
    if not used[i] then
      local cluster = {t}
      used[i] = true
      local q = {i}
      while #q > 0 do
        local ci = table.remove(q, 1)
        local ct = allTiles[ci]
        for j, t2 in ipairs(allTiles) do
          if not used[j] and math.abs(t2.row - ct.row) <= 1 and math.abs(t2.col - ct.col) <= 1 then
            used[j] = true
            table.insert(cluster, t2)
            table.insert(q, j)
          end
        end
      end
      if #cluster >= 4 then table.insert(clusters, cluster) end
    end
  end

  for ci, cluster in ipairs(clusters) do
    local minR, maxR, minC, maxC = 99, 0, 99, 0
    for _, t in ipairs(cluster) do
      if t.row < minR then minR = t.row end
      if t.row > maxR then maxR = t.row end
      if t.col < minC then minC = t.col end
      if t.col > maxC then maxC = t.col end
    end
    local rows = maxR - minR + 1
    local cols = maxC - minC + 1
    local baseTile = 999
    for _, t in ipairs(cluster) do if t.tid < baseTile then baseTile = t.tid end end

    log(string.format("  cluster%d: %dx%d at nt(%d,%d) baseTile=$%02X", ci, cols, rows, minC, minR, baseTile))

    local jsArr = "    jsPalMap: ["
    for r = 0, rows - 1 do
      local tline = "    tids:"
      local pline = "    pals:"
      for c = 0, cols - 1 do
        local found = false
        for _, t in ipairs(cluster) do
          if t.row - minR == r and t.col - minC == c then
            tline = tline .. string.format(" %02X", t.tid)
            pline = pline .. string.format("  %d", t.pal)
            if r > 0 or c > 0 then jsArr = jsArr .. "," end
            jsArr = jsArr .. tostring(t.pal <= 1 and t.pal or 0)
            found = true
            break
          end
        end
        if not found then
          tline = tline .. " .."
          pline = pline .. "  ."
          if r > 0 or c > 0 then jsArr = jsArr .. "," end
          jsArr = jsArr .. "0"
        end
      end
      log(tline)
      log(pline)
    end
    log(jsArr .. "]")
  end

  sets_dumped = sets_dumped + 1
  seen_patterns[displayPat] = true
end

-- ═══════════════════════════════════════════════════════════════════
-- State machine — EXACT COPY from trace-weapon-positions.lua
-- Only the "battle" state is replaced with dump + cycle logic
-- ═══════════════════════════════════════════════════════════════════
function on_frame()
  if done then return end
  frame = frame + 1
  local mode = memory.readbyte(0x0040)

  -- ── TITLE (verbatim from trace-weapon-positions.lua) ───────────
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

  -- ── PRESSING (verbatim from trace-weapon-positions.lua) ────────
  if state == "pressing" then
    if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    if mode ~= last_mode then
      log(string.format("[%d] mode $%02X -> $%02X", frame, last_mode, mode))
    end
    if mode == 0x20 then
      state = "battle_settle"
      settle_timer = 0
      battle_frames = 0
      log(string.format("[%d] BATTLE START #%d", frame, current_set))
      emu.message("Battle #" .. current_set)
    end
    last_mode = mode
    return
  end

  -- ── SETTLE — wait for nametable to be fully written ────────────
  if state == "battle_settle" then
    keep_monsters_alive()
    settle_timer = settle_timer + 1
    if settle_timer >= SETTLE_FRAMES then
      state = "battle_dump"
    end
    return
  end

  -- ── DUMP — read everything ─────────────────────────────────────
  if state == "battle_dump" then
    dump_encounter()
    kill_all_monsters()
    state = "victory_mash"
    battle_frames = 0
    return
  end

  -- ── VICTORY — mash A back to overworld, then walk for next ─────
  if state == "victory_mash" then
    battle_frames = battle_frames + 1
    -- Walk + mash A to get through victory AND trigger next encounter
    if battle_frames < 120 then
      -- First: mash A through victory screens
      if frame % 2 == 0 then joypad.set(1, {A=true}) else joypad.set(1, {}) end
    else
      -- Then: walk around to trigger next random encounter
      memory.writebyte(0x0048, 0x01) -- force step counter low
      local walk = frame % 16
      if walk < 4 then joypad.set(1, {right=true})
      elseif walk < 8 then joypad.set(1, {left=true})
      elseif walk < 12 then joypad.set(1, {down=true})
      else joypad.set(1, {up=true}) end
    end

    -- Detect new battle
    if mode == 0x20 and battle_frames > 30 then
      current_set = current_set + 1
      if current_set >= MAX_ENCOUNTERS then finish(); return end
      state = "battle_settle"
      settle_timer = 0
      battle_frames = 0
      log(string.format("[%d] BATTLE START #%d", frame, current_set))
      emu.message("Battle #" .. current_set)
      return
    end

    if battle_frames >= MAX_BATTLE_FRAMES then
      log("Timeout waiting for next encounter")
      finish(); return
    end
    last_mode = mode
    return
  end

  last_mode = mode
end

emu.registerbefore(on_frame)
log("FF3 Battle Palette Dump — cycles encounters, dumps nametable + attribute table")
log("")

-- Load save state slot 0 (same as trace-weapon-positions.lua)
local ok = pcall(function() emu.loadstate(0) end)
if ok then
  state = "pressing"
  log("[Loaded save state slot 0 — fast-forwarding to battle]")
  emu.message("Save state loaded — heading to battle!")
else
  log("[No save state slot 0 — running from title screen]")
  emu.message("No save state — running from title")
end
