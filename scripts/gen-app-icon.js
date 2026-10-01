// 把托盘设计稿 tray-design.svg 渲染为 Windows 应用图标 build/icon.ico
// 用法：node scripts/gen-app-icon.js
// 依赖：@resvg/resvg-js（与 convert-tray-svg.js 共用）
// ICO 采用 PNG 内嵌格式（Vista+ 支持）：ICONDIR + 单个 256px ICONDIRENTRY + PNG 数据
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/electron/assets/tray-design.svg');
const OUT = path.resolve(__dirname, '../build/icon.ico');
const SIZE = 256;

// ---------- PNG 编码（与 convert-tray-svg.js 相同实现） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- SVG → 256px PNG → ICO ----------
const svg = fs.readFileSync(SRC, 'utf8');
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } });
const img = resvg.render();
const png = encodePng(SIZE, Buffer.from(img.pixels));

// ICONDIRENTRY：width/height 写 0 表示 256px；PNG 内嵌从 offset 22 开始
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; // 256px
entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);  // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset = 6 + 16

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, entry, png]));
console.log(`已生成 ${OUT}（${SIZE}px PNG-in-ICO，${(header.length + entry.length + png.length) / 1024 | 0}KB）`);
