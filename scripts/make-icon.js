'use strict';
// Generates assets/icon.png (256x256, RGBA) with zero dependencies: a rounded blue tile,
// a white screen outline, a play triangle and the three "cast" arcs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256, SS = 3; // supersampling factor
const BG = [125, 190, 255], FG = [11, 26, 42];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Geometry (256 grid): screen frame with its bottom-left corner cut away, three quarter arcs
// radiating from that corner (the Cast glyph), and a play triangle inside the screen.
const FRAME = { x0: 42, y0: 70, x1: 214, y1: 186, r: 16, stroke: 14 }; // 172x116 box centred at (128,128)
const CENTER = { x: FRAME.x0, y: FRAME.y1 };           // arc centre = outer bottom-left corner
const ARCS = [[20, 30], [42, 52], [64, 74]];            // [inner, outer] radii of each band
const DOT = 9, CUT = 86;                                // dot radius; frame is erased within CUT of the centre
function inFrame(x, y) {
  const o = inRoundRect(x, y, FRAME.x0, FRAME.y0, FRAME.x1, FRAME.y1, FRAME.r);
  const s = FRAME.stroke;
  const i = inRoundRect(x, y, FRAME.x0 + s, FRAME.y0 + s, FRAME.x1 - s, FRAME.y1 - s, FRAME.r - s + 2);
  if (!o || i) return false;
  return Math.hypot(x - CENTER.x, y - CENTER.y) >= CUT;
}
function inTriangle(x, y) {
  const ax = 118, ay = 102, bx = 118, by = 154, cx = 164, cy = 128; // nudged up-right of centre to balance the arcs
  const s = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  const t = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const u = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
}
function inArcs(x, y) {
  if (x < CENTER.x || y > CENTER.y) return false;      // upper-right quadrant only
  const d = Math.hypot(x - CENTER.x, y - CENTER.y);
  if (d <= DOT) return true;
  return ARCS.some(([a, b]) => d >= a && d <= b);
}
function sample(x, y) {
  if (!inRoundRect(x, y, 8, 8, 248, 248, 56)) return null;
  return inFrame(x, y) || inTriangle(x, y) || inArcs(x, y) ? FG : BG;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    const n = SS * SS, o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const cov = a / n;
    raw[o] = a ? Math.round(r / (a / 255)) : 0;
    raw[o + 1] = a ? Math.round(g / (a / 255)) : 0;
    raw[o + 2] = a ? Math.round(b / (a / 255)) : 0;
    raw[o + 3] = Math.round(cov);
  }
}

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
