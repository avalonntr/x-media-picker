/**
 * Generates icons/icon{16,48,128}.png with zero dependencies: a rounded dark tile,
 * two crossing bars for the X, and a blue download arrow. PNG is encoded by hand
 * (signature + IHDR + IDAT + IEND) so no image library is needed.
 *
 * Run: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32 } from './lib/crc32.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function draw(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.22;
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const alpha = a / 255;
    px[i] = lerp(px[i], r, alpha);
    px[i + 1] = lerp(px[i + 1], g, alpha);
    px[i + 2] = lerp(px[i + 2], b, alpha);
    px[i + 3] = Math.max(px[i + 3], a);
  };

  // rounded tile with a vertical gradient
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x + 0.5, size - x - 0.5);
      const cy = Math.min(y + 0.5, size - y - 0.5);
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      const t = y / size;
      set(x, y, lerp(27, 11, t), lerp(39, 16, t), lerp(51, 22, t), 255);
    }
  }

  // X glyph: two diagonal bars
  const stroke = Math.max(1.6, size * 0.085);
  const pad = size * 0.26;
  for (let t = 0; t <= 1; t += 0.0015) {
    const x1 = pad + t * (size - 2 * pad);
    const y1 = pad + t * (size - 2 * pad);
    const x2 = size - pad - t * (size - 2 * pad);
    const y2 = pad + t * (size - 2 * pad);
    for (let o = -stroke; o <= stroke; o += 0.4) {
      set(Math.round(x1 + o * 0.7), Math.round(y1 + o * 0.7), 232, 238, 245, 235);
      set(Math.round(x2 - o * 0.7), Math.round(y2 + o * 0.7), 232, 238, 245, 235);
    }
  }

  // download arrow (blue), drawn on top
  const shaftW = Math.max(2, size * 0.09);
  const cx = size / 2;
  const top = size * 0.42;
  const bottom = size * 0.68;
  for (let y = top; y < bottom; y++) {
    for (let x = cx - shaftW / 2; x < cx + shaftW / 2; x++) set(Math.round(x), Math.round(y), 96, 165, 250, 255);
  }
  const headH = size * 0.13;
  for (let y = 0; y < headH; y++) {
    const half = (size * 0.145) * (1 - y / headH);
    for (let x = cx - half; x < cx + half; x++) set(Math.round(x), Math.round(bottom + y), 59, 130, 246, 255);
  }
  const barY = bottom + headH + size * 0.05;
  const barH = Math.max(1.5, size * 0.05);
  for (let y = barY; y < barY + barH; y++) {
    for (let x = cx - size * 0.19; x < cx + size * 0.19; x++) set(Math.round(x), Math.round(y), 59, 130, 246, 255);
  }

  return px;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, draw(size));
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`${file}  ${png.length} bytes`);
}
