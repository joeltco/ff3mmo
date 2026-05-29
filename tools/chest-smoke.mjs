// One-shot chest-open smoke against prod ff3mmo.com.
import { WebSocket } from 'ws';

const HOST = 'ff3mmo.com';
const EMAIL = 'chest-smoke@ff3mmo.local';
const PASSWORD = 'chest-smoke-pw-2026';
const HTTP = `https://${HOST}`;
const WSS  = `wss://${HOST}`;

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(HTTP + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function encodeNesName(s) {
  const out = [];
  for (const ch of s.slice(0, 8)) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57)        out.push(0x80 + (c - 48));
    else if (c >= 65 && c <= 90)   out.push(0x8A + (c - 65));
    else if (c >= 97 && c <= 122)  out.push(0xA4 + (c - 97));
  }
  return out;
}

(async () => {
  // Auth
  let r = await http('POST', '/api/register', { email: EMAIL, password: PASSWORD });
  let token;
  if (r.status === 201) {
    token = r.body.token;
    console.log('[smoke] registered fresh');
  } else {
    r = await http('POST', '/api/login', { email: EMAIL, password: PASSWORD });
    if (r.status !== 200) {
      console.error('[smoke] login failed', r.status, r.body);
      process.exit(1);
    }
    token = r.body.token;
    console.log('[smoke] logged in');
  }

  // WS connect
  const ws = new WebSocket(`${WSS}/api/ws?token=${token}`);
  ws.on('open', () => console.log('[smoke] ws open'));
  ws.on('error', (e) => console.error('[smoke] ws error', e.message));

  let helloed = false;
  let done = false;
  const t0 = Date.now();

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ready') {
      ws.send(JSON.stringify({
        type: 'hello',
        profile: { name: encodeNesName('SMOKE'), jobIdx: 0, level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 },
        loc: 'ur',
      }));
      ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
      helloed = true;
      console.log('[smoke] hello+slot sent — sending chest-open in 100ms');
      setTimeout(() => {
        // Send chest-open with a valid claim (Potion 0xA6 is in Ur chest pool)
        ws.send(JSON.stringify({
          type: 'chest-open',
          txnId: 1,
          mapId: 114,    // Ur overworld pool
          x: 5, y: 5,
          claim: { type: 'item', itemId: 0xA6 },
        }));
        console.log('[smoke] chest-open sent');
      }, 100);
    }
    if (msg.type === 'chest-result') {
      console.log('[smoke] chest-result:', JSON.stringify(msg));
      done = true;
      ws.close();
      if (msg.status === 'ok') {
        console.log(`[smoke] PASS (${Date.now() - t0}ms)`);
        process.exit(0);
      } else {
        console.error(`[smoke] FAIL: ${msg.reason}`);
        process.exit(1);
      }
    }
  });

  // Hard timeout
  setTimeout(() => {
    if (!done) {
      console.error('[smoke] TIMEOUT after 10s — helloed=' + helloed);
      process.exit(2);
    }
  }, 10000);
})();
