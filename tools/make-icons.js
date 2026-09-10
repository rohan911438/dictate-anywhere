// Generates placeholder PNG icons (indigo square + white mic glyph) with zero
// dependencies. Run: node tools/make-icons.js   (or npm run icons)
// Replace icons/*.png with real artwork before shipping.

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function makePng(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 already zero (compression, filter, interlace)

  const bg = [79, 70, 229, 255]; // indigo
  const fg = [255, 255, 255, 255]; // white

  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2;
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const capsule = Math.abs(x - cx) <= size * 0.19 && y >= size * 0.17 && y <= size * 0.55;
      const stem = Math.abs(x - cx) <= size * 0.035 && y > size * 0.55 && y <= size * 0.73;
      const base = Math.abs(x - cx) <= size * 0.19 && y > size * 0.73 && y <= size * 0.79;
      const px = capsule || stem || base ? fg : bg;
      const o = rowStart + 1 + x * 4;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = px[3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}
