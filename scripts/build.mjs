import { build } from 'esbuild';
await build({ entryPoints: ['src/cli/main.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/tide.mjs', banner: { js: '#!/usr/bin/env node' } });
