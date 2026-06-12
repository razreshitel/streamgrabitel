// Generates StreamGrabitel toolbar icons (16/48/128 px) as real PNG files,
// using only Node built-ins (zlib) — no native deps, no binary blobs in the repo.
// A rounded indigo square with a white "download into tray" glyph.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

// --- tiny PNG encoder (RGBA, 8-bit) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // add filter byte (0) at the start of every scanline
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing -----------------------------------------------------------------
const BG = [79, 70, 229]; // indigo #4F46E5
const FG = [255, 255, 255];

function inRoundedRect(x, y, s, r) {
  // corners
  const cx = x < r ? r : x > s - r ? s - r : x;
  const cy = y < r ? r : y > s - r ? s - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(s) {
  const rgba = Buffer.alloc(s * s * 4);
  const r = Math.round(s * 0.22);

  // glyph geometry: a downward arrow over a tray (classic "download")
  const cx = s / 2;
  const arrowTop = s * 0.20;
  const arrowMidY = s * 0.50;
  const shaftHalf = s * 0.085;
  const headHalf = s * 0.20;
  const trayY = s * 0.66;
  const trayThick = s * 0.085;
  const trayHalf = s * 0.26;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      if (!inRoundedRect(x + 0.5, y + 0.5, s, r)) {
        rgba[i + 3] = 0; // transparent outside rounded square
        continue;
      }
      let col = BG;
      // arrow shaft
      if (y >= arrowTop && y <= arrowMidY && Math.abs(x - cx) <= shaftHalf) col = FG;
      // arrow head (triangle pointing down), widest at arrowMidY
      if (y >= arrowMidY - headHalf && y <= arrowMidY) {
        const t = (arrowMidY - y) / headHalf; // 1 at top of head, 0 at tip
        if (Math.abs(x - cx) <= headHalf * t) col = FG;
      }
      // tray (open box at the bottom)
      const inTrayX = Math.abs(x - cx) <= trayHalf;
      if (inTrayX && y >= trayY && y <= trayY + trayThick) col = FG; // bottom
      if (y >= trayY - trayHalf * 0.55 && y <= trayY + trayThick) {
        if (Math.abs(Math.abs(x - cx) - trayHalf) <= trayThick * 0.6) col = FG; // sides
      }

      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(s, s, rgba);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = drawIcon(size);
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png  (${png.length} bytes)`);
}
console.log('Done generating icons.');
