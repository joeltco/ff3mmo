// STATE tab — live game state editor. Currently: VEHICLES.
//
// The ROM grants craft through event scripts ($EE sets $600B), and those events
// are not wired in ff3mmo yet, so without this panel `ps.vehicle` can never leave
// 0 and the whole vehicle system is unreachable in play. This is a DEBUG
// affordance for exercising it — not a story grant, and not a way to obtain a
// vehicle in normal play.

import { ps } from '../../player-stats.js';
import { mapSt } from '../../map-state.js';
import { VEHICLES, vehicleInfo, isAboard } from '../../data/vehicles.js';
import { playTrack, playSFX } from '../../music.js';

let _root = null;
let _status = null;

function refresh() {
  if (!_status) return;
  const m = ps.vehicle | 0;
  const parked = ps.vehicleParked
    ? `${vehicleInfo(ps.vehicleParkedMode).name} at (${ps.vehicleParkedX},${ps.vehicleParkedY})`
    : 'none';
  _status.textContent =
    `aboard: ${m} (${vehicleInfo(m).name})   parked: ${parked}   ` +
    `world: ${mapSt.onWorldMap ? 'yes' : 'no'}   pos: (${mapSt.worldX | 0},${mapSt.worldY | 0})`;
}

export function mount(root) {
  _root = root;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:14px;color:#ddd;font-size:12px;line-height:1.6;';

  const head = document.createElement('div');
  head.style.cssText = 'color:#c8a832;font-size:11px;margin-bottom:8px';
  head.textContent = 'VEHICLES — debug only (the ROM grants these via events, which are not wired yet)';
  wrap.appendChild(head);

  _status = document.createElement('div');
  _status.style.cssText = 'margin:6px 0 10px;color:#8fc;font-family:monospace;';
  wrap.appendChild(_status);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
  for (const [mode, v] of VEHICLES) {
    const b = document.createElement('button');
    b.textContent = `${mode} ${v.name}`;
    b.style.cssText = 'padding:4px 8px;font-size:11px;cursor:pointer;';
    b.onclick = () => {
      ps.vehicle = mode;
      ps.vehicleParked = 0;
      const info = vehicleInfo(mode);
      if (isAboard(mode) && info.sfx) playSFX(info.sfx);
      playTrack(info.music);
      refresh();
    };
    row.appendChild(b);
  }
  wrap.appendChild(row);

  const park = document.createElement('button');
  park.textContent = 'park current craft here';
  park.style.cssText = 'padding:4px 8px;font-size:11px;cursor:pointer;margin-right:6px;';
  park.onclick = () => {
    const m = ps.vehicle | 0;
    if (!isAboard(m)) return;
    ps.vehicleParked = 1;
    ps.vehicleParkedX = mapSt.worldX | 0;
    ps.vehicleParkedY = mapSt.worldY | 0;
    ps.vehicleParkedMode = m;
    ps.vehicle = 0;
    playTrack(vehicleInfo(0).music);
    refresh();
  };
  wrap.appendChild(park);

  const note = document.createElement('div');
  note.style.cssText = 'margin-top:12px;color:#888;font-size:11px;';
  note.innerHTML =
    'Terrain rules come from the cartridge\'s own mask table ($C6CD): a ship sails ocean and ' +
    'refuses land, a canoe adds shallow water to walking, flight crosses everything but the ' +
    'bit-4 barrier. Stepping onto a foot-walkable tile disembarks you and parks the craft ' +
    'behind you; walking back onto it boards again.';
  wrap.appendChild(note);

  root.appendChild(wrap);
  refresh();
  _root._iv = setInterval(refresh, 250);
}

export function unmount() {
  if (_root && _root._iv) clearInterval(_root._iv);
  _root = null; _status = null;
}
