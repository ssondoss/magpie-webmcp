import { cp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import esbuild from 'esbuild';

/**
 * Builds the Magpie website into `web-dist/` — a folder of static files, which is
 * all any host needs. `--serve` runs it locally with a rebuild on each request.
 */
const watch = process.argv.includes('--watch') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');
const outdir = 'web-dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('web/index.html', `${outdir}/index.html`);
await cp('public/icons', `${outdir}/icons`, { recursive: true });

const options = {
  entryPoints: { main: 'web/main.tsx' },
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'safari17', 'firefox121'],
  loader: { '.css': 'css' },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}

console.log(`[web] built → ./${outdir}`);

if (serve) {
  const root = resolve(outdir);
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
  };
  createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    const target = join(root, clean === '/' ? 'index.html' : clean);
    try {
      const body = await readFile(target.startsWith(root) ? target : join(root, 'index.html'));
      response.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      // Single-page app: unknown paths fall back to the shell.
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(await readFile(join(root, 'index.html')));
    }
  }).listen(4173, () => console.log('[web] http://localhost:4173'));
}
