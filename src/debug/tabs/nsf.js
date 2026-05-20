// NSF tab — audition FF3 NSF tracks by ear (find jingles/songs like the inn
// rest tune). Uses playTrack(), which tears down + recreates the emulator per
// call, so switching tracks actually restarts — unlike the SFX channel, which
// reuses its emu and wouldn't change sounds (why /sfx didn't work).

import { playTrack, stopMusic, playSFX, stopSFX } from '../../music.js';

let _cur = 0x57;     // last track tried (the inn capture's screechy guess — a starting point)
let _nowEl = null;

function _parse(v) {
  const s = String(v).trim().toLowerCase();
  const n = s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function _hex(n) { return '0x' + n.toString(16) + ' (' + n + ')'; }

export function mount(root) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:14px;color:#ccc;font:12px monospace;line-height:1.7;';
  wrap.innerHTML = `
    <div style="color:#c8a832;font-size:11px;margin-bottom:10px">NSF — FF3 track audition (find by ear)</div>
    <div style="margin-bottom:8px">Track:
      <input id="nsf-track" value="0x57" style="width:80px;background:#111;color:#6f6;border:1px solid #444;padding:3px 6px;font:12px monospace">
      <span style="color:#777">(dec or 0xNN)</span></div>
    <div id="nsf-now" style="color:#6cf;margin:8px 0">— stopped —</div>`;
  _nowEl = wrap.querySelector('#nsf-now');
  const inp = () => wrap.querySelector('#nsf-track');

  const playSong = (n) => { stopSFX(); playTrack(n); _cur = n; _nowEl.textContent = '▶ song  ' + _hex(n) + '  (loops)'; };
  const playOne  = (n) => { stopMusic(); playSFX(n); _cur = n; _nowEl.textContent = '▶ once  ' + _hex(n) + '  (SFX channel)'; };
  const stop     = () => { stopMusic(); stopSFX(); _nowEl.textContent = '— stopped —'; };

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px';
  const mk = (label, fn, color) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `background:${color || '#234'};color:#cde;border:1px solid #456;padding:5px 10px;font:12px monospace;cursor:pointer`;
    b.onclick = fn;
    return b;
  };
  row.appendChild(mk('◀ prev', () => { const n = Math.max(0, _cur - 1); inp().value = '0x' + n.toString(16); playSong(n); }));
  row.appendChild(mk('▶ Play song', () => { const n = _parse(inp().value); if (n != null) playSong(n); }, '#2a4'));
  row.appendChild(mk('Play once', () => { const n = _parse(inp().value); if (n != null) playOne(n); }));
  row.appendChild(mk('next ▶', () => { const n = _cur + 1; inp().value = '0x' + n.toString(16); playSong(n); }));
  row.appendChild(mk('■ Stop', stop, '#622'));
  wrap.appendChild(row);

  const note = document.createElement('div');
  note.style.cssText = 'color:#888;font-size:11px;border-top:1px solid #333;padding-top:8px';
  note.innerHTML = `Inn rest-jingle candidates from the REC OAM <code>$7F49</code> strip:
    <b style="color:#cda">0x46, 0x4b, 0x57, 0x71, 0x72</b> (0x57 screeched).<br>
    Sweep with ◀/▶ or type a track + Play. When you hear the inn rest tune, note the
    number — that's what gets wired into the bed scene.`;
  wrap.appendChild(note);

  root.appendChild(wrap);
}

export function unmount() {
  stopMusic(); stopSFX();
  _nowEl = null;
}
