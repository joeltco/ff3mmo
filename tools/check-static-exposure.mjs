#!/usr/bin/env node
// Drives server.js's actual HTTP handler against disposable public/private
// fixtures. Only API/presence dependencies and the listen port are replaced;
// no production database is opened, and static routing is never copied here.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { request, createServer } from 'node:http';

const serverURL = new URL('../server.js', import.meta.url).href;
const apiURL = new URL('../api.js', import.meta.url).href;
const wsURL = new URL('../ws-presence.js', import.meta.url).href;
const originalCwd = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'ff3-static-exposure-'));
const root = join(temp, 'project');
await mkdir(root);
async function fixture(path, body = 'private-fixture') {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, body);
}
let server;
globalThis.__staticGateCreateServer = handler => {
  server = createServer(handler);
  const listen = server.listen.bind(server);
  server.listen = () => listen(0, '127.0.0.1');
  return server;
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === serverURL && (specifier === 'http' || specifier === 'node:http')) {
      return { url: 'static-gate:http', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    let source;
    if (url === apiURL) source = 'export const handleAPI = async () => false; export const setLogoutAllHook = () => {};';
    if (url === wsURL) source = 'export const attachWebSocketPresence = () => {}; export const getPlayerCounts = () => ({visible:0,total:0}); export const revokeWsBeforeIat = () => {};';
    if (url === 'static-gate:http') source = 'export const createServer = globalThis.__staticGateCreateServer;';
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
function get(path) {
  return new Promise((resolve, reject) => {
    // Raw request path: fetch/URL would normalize traversal before testing it.
    const req = request({ host: '127.0.0.1', port: server.address().port, path }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject); req.end();
  });
}
try {
  await fixture('package.json', '{"version":"static-gate"}');
  const allowed = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png',
    'apple-touch-icon.png', 'lib/libgme.js', 'lib/jsnes.min.js', 'patches/ff3-awj.ips',
    'src/main.js', 'src/data/monsters.js', 'src/debug/spell-captures.json', 'src/debug/scenes/index.json'];
  for (const path of allowed) await fixture(path, path === 'index.html' ? '{{VERSION}} {{VERSION}}' : 'public-fixture');
  const privatePaths = ['ff3mmo.db', '.git/config', 'CLAUDE.local.md', 'src/notes.local.md',
    'node_modules/example/index.js', '.env', 'secrets/key.pem', 'api.js', 'server.js',
    'data/ff3mmo.sqlite', 'src/.env', 'src/.git/config', 'src/node_modules/test.js', 'src/save.js.bak'];
  for (const path of privatePaths) await fixture(path);
  await writeFile(join(temp, 'outside.js'), 'outside-private-fixture');
  await symlink(join(temp, 'outside.js'), join(root, 'src/outside.js'));
  await symlink(join(root, 'ff3mmo.db'), join(root, 'src/inside.js'));
  process.chdir(root);
  await import(serverURL);
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  let failures = 0;
  const refused = [...privatePaths.map(p => '/' + p), '/src/outside.js', '/src/inside.js',
    '/%2egit/config', '/data/../ff3mmo.db', '/data/%2e%2e/ff3mmo.db',
    '/..%2foutside.js', '/%2e%2e%2foutside.js', '/src/%2e%2e%2f%2e%2e%2foutside.js',
    '/src/..%5c..%5coutside.js', '/%252e%252e%252foutside.js', '/src/main.js%00'];
  for (const path of refused) {
    const result = await get(path);
    if (![403, 404].includes(result.status)) {
      console.error(`FAIL ${path}: expected 403 or 404, got ${result.status}`); failures++;
    }
  }
  assert.equal(failures, 0, `${failures} private paths were not refused`);
  for (const path of ['/', ...allowed.map(p => '/' + p)]) assert.equal((await get(path)).status, 200, path);
  const html = await get('/?_v=static-gate');
  assert.equal(html.body, 'static-gate static-gate');
  assert.match(html.headers['cache-control'], /no-store/);
  assert.equal((await get('/src/main.js?version=1')).status, 200);
  for (const path of ['/%', '/%zz']) assert.equal((await get(path)).status, 400);
  assert.equal(JSON.parse((await get('/health')).body).status, 'ok');
  console.log(`check-static-exposure: OK — ${refused.length} private/traversal paths refused; public assets, templates and health work`);
} finally {
  hooks.deregister();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  delete globalThis.__staticGateCreateServer;
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
