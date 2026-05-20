import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { handleAPI } from './api.js';
import { attachWebSocketPresence } from './ws-presence.js';

const { version } = JSON.parse(await readFile('./package.json', 'utf8'));

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.nes': 'application/octet-stream', '.bin': 'application/octet-stream',
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

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
    if (ext === '.html') data = Buffer.from(data.toString().replace('{{VERSION}}', version));
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
    if (ext === '.html' && url.searchParams.get('_v')) {
      headers['Clear-Site-Data'] = '"cache"';
    }
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
