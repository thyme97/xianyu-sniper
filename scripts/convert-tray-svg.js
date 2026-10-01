// 把用户设计的托盘图标源稿 tray-design.svg 渲染为 32x32 四态托盘 PNG（覆盖 tray-*.png）
// 用法：node scripts/convert-tray-svg.js [--preview]
//   --preview：额外在系统临时目录输出 256px 放大预览
// 依赖：@resvg/resvg-js（SVG 栅格化，本机 prebuild，无需浏览器）
// 流程：SVG 底板换色（第一个 fill="#FFE800" 即背景 rect）→ resvg 渲染 512px RGBA
//       → 面积平均降采样 → PNG 编码。底板自带圆角与透明四角，无需再切蒙版。
// 四态：绿=运行已登录 / 黄=扫描（原稿配色）/ 红=登录失效 / 灰=已停止；标签主体恒为黄色。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '../src/electron/assets');
const SRC = path.join(ASSETS, 'tray-design.svg');
const RENDER = 512;

// ---------- PNG 编码（与 convert-tray-jpg.js 相同的手写 chunk 实现） ----------
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
    raw[y * (size * 4 + 1)] = 0; // filter type 0
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

// ---------- 面积平均降采样（浮点加权，支持非整数比例） ----------
function resizeArea(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xs = sw / dw, ys = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const fy0 = dy * ys, fy1 = (dy + 1) * ys;
    for (let dx = 0; dx < dw; dx++) {
      const fx0 = dx * xs, fx1 = (dx + 1) * xs;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(fy0); sy < Math.min(sh, Math.ceil(fy1)); sy++) {
        const wy = Math.min(sy + 1, fy1) - Math.max(sy, fy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(fx0); sx < Math.min(sw, Math.ceil(fx1)); sx++) {
          const wx = Math.min(sx + 1, fx1) - Math.max(sx, fx0);
          if (wx <= 0) continue;
          const wt = wx * wy, o = (sy * sw + sx) * 4;
          r += src[o] * wt; g += src[o + 1] * wt; b += src[o + 2] * wt; a += src[o + 3] * wt;
          wsum += wt;
        }
      }
      const o2 = (dy * dw + dx) * 4;
      out[o2] = Math.round(r / wsum);
      out[o2 + 1] = Math.round(g / wsum);
      out[o2 + 2] = Math.round(b / wsum);
      out[o2 + 3] = Math.round(a / wsum);
    }
  }
  return out;
}

// ---------- SVG → size×size RGBA Buffer ----------
function renderSvg(svgText, size) {
  const resvg = new Resvg(svgText, { fitTo: { mode: 'width', value: RENDER } });
  const img = resvg.render();
  const pixels = Buffer.from(img.pixels); // RenderedImage.pixels: RGBA Uint8Array
  return resizeArea(pixels, img.width, img.height, size, size);
}

// ---------- 执行 ----------
const svgSource = fs.readFileSync(SRC, 'utf8');
const STATES = [
  { out: 'tray-ok.png', plate: '#22C55E' },
  { out: 'tray-scan.png', plate: '#FFE800' }, // 原稿黄
  { out: 'tray-error.png', plate: '#EF4444' },
  { out: 'tray-idle.png', plate: '#94A3B8' },
];
const SIZE = 32;
for (const st of STATES) {
  // 只替换第一个 #FFE800（背景 rect）；标签主体黄色保持不变
  const svgState = svgSource.replace('fill="#FFE800"', `fill="${st.plate}"`);
  fs.writeFileSync(path.join(ASSETS, st.out), encodePng(SIZE, renderSvg(svgState, SIZE)));
  console.log(`已生成 ${path.join(ASSETS, st.out)}  (底板 ${st.plate})`);
}

if (process.argv.includes('--preview')) {
  const prevDir = path.join(os.tmpdir(), 'xsniper-tray-preview');
  fs.mkdirSync(prevDir, { recursive: true });
  for (const st of STATES) {
    const svgState = svgSource.replace('fill="#FFE800"', `fill="${st.plate}"`);
    const f = path.join(prevDir, st.out.replace('.png', '@256.png'));
    fs.writeFileSync(f, encodePng(256, renderSvg(svgState, 256)));
    console.log(`预览 ${f}`);
  }
}
