// 采集层：Playwright 浏览器上下文管理（headed 登录 / headless 扫描 + storageState 复用）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import { runtimeRoot } from '../paths.js';
import * as db from '../store/db.js';

const STATE_DIR = path.join(runtimeRoot(), 'state');
export const STORAGE_STATE_PATH = path.join(STATE_DIR, 'storage_state.json');

const HOME_URL = 'https://www.goofish.com/';

// 反自动化检测：闲鱼 WAF 会拦截带自动化特征的浏览器（显示「非法访问」/异常页）
const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
const STEALTH_IGNORE_ARGS = ['--enable-automation'];
const STEALTH_INIT_SCRIPT = "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });";

// 登录用持久化用户目录：像「老用户回访」而非全新指纹，降低 WAF 拦截率
const LOGIN_PROFILE_DIR = path.join(STATE_DIR, 'chrome-profile');

// 启动浏览器：优先内置 Chromium；未下载时回退系统 Chrome / Edge（Windows 自带 Edge，免下载）
async function launchBrowser(options = {}) {
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        ignoreDefaultArgs: STEALTH_IGNORE_ARGS,
        args: STEALTH_ARGS,
        ...options,
        ...attempt,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `无法启动浏览器（已尝试内置 Chromium / 系统 Chrome / 系统 Edge）。可运行 npx playwright install chromium 安装内置浏览器。原因：${lastError?.message}`
  );
}

