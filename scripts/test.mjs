import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import esbuild from 'esbuild';

/**
 * The extension surfaces are browser bundles, so tests are bundled the same way
 * and run through node's built-in test runner. Only browser-agnostic modules
 * (shared/*, transform, planner) are exercised here.
 */
await rm('.tmp', { recursive: true, force: true });
await mkdir('.tmp', { recursive: true });

const suites = ['core', 'web'];
await Promise.all(
  suites.map((name) =>
    esbuild.build({
      entryPoints: [`tests/${name}.test.ts`],
      outfile: `.tmp/${name}.test.mjs`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['node:test', 'node:assert'],
      logLevel: 'warning',
    }),
  ),
);

const result = spawnSync('node', ['--test', ...suites.map((name) => `.tmp/${name}.test.mjs`)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
