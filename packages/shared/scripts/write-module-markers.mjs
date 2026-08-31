import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node decides whether a `.js` file is ESM or CommonJS from the nearest
 * package.json `type` field. Since this package emits both flavours into
 * dist/esm and dist/cjs, each output directory needs its own marker file.
 */
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

await writeFile(resolve(dist, 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
await writeFile(
  resolve(dist, 'cjs', 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
