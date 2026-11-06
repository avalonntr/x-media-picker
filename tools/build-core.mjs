/**
 * Generates pick.core.js from pick.js so the logic exists exactly once.
 *
 * pick.js is an ES module (imported by tests and by the popup/background);
 * a content script is a classic script, so it needs a version that attaches to
 * globalThis instead of using `export`. Previously the content script fetched
 * pick.js at runtime with a dynamic import() — which the host page's CSP can
 * refuse, and when it does the whole extension dies silently. This build step
 * removes that failure mode.
 *
 * Run: node tools/build-core.mjs   (test/core-sync.mjs fails if the output is stale)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export function buildCore() {
  const source = readFileSync(join(root, 'pick.js'), 'utf8');
  const names = [];
  const body = source
    .replace(/^export function\s+([A-Za-z0-9_$]+)/gm, (_m, name) => {
      names.push(name);
      return `function ${name}`;
    })
    .replace(/^export const\s+([A-Za-z0-9_$]+)\s*=/gm, (_m, name) => {
      names.push(name);
      return `const ${name} =`;
    });

  if (names.length === 0) throw new Error('build-core: no exports found in pick.js');
  if (/^\s*(import|export)\s/m.test(body)) {
    throw new Error('build-core: pick.js still contains module syntax that a classic script cannot parse');
  }

  return `/* GENERATED from pick.js by tools/build-core.mjs — do not edit by hand. */
(function attachPick() {
  'use strict';
${body
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}

  globalThis.XMPPick = { ${names.join(', ')} };
})();
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(root, 'pick.core.js');
  writeFileSync(out, buildCore(), 'utf8');
  console.log(`wrote ${out} (${buildCore().length} bytes)`);
}
