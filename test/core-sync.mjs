/**
 * Drift guard: pick.core.js is generated from pick.js. If someone edits the ES
 * module and forgets the build step, the content script would keep running old
 * logic — exactly the kind of silent divergence that is hard to notice.
 *
 * Run: node test/core-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCore } from '../tools/build-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = buildCore();
const actual = readFileSync(join(root, 'pick.core.js'), 'utf8');

if (expected === actual) {
  console.log('ok   pick.core.js matches pick.js');
  process.exitCode = 0;
} else {
  console.log('FAIL pick.core.js is stale — run: node tools/build-core.mjs');
  process.exitCode = 1;
}
