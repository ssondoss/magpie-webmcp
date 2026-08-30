import { cp, mkdir, rm } from 'node:fs/promises';

/**
 * Packages each demo app as a self-contained static folder.
 *
 * They must deploy to *separate origins* — the whole point of the cross-site demo
 * is that Orders and Support are different sites, and same-origin hosting would
 * collapse them into one provider in the capability registry.
 */
const APPS = ['orders', 'support', 'metals', 'wallet'];
const outdir = 'demo-dist';

await rm(outdir, { recursive: true, force: true });

for (const app of APPS) {
  const target = `${outdir}/${app}`;
  await mkdir(target, { recursive: true });
  await cp(`demo/${app}`, target, { recursive: true });
  // The pages reference /shared/*, so each deployment needs its own copy at root.
  await cp('demo/shared', `${target}/shared`, { recursive: true });
  console.log(`[demos] built → ./${target}`);
}
