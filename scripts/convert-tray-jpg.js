// 把状态图转换为 32x32 带透明的托盘 PNG（覆盖 tray-*.png）
// 用法：node scripts/convert-tray-jpg.js [--preview]
//   --preview：额外在系统临时目录输出 256px 放大预览（同一管线重渲）
// 两种来源模式：
//   bleed：SenseNova 生成的全出血插画（主体占满画面），按比例窗口 crop:[x0,y0,x1,y1] 裁切，
//          背景色即底板色，无需包围盒检测；裁切窗口取自逐张目检（避开四角多余元素）。
//   tile： 用户自制的「圆角方块底板」图（原始 JPG 已随清理删除，此模式为回退保留），走包围盒 + ZOOM 放大。
// 共同管线：JPEG 解码 → 裁剪正方形区域 → 面积平均降采样
//           → 圆角矩形 alpha 蒙版（4x 超采样，抗白边）→ PNG 编码
// 映射：绿色→tray-ok / 黄色→tray-scan / 红色→tray-error / 灰色→tray-idle
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '../src/electron/assets');

// ---------- PNG 编码（与 gen-tray-icons.js 相同的手写 chunk 实现） ----------
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

// ---------- 底色估计：四角 10px 方块的中位数 ----------
function bgColor(data, w, h) {
  const s = 10;
  const samples = { r: [], g: [], b: [] };
  for (const [ox, oy] of [[0, 0], [w - s, 0], [0, h - s], [w - s, h - s]]) {
    for (let y = oy; y < oy + s; y++) {
      for (let x = ox; x < ox + s; x++) {
        const o = (y * w + x) * 4;
        samples.r.push(data[o]); samples.g.push(data[o + 1]); samples.b.push(data[o + 2]);
      }
    }
  }
  const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [med(samples.r), med(samples.g), med(samples.b)];
}

// ---------- 内容包围盒：与底色差异明显的像素占比 > 25% 的行/列才计入 ----------
function contentBBox(data, w, h, bg) {
  const TH = 10;      // 单通道差异阈值（灰色图外圈浅灰底/白色方块对比低，需较敏感）
  const RATIO = 0.25; // 行/列内差异像素占比阈值（排除角落水印等小面积元素）
  const diff = (o) =>
    Math.abs(data[o] - bg[0]) > TH || Math.abs(data[o + 1] - bg[1]) > TH || Math.abs(data[o + 2] - bg[2]) > TH;
  const rows = [], cols = [];
  const colCnt = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = 0; x < w; x++) {
      if (diff((y * w + x) * 4)) { cnt++; colCnt[x]++; }
    }
    rows.push(cnt > w * RATIO);
  }
  const first = (a) => a.indexOf(true), last = (a) => a.lastIndexOf(true);
  let y0 = first(rows), y1 = last(rows);
  for (let x = 0; x < w; x++) cols.push(colCnt[x] > h * RATIO);
  let x0 = first(cols), x1 = last(cols);
  if (y0 < 0 || x0 < 0) return null; // 整图近底色，兜底
  // 正方形化（以中心扩展）
  let side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  if (side < Math.min(w, h) * 0.55) return null; // 检测塌缩到主体（如低对比方块），走居中兜底
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  x0 = Math.round(cx - side / 2); y0 = Math.round(cy - side / 2);
  x1 = x0 + side - 1; y1 = y0 + side - 1;
  return {
    x: Math.max(0, x0), y: Math.max(0, y0),
    w: Math.min(w, x1 + 1) - Math.max(0, x0),
    h: Math.min(h, y1 + 1) - Math.max(0, y0),
  };
}

// ---------- 面积平均降采样（浮点加权，支持非整数比例） ----------
function resizeArea(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xs = sw / dw, ys = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const fy0 = dy * ys, fy1 = (dy + 1) * ys;
    for (let dx = 0; dx < dw; dx++) {
      const fx0 = dx * xs, fx1 = (dx + 1) * xs;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let sy = Math.floor(fy0); sy < Math.min(sh, Math.ceil(fy1)); sy++) {
        const wy = Math.min(sy + 1, fy1) - Math.max(sy, fy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(fx0); sx < Math.min(sw, Math.ceil(fx1)); sx++) {
          const wx = Math.min(sx + 1, fx1) - Math.max(sx, fx0);
          if (wx <= 0) continue;
          const wt = wx * wy, o = (sy * sw + sx) * 4;
          r += src[o] * wt; g += src[o + 1] * wt; b += src[o + 2] * wt;
          wsum += wt;
        }
      }
      const o2 = (dy * dw + dx) * 4;
      out[o2] = Math.round(r / wsum);
      out[o2 + 1] = Math.round(g / wsum);
      out[o2 + 2] = Math.round(b / wsum);
      out[o2 + 3] = 255;
    }
  }
  return out;
}

// ---------- 圆角矩形 alpha 蒙版（4x 超采样；inset 收边抗白边） ----------
function rrAlpha(size, inset, radiusRatio) {
  const S = 4;
  const alpha = new Uint8Array(size * size);
  const half = size / 2 - inset;
  const r = radiusRatio * (size - 2 * inset);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
          const qx = Math.abs(px - c) - (half - r);
          const qy = Math.abs(py - c) - (half - r);
          const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
          const d = Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - r;
          if (d < 0) hit++;
        }
      }
      alpha[y * size + x] = Math.round((hit / (S * S)) * 255);
    }
  }
  return alpha;
}

