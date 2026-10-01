// 一次性探测：闲鱼 PC 搜索页的价格区间筛选，确认 URL 参数与搜索接口请求字段
// 用法：node scripts/probe-price-filter.js [关键词] [最低价] [最高价]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { extractListings } from '../src/parse/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(__dirname, '../state/storage_state.json');
const [keyword = 'mac mini', minPrice = '5000', maxPrice = '7000'] = process.argv.slice(2);

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const STEALTH_IGNORE_ARGS = ['--enable-automation'];

async function launch() {
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        headless: false,
        ignoreDefaultArgs: STEALTH_IGNORE_ARGS,
        args: [...STEALTH_ARGS, '--window-position=-32000,-32000'],
        ...attempt,
      });
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

const browser = await launch();
try {
  const context = await browser.newContext({
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
  const page = await context.newPage();

  // 捕获搜索接口响应：解析列表价格，验证服务端是否真的按价格过滤
  const captured = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!/idlemtopsearch\.pc\.search(?!\.)/.test(url)) return; // 只要主搜索接口
    try {
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* 可能 jsonp */ }
      if (captured.length === 0) {
        console.log('首个响应原文前 600 字符：', raw.slice(0, 600));
      }
      // 商品列表位置不固定，递归找第一个形如商品数组的节点
      const findList = (node) => {
        if (Array.isArray(node) && node.length && node[0]?.id && (node[0]?.price ?? node[0]?.soldPrice ?? node[0]?.currentPrice) != null) return node;
        if (node && typeof node === 'object') {
          for (const v of Object.values(node)) { const r = findList(v); if (r) return r; }
        }
        return null;
      };
      // 用项目自带的 parser 解析（与采集管线同口径）
      const list = json ? extractListings(json, keyword) : [];
      const prices = list.map((x) => Number(x.priceValue ?? x.price)).filter((n) => !Number.isNaN(n));
      captured.push({
        at: new Date().toISOString().slice(11, 19),
        count: list.length,
        priceMin: prices.length ? Math.min(...prices) : null,
        priceMax: prices.length ? Math.max(...prices) : null,
        prices: prices.slice(0, 8),
      });
    } catch (e) {
      captured.push({ error: String(e).slice(0, 120) });
    }
  });

  await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 找价格输入框：placeholder 通常含「最低价/最高价」，或输入框组合带「-」分隔
  const dump = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')];
    return inputs.map((el) => ({
      placeholder: el.placeholder || '',
      type: el.type,
      cls: (el.className || '').slice(0, 60),
    })).filter((x) => x.placeholder || x.type === 'number');
  });
  console.log('页面输入框：', JSON.stringify(dump, null, 2));

  // 价格输入框 placeholder 均为「¥」，按顺序：第 1 个最低价、第 2 个最高价
  const priceInputs = page.locator('input[placeholder="¥"]');
  const count = await priceInputs.count();
  console.log('价格输入框数量：', count);
  let filled = false;
  if (count >= 2) {
    await priceInputs.nth(0).click();
    await priceInputs.nth(0).fill(String(minPrice));
    await page.waitForTimeout(500);
    await page.keyboard.press('Tab').catch(() => {});
    await priceInputs.nth(1).click();
    await priceInputs.nth(1).fill(String(maxPrice));
    await page.waitForTimeout(500);
    await page.keyboard.press('Tab').catch(() => {});
    filled = true;
  }

  if (filled) {
    // 回车或点「确定」触发筛选
    await page.keyboard.press('Enter').catch(() => {});
    // 有的实现需要点确定按钮
    for (const label of ['确定', '确认']) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) { await btn.click({ timeout: 2000 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(6000);
  }

  console.log('筛选后 URL：', page.url());
  console.log('各次搜索响应的价格分布（验证服务端过滤）：');
  captured.forEach((c, i) => console.log(`  [${i}]`, JSON.stringify(c)));
} finally {
  await browser.close();
}
