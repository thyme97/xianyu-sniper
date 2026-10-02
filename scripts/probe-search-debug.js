// 一次性诊断：搜索页「扫到 0 条」问题——只听接口不交互，输出响应内商品数与页面状态
// 用法：node scripts/probe-search-debug.js [关键词]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { extractListings } from '../src/parse/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(__dirname, '../state/storage_state.json');
const [keyword = 'mac mini'] = process.argv.slice(2);

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const STEALTH_IGNORE_ARGS = ['--enable-automation'];

// 与 src/capture/browser.js 相同的三级回退：内置 chromium → 系统 Chrome → 系统 Edge
let browser = null;
let lastError = null;
for (const attempt of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try {
    browser = await chromium.launch({
      headless: false,
      ignoreDefaultArgs: STEALTH_IGNORE_ARGS,
      args: [...STEALTH_ARGS, '--window-position=-32000,-32000'],
      ...attempt,
    });
    break;
  } catch (error) { lastError = error; }
}
if (!browser) throw lastError;

try {
  const context = await browser.newContext({
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
  const page = await context.newPage();

  page.on('response', async (res) => {
    const url = res.url();
    if (!/idlemtopsearch\.pc\.search(?!\.)/.test(url)) return;
    try {
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* jsonp */ }
      const list = json ? extractListings(json, keyword) : [];
      // 数一下原始 JSON 里的商品数组（找含 id+price 的最长数组）
      let rawMax = 0;
      const walk = (node) => {
        if (Array.isArray(node)) {
          if (node.length && node[0]?.id && (node[0]?.price ?? node[0]?.soldPrice ?? node[0]?.currentPrice) != null) {
            rawMax = Math.max(rawMax, node.length);
          }
          node.forEach(walk);
        } else if (node && typeof node === 'object') {
          Object.values(node).forEach(walk);
        }
      };
      if (json) walk(json);
      console.log(`[${new Date().toISOString().slice(11, 19)}] 响应 ${raw.length}B | 原始商品数组=${rawMax} | parser解析=${list.length} | ret=${JSON.stringify(json?.ret ?? json?.retValue ?? null)}`);
    } catch (e) {
      console.log('响应处理失败：', String(e).slice(0, 120));
    }
  });

  await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(9000);

  // 页面状态：标题 / 可见大图 / 全屏遮罩 / 正文特征词
  const state = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('image, img')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 500 && r.height > 500 && el.getBoundingClientRect;
      })
      .map((el) => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, cls: (el.getAttribute('class') || el.parentElement?.getAttribute('class') || '').slice(0, 80) }));
    return {
      title: document.title,
      url: location.href,
      bigImgs: imgs,
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
  console.log('页面状态：', JSON.stringify(state, null, 2));

  await page.screenshot({ path: path.resolve(__dirname, '../logs/probe-search-debug.png') });
  console.log('截图已存 logs/probe-search-debug.png');
} finally {
  await browser.close();
}