// ---------- 单张转换：JPG → size×size RGBA Buffer ----------
// src = { file, mode, crop? }：bleed 用比例窗口裁切；tile 走包围盒 + ZOOM 放大
function convert(file, size, src) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const data = Buffer.from(img.data); // jpeg-js 返回 Uint8Array，转 Buffer 便于 copy
  let box;
  if (src.mode === 'bleed') {
    // 全出血插画：按比例窗口 [x0,y0,x1,y1] 裁切，主体天然占满，无需包围盒
    const [rx0, ry0, rx1, ry1] = src.crop;
    box = {
      x: Math.round(img.width * rx0), y: Math.round(img.height * ry0),
      w: Math.round(img.width * (rx1 - rx0)), h: Math.round(img.height * (ry1 - ry0)),
    };
    // 窗口非正方形时以短边居中取正方形（圆角蒙版按图标外框切，内容需撑满）
    const side = Math.min(box.w, box.h);
    if (box.w > box.h) box = { x: box.x + ((box.w - side) >> 1), y: box.y, w: side, h: side };
    else if (box.h > box.w) box = { x: box.x, y: box.y + ((box.h - side) >> 1), w: side, h: side };
  } else {
    // tile 图：底色估计 + 内容包围盒，裁进底板内部放大主体
    const bg = bgColor(data, img.width, img.height);
    box = contentBBox(data, img.width, img.height, bg) || {
      x: Math.round(img.width * 0.09), y: Math.round(img.height * 0.09),
      w: Math.round(img.width * 0.82), h: Math.round(img.height * 0.82),
    };
    // 内容放大：托盘实际显示只有 16~24px，原图构图中主体仅占约一半，是「显小」的根源；
    // 裁剪后底板颜色仍在画面内（全出血），圆角由 alpha 蒙版重新切出。
    const ZOOM = 0.74;
    const inX = Math.round((box.w * (1 - ZOOM)) / 2);
    const inY = Math.round((box.h * (1 - ZOOM)) / 2);
    box = { x: box.x + inX, y: box.y + inY, w: box.w - 2 * inX, h: box.h - 2 * inY };
  }
  // 裁剪出正方形区域
  const crop = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const so = ((box.y + y) * img.width + box.x) * 4;
    data.copy(crop, y * box.w * 4, so, so + box.w * 4);
  }
  const small = resizeArea(crop, box.w, box.h, size, size);
  const alpha = rrAlpha(size, 0.8, 0.26); // 收边 0.8px 抗 JPEG 白边，圆角比例 26%
  for (let i = 0; i < size * size; i++) small[i * 4 + 3] = Math.min(small[i * 4 + 3], alpha[i]);
  return small;
}

// ---------- 执行 ----------
// sources 按序取第一个存在的文件：优先 SenseNova 生成图（bleed），回退用户原图（tile）。
// crop 为逐张目检确定的比例窗口，避开四角多余元素并保留主体完整。
const MAP = [
  {
    out: 'tray-ok.png', sources: [
      { file: '卡通-绿色状态.jpg', mode: 'bleed', crop: [0.04, 0.03, 0.96, 0.97] },
      { file: path.join('用户原图备份', '卡通-绿色状态.jpg'), mode: 'tile' },
    ],
  },
  {
    out: 'tray-scan.png', sources: [
      { file: '卡通-黄色状态.jpg', mode: 'bleed', crop: [0.02, 0.02, 0.98, 0.98] },
      { file: path.join('用户原图备份', '卡通-黄色状态.jpg'), mode: 'tile' },
    ],
  },
  {
    out: 'tray-error.png', sources: [
      { file: '卡通-红色状态.jpg', mode: 'bleed', crop: [0.05, 0.02, 0.95, 0.98] },
      { file: path.join('用户原图备份', '卡通-红色状态.jpg'), mode: 'tile' },
    ],
  },
  {
    out: 'tray-idle.png', sources: [
      { file: '卡通-灰色状态.jpg', mode: 'bleed', crop: [0.03, 0.02, 0.97, 0.96] },
      { file: path.join('用户原图备份', '卡通-灰色状态.jpg'), mode: 'tile' },
    ],
  },
];
// 每个 MAP 项解析出实际可用的来源（按序取第一个存在的文件）
function pickSource(entry) {
  for (const src of entry.sources) {
    const sp = path.join(ASSETS, src.file);
    if (fs.existsSync(sp)) return { ...src, path: sp };
  }
  return null;
}
const SIZE = 32;
for (const entry of MAP) {
  const src = pickSource(entry);
  if (!src) { console.error(`缺少 ${entry.out} 的全部来源文件`); process.exitCode = 1; continue; }
  const rgba = convert(src.path, SIZE, src);
  const dp = path.join(ASSETS, entry.out);
  fs.writeFileSync(dp, encodePng(SIZE, rgba));
  console.log(`已生成 ${dp}  <-  ${src.file} (${src.mode})`);
}

if (process.argv.includes('--preview')) {
  const prevDir = path.join(os.tmpdir(), 'xsniper-tray-preview');
  fs.mkdirSync(prevDir, { recursive: true });
  for (const entry of MAP) {
    const src = pickSource(entry);
    if (!src) continue;
    const f = path.join(prevDir, entry.out.replace('.png', '@256.png'));
    fs.writeFileSync(f, encodePng(256, convert(src.path, 256, src)));
    console.log(`预览 ${f}`);
  }
}
