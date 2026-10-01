// 采集层：打开闲鱼搜索页并监听搜索接口响应（不解析 DOM）
import { searchUrl, extractListings, safeJson } from '../parse/parser.js';

// 搜索接口特征（来自 reference/monitor-preload.js）
const SEARCH_API_MARKERS = ['mtop.taobao.idlemtopsearch', 'idlemtopsearch', 'pc.search'];

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
      try {
        const priceInputs = page.locator('input[placeholder="¥"]');
        if ((await priceInputs.count()) >= 2) {
          if (minPrice != null) {
            await priceInputs.nth(0).click();
            await priceInputs.nth(0).fill(String(minPrice));
            await page.waitForTimeout(400);
            await page.keyboard.press('Tab');
          }
          if (maxPrice != null) {
            await priceInputs.nth(1).click();
            await priceInputs.nth(1).fill(String(maxPrice));
            await page.waitForTimeout(400);
            await page.keyboard.press('Tab');
          }
          await page.keyboard.press('Enter'); // 确保触发带价格过滤的搜索
        }
      } catch {
        // 价格框操作失败（UI 改版等）：不会发出带 priceRange 的请求，payloads 为空；
        // 记 warning 后返回空列表，由调度器按 scan_log error 记录（本地规则无法兜底无数据）
        console.warn(`[scan] 「${keyword}」价格筛选框操作失败，本轮未采集`);
      }
    }

    await page.waitForTimeout(timeoutMs);

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
