// 一次性探针：实测「登录态快照」在闲鱼服务端的真实有效性
// 同一轮跑两个对照组：① 当前 storage_state.json 快照 ② 无 cookie 匿名
// 每组采集：首页/消息页最终 URL、标题、关键文本、unb cookie 存在性、mtop 用户类接口响应
// 用法：node scripts/probe-login-verify.js
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// 直接指向打包版实际使用的快照（不 import browser.js：其顶层引 db，node 直跑下 electron ABI 的 better-sqlite3 会崩）
const STORAGE_STATE_PATH = path.join(process.env.APPDATA, 'xianyu-sniper', 'state', 'storage_state.json');

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const STEALTH_IGNORE_ARGS = ['--enable-automation'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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

// 抓取「疑似用户/会话类」mtop 接口响应的 ret 与摘要
function attachApiSpy(page, bucket) {
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/mtop\.[\w.]*(user|session|login|member|person|head)[\w.]*/i.test(url)) return;
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { /* jsonp 等 */ }
      bucket.push({
        api: (url.match(/mtop\.[\w.]+/) || [''])[0],
        ret: body?.ret ?? null,
        dataKeys: body?.data ? Object.keys(body.data).slice(0, 10) : null,
        snippet: body ? JSON.stringify(body).slice(0, 220) : raw.slice(0, 220),
      });
    } catch { /* 单个响应失败忽略 */ }
  });
}

async function inspect(browser, label, stateFile) {
  const context = await browser.newContext({
    ...(stateFile ? { storageState: stateFile } : {}),
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
  const page = await context.newPage();
  const apis = [];
  attachApiSpy(page, apis);
  const result = { label, apis };

  // 首页
  await page.goto('https://www.goofish.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => { result.homeError = e.message; });
  await page.waitForTimeout(5000);
  result.homeUrl = page.url();
  result.homeTitle = await page.title().catch(() => '');
  result.homeText = (await page.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
  const unb = await context.cookies('https://www.goofish.com').then((cs) => cs.find((c) => c.name === 'unb'));
  result.unbCookie = unb ? `存在(值尾=${unb.value.slice(-4)},expires=${Math.round(unb.expires)})` : '不存在';

  // 消息页（预期需登录）
  await page.goto('https://www.goofish.com/im', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => { result.imError = e.message; });
  await page.waitForTimeout(4000);
  result.imUrl = page.url();
  result.imTitle = await page.title().catch(() => '');
  result.imText = (await page.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);

  await context.close();
  return result;
}

const browser = await launch();
try {
  const hasState = fs.existsSync(STORAGE_STATE_PATH);
  console.log('快照文件存在：', hasState);
  const results = [];
  results.push(await inspect(browser, '当前快照', hasState ? STORAGE_STATE_PATH : null));
  results.push(await inspect(browser, '匿名对照', null));
  for (const r of results) {
    console.log('\n==========', r.label, '==========');
    console.log('首页 URL：', r.homeUrl);
    console.log('首页标题：', r.homeTitle);
    console.log('unb cookie：', r.unbCookie);
    console.log('首页正文特征：', r.homeText);
    console.log('消息页 URL：', r.imUrl);
    console.log('消息页标题：', r.imTitle);
    console.log('消息页正文特征：', r.imText);
    console.log('用户类接口响应：', JSON.stringify(r.apis, null, 2));
  }
  console.log('\n（截图省略；探针结束）');
} finally {
  await browser.close();
}
