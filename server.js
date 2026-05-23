import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { handleAPI } from './api.js';
import { attachWebSocketPresence, getPlayerCounts } from './ws-presence.js';

// Boot timestamp for the /health uptime field. `process.uptime()` works too
// but we want a stable wall-clock anchor in case the route adds more later.
const _bootMs = Date.now();

const { version } = JSON.parse(await readFile('./package.json', 'utf8'));

// Beta/dev gate password, injected into index.html's #pw-gate (a soft
// client-side "invite only" curtain — not real auth). Per-server via env:
//   unset            → 'ff3dev'  (default closed-beta gate, e.g. local/dev)
//   GATE_PASSWORD=off → ''        (gate disabled — open beta server)
//   GATE_PASSWORD=xyz → 'xyz'     (custom gate password)
// So the same codebase runs gated on dev and open (or differently keyed) on
// the beta server just by changing the env at launch.
const GATE_PASSWORD = (() => {
  const v = process.env.GATE_PASSWORD;
  if (v === undefined) return 'ff3dev';
  return v.trim().toLowerCase() === 'off' ? '' : v;
})();
// Escape for safe embedding inside a single-quoted JS string literal.
const GATE_PASSWORD_JS = GATE_PASSWORD.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
// Hide the gate from the first paint when disabled — the unlock script is a
// deferred module, so without this an open server would flash the gate.
const GATE_DISPLAY = GATE_PASSWORD ? '' : 'display:none';
console.log('Gate: ' + (GATE_PASSWORD ? 'ON' : 'OFF (open)'));

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.nes': 'application/octet-stream', '.bin': 'application/octet-stream',
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // /health — unauthed, unrate-limited status endpoint for external uptime
  // monitors (UptimeRobot etc.). Cheap and deliberately stable in shape.
  if (url.pathname === '/health' && req.method === 'GET') {
    const counts = getPlayerCounts();
    const body = JSON.stringify({
      status: 'ok',
      version,
      uptimeSec: Math.floor((Date.now() - _bootMs) / 1000),
      players: counts.visible,
      playersTotal: counts.total,
      gate: GATE_PASSWORD ? 'on' : 'off',
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    // Guard every API handler: a malformed payload (e.g. a non-string field
    // that throws on a string method) must return 500, not reject the async
    // handler and leave the client socket hanging with no response.
    try {
      const handled = await handleAPI(req, res);
      if (handled) return;
    } catch (e) {
      console.error('[api] handler threw for ' + url.pathname + ':', e && e.message);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Internal error"}'); }
      return;
    }
  }

  // Static files
  let path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  try {
    let data = await readFile(join('.', path));
    const ext = extname(path);
    if (ext === '.html') data = Buffer.from(data.toString()
      // replaceAll, not replace — there are TWO `{{VERSION}}` occurrences
      // in index.html (one in a comment, one in `var BUILD = 'v{{VERSION}}'`)
      // and the BUILD one was leaking through as a literal, ending up in
      // `localStorage.ff3_build` and from there into every bug-report
      // payload as `[v{{VERSION}}]`. v1.7.627.
      .replaceAll('{{VERSION}}', version)
      .replaceAll('{{GATE_PASSWORD}}', GATE_PASSWORD_JS)
      .replaceAll('{{GATE_DISPLAY}}', GATE_DISPLAY));
    // Cache-busting handshake — when the client's version-gate detects a
    // stale build it reloads with `?_v=<build>`. We respond with
    // `Clear-Site-Data: "cache"` so the browser drops every cached resource
    // for this origin BEFORE the new index.html's modules import. Targets
    // mobile Firefox specifically, which ignores `Cache-Control: no-store`
    // in some configurations. P1 #4.
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
    // NOTE: previously set `Clear-Site-Data: "cache"` on `?_v=` reloads as a
    // belt-and-suspenders for mobile Firefox stale-module loads. Pulled
    // v1.7.621 — some browsers were interpreting it broader than spec and
    // wiping IndexedDB (ROM cache + saves) between sessions every time we
    // shipped a version bump. `Cache-Control: no-store, no-cache,
    // must-revalidate` above is the actual HTTP-cache defense. If mobile
    // Firefox stale-module errors return, revisit with a narrower
    // directive instead of `"cache"`.
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Attach WebSocket presence at /api/ws (auth via ?token=<JWT>).
attachWebSocketPresence(httpServer);

httpServer.listen(3000, () => console.log('Server at http://localhost:3000'));
