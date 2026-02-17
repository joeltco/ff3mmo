import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.nes': 'application/octet-stream', '.bin': 'application/octet-stream',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  try {
    const data = await readFile(join('.', path));
    const ext = extname(path);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(3000, () => console.log('No-cache server at http://localhost:3000'));
