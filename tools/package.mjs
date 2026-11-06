/**
 * Builds the two distributable zips into dist/:
 *
 *   x-media-picker-v<version>.zip        injects on every site (matches everything)
 *   x-media-picker-v<version>-x-only.zip injects only on x.com / twitter.com
 *
 * The x-only build keeps its network access to twimg / fxtwitter, because the
 * service worker needs those hosts to resolve blob videos into real MP4s.
 *
 * Zip is written by hand (deflate + CRC-32) so the build needs no dependencies.
 * Run: node tools/package.mjs
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from './lib/crc32.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

const SKIP_DIRS = new Set(['dist', 'tools', 'test', 'node_modules', '.git']);
const SKIP_FILES = new Set(['.DS_Store', '.gitignore', '.gitattributes']);

// Fixed timestamp keeps the archive byte-stable across builds.
const DOS_TIME = (12 << 11) | (0 << 5) | 0; // 12:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

async function collect(dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    if (entry.name.endsWith('.zip')) continue;
    const full = join(dir, entry.name);
    out.push({ name: relative(root, full).split(sep).join('/'), data: await readFile(full) });
  }
  return out;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const body = compressed.length < data.length ? compressed : data;
    const method = body === compressed ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function xOnlyManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  const sites = ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*'];
  copy.content_scripts[0].matches = sites;
  // Runtime fetches (syndication / fxtwitter) need their hosts listed separately.
  copy.host_permissions = [...sites, '*://*.twimg.com/*', '*://api.fxtwitter.com/*'];
  copy.name = `${copy.name} (X only)`;
  return copy;
}

const files = await collect();
const manifest = JSON.parse((await readFile(join(root, 'manifest.json'), 'utf8')).toString('utf8'));
const version = manifest.version;

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const builds = [
  { name: `x-media-picker-v${version}.zip`, patch: null },
  { name: `x-media-picker-v${version}-x-only.zip`, patch: xOnlyManifest },
];

for (const build of builds) {
  const entries = files.map((file) =>
    build.patch && file.name === 'manifest.json'
      ? { name: file.name, data: Buffer.from(`${JSON.stringify(build.patch(manifest), null, 2)}\n`, 'utf8') }
      : file,
  );
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const buffer = zip(entries);
  await writeFile(join(distDir, build.name), buffer);
  console.log(`${build.name}  ${entries.length} files  ${(buffer.length / 1024).toFixed(1)} KB`);
}
