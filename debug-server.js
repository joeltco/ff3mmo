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

  // Inject DEBUG_BOSS flag into index.html
  if (path === '/index.html') {
    try {
      let html = await readFile(join('.', path), 'utf8');
      html = html.replace(
        '<script type="module">',
        '<script>window.DEBUG_BOSS = true;</script>\n  <script type="module">'
      );
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(html);
      return;
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  }

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
}).listen(3001, () => console.log('Debug server (boss room) at http://localhost:3001'));
