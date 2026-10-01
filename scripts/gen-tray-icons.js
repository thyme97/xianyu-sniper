// 生成托盘状态图标（纯 Node 实现，无第三方依赖）
// 用法：node scripts/gen-tray-icons.js [--preview]
//   --preview：额外在系统临时目录输出 256px 放大预览（同一几何参数化重渲，非像素放大）
// 产物：src/electron/assets/tray-{ok|scan|error|idle}.png
// 造型：卡通小金鱼吉祥物（源自用户提供的吉祥物参考图：橙色圆身、左双叶尾、背鳍、大眼+高光、奶油肚）
//   32x32 RGBA，4x 超采样抗锯齿；鱼身恒为橙色，状态由右下角「白圈 + 彩点」徽章区分：
//   ok    绿徽章          运行中 · 已登录
//   scan  黄徽章          扫描中
//   error 红徽章          登录失效
//   idle  灰徽章 + 整鱼灰显 已停止
// PNG 编码：手写 IHDR/IDAT/IEND chunk（zlib.deflateSync + CRC32）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../src/electron/assets');

// ---------- PNG 编码 ----------
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

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状（隐式函数：<0 在内部） ----------
const inEllipse = (px, py, cx, cy, rx, ry, rot = 0) => {
  const dx = px - cx, dy = py - cy;
  const c = Math.cos(rot), s = Math.sin(rot);
  const x = (dx * c + dy * s) / rx;
  const y = (-dx * s + dy * c) / ry;
  return x * x + y * y - 1;
};
const inCircle = (px, py, cx, cy, r) => {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy - r * r;
};

// ---------- 吉祥物配色（取自参考图） ----------
const PAL = {
  body: [245, 146, 60],   // 橙
  fin: [238, 124, 45],    // 尾鳍/背鳍略深
  belly: [253, 230, 195], // 奶油肚
  eye: [66, 40, 28],      // 深棕大眼
  glint: [255, 255, 255], // 眼高光
};

// 金鱼形状列表（32 坐标系设计，k=size/32 缩放；数组顺序=叠放顺序，后者在上层）
// gray=true 时整鱼灰显（已停止态）
function fishShapes(k, gray = false) {
  const p = gray
    ? { body: [150, 158, 172], fin: [138, 146, 161], belly: [205, 210, 219], eye: [72, 80, 94], glint: [238, 240, 244] }
    : PAL;
  const E = (cx, cy, rx, ry, rot = 0) => (x, y) => inEllipse(x / k, y / k, cx, cy, rx, ry, rot);
  const O = (cx, cy, r) => (x, y) => inCircle(x / k, y / k, cx, cy, r);
  return [
    { sdf: E(17.5, 10.0, 4.2, 2.6, 0.15), color: p.fin },                        // 背鳍（藏在身后）
    { sdf: E(7.6, 12.5, 4.6, 3.0, 0.55), color: p.fin },                         // 尾鳍上叶（朝左上展开）
    { sdf: E(7.6, 21.5, 4.6, 3.0, -0.55), color: p.fin },                        // 尾鳍下叶（朝左下展开）
    { sdf: E(18, 17, 7.5, 6.2), color: p.body },                                 // 身体
    { sdf: E(17.5, 20.5, 5.2, 3.2), clip: E(18, 17, 7.5, 6.2), color: p.belly }, // 奶油肚（裁进身体）
    { sdf: O(21.5, 14.8, 2.3), color: p.eye },                                   // 大眼睛
    { sdf: O(20.6, 14.0, 0.75), color: p.glint },                                // 眼高光
  ];
}

// 右下角状态徽章：白圈 + 彩点
function badgeShapes(k, [r, g, b]) {
  const O = (cx, cy, rad) => (x, y) => inCircle(x / k, y / k, cx, cy, rad);
  return [
    { sdf: O(26, 26, 4.0), color: [255, 255, 255] },
    { sdf: O(26, 26, 2.9), color: [r, g, b] },
  ];
}

// 渲染：逐像素 S×S 超采样 → RGBA raw（每行前 1 字节 filter type=0）
function renderRgba(size, shapes) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
          let col = null;
          for (const sh of shapes) {
            if (sh.clip && sh.clip(px, py) >= 0) continue;
            if (sh.sdf(px, py) < 0) col = sh.color; // 取最上层命中色
          }
          if (col) { sr += col[0]; sg += col[1]; sb += col[2]; sa += 1; }
        }
      }
      if (sa > 0) {
        const o = rowStart + 1 + x * 4;
        raw[o] = Math.round(sr / sa);
        raw[o + 1] = Math.round(sg / sa);
        raw[o + 2] = Math.round(sb / sa);
        raw[o + 3] = Math.round((sa / (S * S)) * 255);
      }
    }
  }
  return raw;
}

// ---------- 生成 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const SIZE = 32;
const states = {
  'tray-ok.png': { badge: [34, 197, 94] },                 // 绿：运行中且登录有效
  'tray-scan.png': { badge: [245, 158, 11] },              // 黄：扫描中
  'tray-error.png': { badge: [239, 68, 68] },              // 红：登录失效
  'tray-idle.png': { badge: [150, 158, 172], gray: true }, // 灰：已停止（整鱼灰显）
};
for (const [name, { badge, gray }] of Object.entries(states)) {
  const shapes = [...fishShapes(SIZE / 32, gray), ...badgeShapes(SIZE / 32, badge)];
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(SIZE, renderRgba(SIZE, shapes)));
  console.log(`已生成 ${path.join(OUT_DIR, name)}`);
}

// 256px 放大预览（几何参数化重渲，便于人工检查造型）
if (process.argv.includes('--preview')) {
  const prevDir = path.join(os.tmpdir(), 'xsniper-tray-preview');
  fs.mkdirSync(prevDir, { recursive: true });
  for (const [name, { badge, gray }] of Object.entries(states)) {
    const shapes = [...fishShapes(8, gray), ...badgeShapes(8, badge)];
    const f = path.join(prevDir, name.replace('.png', '@256.png'));
    fs.writeFileSync(f, encodePng(256, renderRgba(256, shapes)));
    console.log(`预览 ${f}`);
  }
}
