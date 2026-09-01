import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Serves the demo applications on separate ports so that they are distinct
 * origins (http://localhost:4321 vs http://localhost:4322 …). The extension keys
 * providers by origin, so same-port hosting would merge the apps.
 */
const APPS = [
  { port: 4321, root: resolve('demo/orders'), name: 'Northwind Orders' },
  { port: 4322, root: resolve('demo/support'), name: 'Helpdesk Support' },
];
const SHARED = resolve('demo/shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function safeJoin(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, clean);
  return full.startsWith(root) ? full : null;
}

for (const app of APPS) {
  createServer(async (req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    const target = urlPath.startsWith('/shared/')
      ? safeJoin(SHARED, urlPath.slice('/shared'.length))
      : safeJoin(app.root, urlPath === '/' ? '/index.html' : urlPath);

    if (!target) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(app.port, () => {
    console.log(`[demo] ${app.name} → http://localhost:${app.port}`);
  });
}
