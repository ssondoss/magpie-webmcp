import { cp, mkdir, rm } from 'node:fs/promises';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('public', outdir, { recursive: true });

const common = {
  bundle: true,
  target: ['chrome120'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

/** Each extension surface is a separate bundle: MV3 has no shared module graph. */
const targets = [
  { ...common, entryPoints: { background: 'src/background/index.ts' }, format: 'esm', outdir },
  { ...common, entryPoints: { 'content-main': 'src/content/main-world.ts' }, format: 'iife', outdir },
  { ...common, entryPoints: { 'content-bridge': 'src/content/bridge.ts' }, format: 'iife', outdir },
  {
    ...common,
    entryPoints: { sidepanel: 'src/sidepanel/main.tsx' },
    format: 'iife',
    outdir,
    loader: { '.css': 'css' },
  },
];

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching for changes — load ./dist as an unpacked extension');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log('[build] done — load ./dist as an unpacked extension');
}