// 打开「登录/人工用」持久化上下文：有头 + 反检测 + 用户目录持久化
async function launchLoginContext() {
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastError;
  for (const attempt of attempts) {
    try {
      const context = await chromium.launchPersistentContext(LOGIN_PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 860 },
        locale: 'zh-CN',
        ignoreDefaultArgs: STEALTH_IGNORE_ARGS,
        args: STEALTH_ARGS,
        ...attempt,
      });
      await context.addInitScript(STEALTH_INIT_SCRIPT);
      return context;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法打开登录浏览器窗口。原因：${lastError?.message}`);
}

// 多账号预留：默认账号用 storage_state.json，命名账号用 storage_state_<account>.json
export function storageStatePathFor(account) {
  return account
    ? path.join(STATE_DIR, `storage_state_${account}.json`)
    : STORAGE_STATE_PATH;
}

export function hasLoginState(account) {
  return fs.existsSync(storageStatePathFor(account));
}

// 有头登录：打开闲鱼首页，用户扫码后在终端按回车保存登录态；--account 保存为命名账号
export async function runLogin(account) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const context = await launchLoginContext();
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(HOME_URL);

  console.log(account ? `请为账号「${account}」完成闲鱼登录（扫码）。` : '请在打开的浏览器窗口中完成闲鱼登录（扫码）。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('登录完成后回到这里，按回车保存登录态并退出...');
  rl.close();

  const statePath = storageStatePathFor(account);
  await context.storageState({ path: statePath });
  await context.close();
  console.log(`登录态已保存到 ${statePath}`);
}

// headless 扫描上下文：复用登录态；account 可选（多账号预留），proxy 可选（代理预留，Playwright 标准格式）
// headless 未指定时自动判断：桌面系统（win/mac）用「屏外有头」窗口（无头易被闲鱼 WAF 拦截），Linux 服务器/Docker 用真无头
export async function openScanContext({ account, proxy, headless } = {}) {
  const statePath = storageStatePathFor(account);
  if (!fs.existsSync(statePath)) {
    throw new Error(
      account
        ? `缺少账号「${account}」的登录态，请先运行 npm run login -- --account ${account}`
        : '缺少登录态，请先运行 npm run login 完成登录'
    );
  }
  const effectiveHeadless = headless ?? (process.platform === 'linux');
  const launchArgs = effectiveHeadless ? STEALTH_ARGS : [...STEALTH_ARGS, '--window-position=-32000,-32000'];
  const browser = await launchBrowser({ headless: effectiveHeadless, args: launchArgs });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    proxy,
  });
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  // 常驻「宿主页」：扫描页每轮开完即关，若无常驻页，扫描间隙窗口会整个消失
  // （任务栏无图标、CDP 无法控制窗口）。about:blank 不触发任何业务请求，无风控影响。
  const page = await context.newPage();
  await page.goto('about:blank').catch(() => {});
  return { browser, context, page };
}

// 屏外有头窗口的隐藏坐标（任务栏可见但窗口本体在屏幕外，避免打扰）
export const OFFSCREEN_POS = -32000;

// 通过 CDP 把扫描浏览器窗口移到屏幕内/外（等价于 Xianyu-Supply-Monitor 的 keepMonitorVisible：
// Electron 自带可见窗口，我们用 Playwright 则在需要「围观监控过程」时把屏外窗口叫回来）
export async function setScanWindowVisible(instance, visible) {
  // 宿主页可能被手动关闭：确保存在，否则页面级 CDP 找不到窗口
  let page = instance.page;
  if (!page || page.isClosed()) {
    page = await instance.context.newPage();
    await page.goto('about:blank').catch(() => {});
    instance.page = page;
  }
  // 用页面级 CDP session：browser 级默认 target 无窗口，getWindowForTarget 会失败
  const session = await instance.context.newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    // 先确保窗口为 normal 态（minimized 下坐标设置不生效），再移动位置
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: visible
        ? { left: 80, top: 80, width: 1280, height: 860, windowState: 'normal' }
        : { left: OFFSCREEN_POS, top: OFFSCREEN_POS, windowState: 'normal' },
    });
  } catch (error) {
    throw new Error(`无法控制扫描窗口（可能当前是无头模式或没有运行中的浏览器）：${error.message}`);
  } finally {
    await session.detach().catch(() => {});
  }
}

// 登录态失效时删除本地文件，提示重新登录
export function invalidateLoginState(account) {
  try {
    const statePath = storageStatePathFor(account);
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    // 标记失效：页面显示「登录已失效」而非「未登录」，同时登录失效告警由此只推一次
    db.setConfigValue('loginStateExpired', true);
  } catch {
    // 删除失败不阻断流程
  }
}

// ---------- Web 发起的扫码登录（无需终端，页面点按钮即可）----------

let loginSession = null; // { status: running|saved|timeout|cancelled|error, account, context, error }

export function loginInProgress() {
  return Boolean(loginSession && loginSession.status === 'running');
}

// 登录成功的标志 cookie（淘宝会话：unb=用户id，lgc/dnk/tracknick=昵称类）
const LOGIN_COOKIE_NAMES = ['unb', 'lgc', 'dnk', 'tracknick'];

// 监听页面用户接口的 ret，把服务端会话判定记入 state（{ ok, expired }）
// 探针实证：失效/匿名会话该接口返回 FAIL_SYS_SESSION_EXPIRED——仅 cookie 名存在不可靠，
// 失效旧 cookie 会瞬间误判「已登录」导致登录窗口刚打开就自动关闭
function watchSessionVerdict(page, state) {
  page.on('response', (response) => {
    try {
      // 登录页打开的 HOME_URL 会自发调用这两个用户态接口，ret 直接反映服务端会话判定
      if (!/loginuser\.get|user\.page\.nav/.test(response.url())) return;
      response.json().then((body) => {
        if (!Array.isArray(body?.ret)) return;
        const ret = body.ret.join(';');
        if (ret.includes('SESSION_EXPIRED')) state.expired = true;
        else if (/success/i.test(ret)) state.ok = true;
      }).catch(() => {});
    } catch {
      // 单个响应失败忽略
    }
  });
}

// 发起有头扫码登录：立即返回，后台轮询登录 cookie，成功自动保存并关窗
export async function startInteractiveLogin(account) {
  if (loginInProgress()) throw new Error('已有登录窗口进行中，请先完成或取消');
  const session = { status: 'running', account: account || null, context: null, error: null };
  loginSession = session;

  // 异步执行，不阻塞 API 响应
  (async () => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const context = await launchLoginContext();
      session.context = context;
      const page = context.pages()[0] || (await context.newPage());
      const sessionVerdict = { ok: false, expired: false };
      watchSessionVerdict(page, sessionVerdict);
      await page.goto(HOME_URL);

      // 最多等 5 分钟扫码；双信号确认 = 登录 cookie 存在 + 服务端接口认可
      //（失效旧 cookie 也满足前者，双信号防止窗口刚打开就误判关窗）
      const deadline = Date.now() + 5 * 60 * 1000;
      let loggedIn = false;
      let reloaded = false;
      while (Date.now() < deadline && session.status === 'running') {
        await page.waitForTimeout(2000);
        if (page.isClosed()) break;
        const cookies = await context.cookies('https://www.goofish.com').catch(() => []);
        const hasLoginCookie = cookies.some((cookie) => LOGIN_COOKIE_NAMES.includes(cookie.name) && cookie.value);
        // 扫码成功但页面未自发重调验证接口时，reload 一次触发（限一次，防止明明登录了却等到超时）
        if (hasLoginCookie && !sessionVerdict.ok && !reloaded) {
          reloaded = true;
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        if (hasLoginCookie && sessionVerdict.ok) {
          loggedIn = true;
          break;
        }
      }

      if (session.status === 'running') {
        if (loggedIn) {
          await context.storageState({ path: storageStatePathFor(session.account) });
          session.status = 'saved';
          // 重新登录成功：清除失效标记（页面恢复「已登录」，登录失效告警可再次触发）
          db.setConfigValue('loginStateExpired', false);
          db.setConfigValue('loginExpiredNotified', false);
          // 记录保存时间：调度器据此识别「快照比扫描上下文新」并重建实例（见 scheduler.getContext），
          // 否则已开的扫描浏览器一直带着失效旧 cookie，重新登录后窗口仍提示登录
          db.setConfigValue('loginSavedAt', Date.now());
        } else {
          session.status = 'timeout';
        }
      }
      await context.close().catch(() => {});
    } catch (error) {
      session.status = 'error';
      session.error = error.message;
      session.context?.close().catch(() => {});
    }
  })();

  return session;
}

export function getLoginSessionStatus() {
  if (!loginSession) return null;
  return { status: loginSession.status, account: loginSession.account, error: loginSession.error };
}

export async function cancelInteractiveLogin() {
  if (loginSession?.status === 'running') {
    loginSession.status = 'cancelled';
    await loginSession.context?.close().catch(() => {});
  }
}

// ---------- 登录态真实校验（服务端视角）----------
// 本地快照存在 ≠ 服务端认可（Session 可能已被淘宝侧过期）。实测信号
// （scripts/probe-login-verify.js）：快照失效/匿名时，页面自发调用的用户接口
// 返回 ret=["FAIL_SYS_SESSION_EXPIRED::Session过期"]；而 URL 不重定向、unb
// cookie 仍在、页面文本无差异——接口 ret 是唯一可靠判定信号。
// 返回 { status: ok|expired|unknown|none, reason? }；unknown 不改动现有状态
export async function verifyLoginState() {
  if (!hasLoginState()) return { status: 'none' };
  let browser = null;
  try {
    const instance = await openScanContext({});
    browser = instance.browser;
    const page = instance.page;
    const rets = [];
    const onResponse = async (response) => {
      try {
        // 页面加载时会自发调用的两个用户态接口（探针实测），ret 直接反映服务端会话判定
        if (!/loginuser\.get|user\.page\.nav/.test(response.url())) return;
        const body = await response.json().catch(() => null);
        if (Array.isArray(body?.ret)) rets.push(body.ret.join(';'));
      } catch {
        // 单个响应失败不影响其余判定
      }
    };
    page.on('response', onResponse);
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000); // 等页面自发调用户接口

    if ((await page.textContent('body').catch(() => '')).includes('非法访问')) {
      return { status: 'unknown', reason: '触发风控拦截页，暂不定论' };
    }
    if (!rets.length) return { status: 'unknown', reason: '未捕获到用户接口响应' };
    if (rets.some((ret) => ret.includes('SESSION_EXPIRED'))) return { status: 'expired' };
    // ok 也要求接口明确成功，其他错误（如 token 层异常）不定论，交由下轮再验
    if (rets.some((ret) => /success/i.test(ret))) return { status: 'ok' };
    return { status: 'unknown', reason: `用户接口无成功响应（${rets[0].slice(0, 60)}）` };
  } catch (error) {
    return { status: 'unknown', reason: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
