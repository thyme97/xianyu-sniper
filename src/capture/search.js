// 采集层：打开闲鱼搜索页并监听搜索接口响应（不解析 DOM）
import { searchUrl, extractListings, safeJson } from '../parse/parser.js';

// 搜索接口特征（来自 reference/monitor-preload.js）
const SEARCH_API_MARKERS = ['mtop.taobao.idlemtopsearch', 'idlemtopsearch', 'pc.search'];

// 关闭可能遮挡操作的全屏弹窗（如「网页版发闲置功能又升级啦！」促销层，1200px 大图拦截点击）：
// Esc + 常见关闭钮，均为尽力而为，关不掉不报错（后续点击重试机制兜底）
async function closeOverlay(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closeBtn = page
    .locator('[class*="dialog"] [class*="close"], [class*="modal"] [class*="close"], [class*="closeBtn"], [class*="close-btn"], [class*="close-icon"]')
    .first();
  if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
    await closeBtn.click({ timeout: 1000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
}

function isSearchResponse(url) {
  return SEARCH_API_MARKERS.some((marker) => String(url || '').includes(marker));
}

// 单个关键词一次扫描：返回解析出的商品列表
// timeoutMs：页面加载后继续监听接口响应的时长
// minPrice/maxPrice：有值时在页面价格筛选框填入，让服务端直接过滤（30 条配额全部落在区间内）
export async function scanKeyword(context, keyword, { timeoutMs = 10000, minPrice = null, maxPrice = null } = {}) {
  const page = await context.newPage();
  const needPriceFilter = minPrice != null || maxPrice != null;
  try {
    const payloads = [];
    // 期望的完整价格区间参数（postData 为 URL 编码态：: → %3A，, → %2C，; → %3B）
    const priceRangeNeedle = `priceRange%3A${minPrice ?? 'undefined'}%2C${maxPrice ?? 'undefined'}%3B`;
    const onResponse = async (response) => {
      try {
        if (!isSearchResponse(response.url())) return;
        // 开启价格筛选时只收「完整区间」请求的响应：
        // 首屏/排序响应（无过滤）、填价中间态（min 单独触发的 min,undefined）一律丢弃
        if (needPriceFilter && !(response.request().postData() || '').includes(priceRangeNeedle)) return;
        const payload = safeJson(await response.text());
        if (payload) payloads.push(payload);
      } catch {
        // 单个响应失败不影响其余采集
      }
    };
    page.on('response', onResponse);

    await page.goto(searchUrl(keyword), { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 尝试点击「最新」排序（参考 Xianyu-Supply-Monitor），失败不阻断
    try {
      const sortLabels = ['最新', '最新发布', '新上架', '发布时间'];
      for (const label of sortLabels) {
        const target = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
        if (await target.isVisible({ timeout: 500 }).catch(() => false)) {
          await target.click({ timeout: 2000 });
          break;
        }
      }
    } catch {
      // 排序点击失败时按默认排序继续
    }

    // 价格区间筛选：价格不走 URL 参数，是页面写入接口请求体的
    // propValueStr.searchFilter = "priceRange:min,max;"（接口有签名，无法直接改请求，
    // 只能模拟用户在筛选框输入——即真实用户路径）。响应收集由上方 priceRange 判定精确过滤。
    if (needPriceFilter) {
      // 点击可能被全屏弹窗遮挡（促销层/风控挑战图），失败先关弹窗再重试一次；
      // 点击用短超时，避免每轮卡 30s
      let filled = false;
      for (let attempt = 0; attempt < 2 && !filled; attempt++) {
        try {
          const priceInputs = page.locator('input[placeholder="¥"]');
          if ((await priceInputs.count()) < 2) break;
          if (minPrice != null) {
            await priceInputs.nth(0).click({ timeout: 4000 });
            await priceInputs.nth(0).fill(String(minPrice));
            await page.waitForTimeout(400);
            await page.keyboard.press('Tab');
          }
          if (maxPrice != null) {
            await priceInputs.nth(1).click({ timeout: 4000 });
            await priceInputs.nth(1).fill(String(maxPrice));
            await page.waitForTimeout(400);
            await page.keyboard.press('Tab');
          }
          await page.keyboard.press('Enter'); // 确保触发带价格过滤的搜索
          filled = true;
        } catch {
          if (attempt === 0) await closeOverlay(page);
        }
      }
      if (!filled) {
        // 价格框操作失败（弹窗遮挡/UI 改版等）：不会发出带 priceRange 的请求，payloads 必为空
        console.warn(`[scan] 「${keyword}」价格筛选框操作失败，本轮未采集`);
      }
    }

    await page.waitForTimeout(timeoutMs);

    // 价格筛选开启却没收到任何带 priceRange 的响应 = 筛选请求没发出去（弹窗遮挡/UI 改版），
    // 显式报错让 scan_log 记录真实原因，而不是静默记成「扫到 0 条」
    if (needPriceFilter && payloads.length === 0) {
      const err = new Error('价格筛选请求未发出（页面弹窗遮挡或 UI 改版），本轮未采集。可稍后重试或反馈排查');
      err.code = 'PRICE_FILTER_FAILED';
      throw err;
    }

    // 风控拦截检测：WAF 返回「非法访问」页时明确报错，而不是静默 0 结果
    const bodyText = await page.textContent('body').catch(() => '');
    if (bodyText && bodyText.includes('非法访问')) {
      const err = new Error('触发闲鱼风控拦截页（非法访问），本轮未采集。请重新扫码登录或稍后再试');
      err.code = 'WAF_BLOCKED';
      throw err;
    }

    // 登录态失效检测：被重定向到登录页
    if (/login|login\.taobao/.test(page.url())) {
      const err = new Error('登录态已失效，请重新运行 npm run login');
      err.code = 'LOGIN_EXPIRED';
      throw err;
    }

    // 合并多个接口响应的解析结果并按商品 id 去重
    const seen = new Set();
    const listings = [];
    for (const payload of payloads) {
      for (const listing of extractListings(payload, keyword)) {
        if (seen.has(listing.id)) continue;
        seen.add(listing.id);
        listings.push(listing);
      }
    }
    return listings;
  } finally {
    await page.close().catch(() => {});
  }
}
