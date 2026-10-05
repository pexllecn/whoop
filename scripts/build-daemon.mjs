// Bundles the BLE daemon into dist/daemon.mjs so it can run with plain `node`
// (used by the macOS LaunchAgent). Native modules stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/lib/daemon/main.ts'],
  outfile: 'dist/daemon.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3', '@abandonware/noble', 'ws', 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
