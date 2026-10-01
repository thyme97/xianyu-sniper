// 调度器：按任务轮询（≥60s + ±30% 抖动）、多任务错峰、串行扫描、scan_log 记录
import { openScanContext, invalidateLoginState, setScanWindowVisible } from './capture/browser.js';
import { scanKeyword } from './capture/search.js';
import { passesRule } from './filter/rule.js';
import { aiEnabledFor, aiCheck } from './filter/ai.js';
import * as db from './store/db.js';

const MIN_INTERVAL_SEC = 60; // 防封基线：轮询间隔 ≥60 秒
const JITTER_RATIO = 0.3;    // 随机抖动 ±30%
const STAGGER_MS = 15000;    // 多任务初始错峰间隔

function jitteredMs(intervalSec) {
  const base = Math.max(MIN_INTERVAL_SEC, Number(intervalSec) || MIN_INTERVAL_SEC);
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.round((base + jitter) * 1000);
}

function createLogger(log) {
  return {
    info: (...args) => (log?.info || console.log)(...args),
    warn: (...args) => (log?.warn || console.warn)(...args),
    error: (...args) => (log?.error || console.error)(...args),
  };
}

export function createScheduler({ config, notifier, log } = {}) {
  const logger = createLogger(log);
  let running = false;
  let activeScans = 0; // 正在执行的扫描数（Electron 托盘「扫描中」状态用）
  const opened = new Map(); // account -> { browser, context }，默认账号 key 为 ''
  const timers = new Map();
  let queue = Promise.resolve(); // 串行化：禁止并发轰炸同一接口

  function enqueue(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  // 按任务账号取上下文；config.accounts 中可配置命名账号的 proxy（代理预留）
  async function getContext(watchItem) {
    const key = watchItem.account || '';
    if (!opened.has(key)) {
      const accountConfig = (config.accounts || []).find((entry) => entry.name === key);
      const instance = await openScanContext({
        account: key || undefined,
        proxy: accountConfig?.proxy,
        headless: config.scan?.headless, // undefined = 自动（桌面屏外有头 / 服务器无头）
      });
      opened.set(key, instance);
    }
    return opened.get(key).context;
  }

  function buildPayload(watchItem, listing, aiReason, titlePrefix = '🎯 闲鱼蹲价命中') {
    const lines = [
      listing.title,
      listing.price ? `价格：${listing.price}` : '',
      watchItem.target_price != null ? `目标价：${watchItem.target_price}` : '',
      listing.area ? `地区：${listing.area}` : '',
      aiReason ? `AI：${aiReason}` : '',
      listing.url,
    ].filter(Boolean);
    return {
      title: `${titlePrefix}：${watchItem.keyword}`,
      body: lines.join('\n'),
      url: listing.url,
    };
  }

  // 轮末统一推送（防骚扰）：单条走原格式；多条聚合成一条，避免一轮命中刷屏
  // entries: [{ itemId, listing, aiReason, titlePrefix }]
  async function flushNotifies(watchItem, entries) {
    if (!entries.length) return 0;
    let payload;
    if (entries.length === 1) {
      const e = entries[0];
      payload = buildPayload(watchItem, e.listing, e.aiReason, e.titlePrefix);
    } else {
      payload = {
        title: `🎯 闲鱼蹲价命中：${watchItem.keyword}（${entries.length} 条）`,
        body: entries.map((e, i) => [
          `${i + 1}. ${e.listing.title}`,
          e.listing.price ? `   价格：${e.listing.price}` : '',
          e.listing.area ? `   地区：${e.listing.area}` : '',
          `   ${e.listing.url}`,
        ].filter(Boolean).join('\n')).join('\n\n'),
        url: '',
      };
    }
    const result = await notifier.send(payload);
    if (result.errors.length) {
      logger.warn(`[notify] 任务「${watchItem.keyword}」部分渠道推送失败：${result.errors.join('；')}`);
    }
    for (const e of entries) db.markNotified(e.itemId);
    return entries.length;
  }

  // 单任务一次扫描（含入库、筛选、AI、通知）；失败写 scan_log，不中断调度
  async function scanOnce(watchItem) {
    let newItemCount = 0;
    let notifiedCount = 0;
    activeScans++;
    try {
      const ctx = await getContext(watchItem);
      // 价格区间传给搜索页筛选：服务端先过滤，30 条配额全部落在区间内；规则层本地过滤保留作双保险
      const listings = await scanKeyword(ctx, watchItem.keyword, {
        minPrice: watchItem.min_price ?? null,
        maxPrice: watchItem.max_price ?? null,
      });
      const isFirstScan = db.countItemsByWatch(watchItem.id) === 0;
      const allowNotify = !(isFirstScan && !config.scan?.firstScanNotify);

      // 本轮明细：写入 scan_log.detail，页面可展开查看每条为什么被过滤/命中
      const detail = { seen: listings.length, dup: 0, new: 0, hits: [], priceDrops: 0, filtered: [] };
      // 待推送收集：循环内不直接推，轮末聚合发送（防骚扰）
      const pendingNotify = [];
      const pushFiltered = (listing, reason) => {
        if (detail.filtered.length >= 50) return; // 明细截断，防止日志膨胀
        detail.filtered.push({ title: String(listing.title || '').slice(0, 40), price: listing.priceValue ?? null, reason });
      };
      const pushHit = (listing) => {
        detail.hits.push({ title: String(listing.title || '').slice(0, 40), price: listing.priceValue ?? null });
      };

      for (const listing of listings) {
        const existing = db.getItemByXianyuId(watchItem.id, listing.id);
        if (existing) {
          detail.dup++;
          // 已见过：跟踪价格变化
          if (listing.priceValue != null && listing.priceValue !== existing.price) {
            db.updateItemPrice(existing.id, listing.priceValue);
            db.recordPriceSnapshot(existing.id, watchItem.id, listing.priceValue);
            // 降价重估：还没推送过的老商品，价格变化后重新过规则（等卖家降价的场景）
            // 推送过的商品价格再变也不重复推（防骚扰核心：一次达标只推一次）
            if (!existing.notified_at) {
              const reResult = passesRule(listing, watchItem);
              db.setItemFilter(existing.id, reResult.pass ? 'hit' : 'filtered', reResult.reason);
              if (reResult.pass && allowNotify) {
                pendingNotify.push({ itemId: existing.id, listing, aiReason: '', titlePrefix: '📉 降价达标' });
                detail.priceDrops++;
                pushHit(listing);
                logger.info(`[hit] 「${watchItem.keyword}」降价达标：${listing.title} @ ${listing.price || '?'}`);
              }
            }
          }
          continue;
        }

        const itemId = db.insertItem(watchItem.id, listing, { rawJson: JSON.stringify(listing) });
        newItemCount++;
        detail.new++;

        const ruleResult = passesRule(listing, watchItem);
        db.setItemFilter(itemId, ruleResult.pass ? 'hit' : 'filtered', ruleResult.reason);
        if (!ruleResult.pass) {
          pushFiltered(listing, ruleResult.reason);
          continue;
        }

        // AI 复筛（可开关）；调用失败降级：严格模式丢弃，否则放行并告警
        let pass = true;
        let aiReason = '';
        if (aiEnabledFor(watchItem, config.ai)) {
          try {
            const verdict = await aiCheck(listing, config.ai);
            db.setAiVerdict(itemId, verdict.match ? 1 : 0, verdict.reason);
            pass = verdict.match;
            aiReason = verdict.reason;
          } catch (error) {
            if (config.ai?.strict) {
              pass = false;
              aiReason = `AI 调用失败：${error.message}`;
            } else {
              logger.warn(`[ai] 任务「${watchItem.keyword}」AI 调用失败，降级放行：${error.message}`);
            }
          }
        }
        if (!pass) {
          db.setItemFilter(itemId, 'filtered', aiReason || 'AI 判定不匹配');
          pushFiltered(listing, aiReason || 'AI 判定不匹配');
          continue;
        }
        if (!allowNotify) {
          pushFiltered(listing, '首扫基线：仅记录不推送');
          continue; // 首扫基线：只记录不推送
        }

        pendingNotify.push({ itemId, listing, aiReason, titlePrefix: '🎯 闲鱼蹲价命中' });
        pushHit(listing);
        logger.info(`[hit] 「${watchItem.keyword}」命中：${listing.title} @ ${listing.price || '?'}`);
      }

      // 轮末统一推送（单条/聚合）
      notifiedCount = await flushNotifies(watchItem, pendingNotify);

      db.insertScanLog({
        watchItemId: watchItem.id,
        status: 'ok',
        newCount: newItemCount,
        detail,
        error: notifiedCount ? `推送 ${notifiedCount} 条` : null,
      });
      logger.info(`[scan] 「${watchItem.keyword}」${listings.length} 条，新增 ${newItemCount}，推送 ${notifiedCount}`);
    } catch (error) {
      if (error.code === 'LOGIN_EXPIRED') {
        invalidateLoginState(watchItem.account || undefined);
        await closeBrowser();
        // 登录失效告警只推一次：重新扫码登录成功后重置（防止每轮扫描重复轰炸）
        if (!db.getConfigValue('loginExpiredNotified')) {
          db.setConfigValue('loginExpiredNotified', true);
          notifier
            .send({
              title: '⚠️ 闲鱼登录态已失效',
              body: '请打开 Web 控制台点击「扫码登录」重新登录，否则无法继续扫描。',
              url: '',
            })
            .catch(() => {});
        }
      }
      db.insertScanLog({
        watchItemId: watchItem.id,
        status: 'error',
        newCount: newItemCount,
        error: error.message,
      });
      logger.error(`[scan] 「${watchItem.keyword}」失败：${error.message}`);
    } finally {
      activeScans--;
    }
    return { newItemCount, notifiedCount };
  }

  async function loop(watchItem) {
    if (!running) return;
    await enqueue(() => scanOnce(watchItem));
    if (!running) return;
    const latest = db.getWatchItem(watchItem.id); // 重新读取：任务可能已被修改/停用/删除
    if (!latest || !latest.enabled) return;
    timers.set(latest.id, setTimeout(() => loop(latest), jitteredMs(latest.interval_sec)));
  }

  // 「显示/隐藏扫描窗口」：把屏外有头窗口移回屏幕内围观，或再次藏到屏外
  let scanWindowVisible = false;
  async function showScanWindow(visible) {
    const instances = [...opened.values()];
    if (!instances.length) throw new Error('当前没有运行中的扫描浏览器（首次扫描后才会创建）');
    for (const instance of instances) {
      await setScanWindowVisible(instance, visible);
    }
    scanWindowVisible = visible;
    return instances.length;
  }

  // 过期数据清理：启动时跑一次，之后每 24 小时一次
  function cleanupOld() {
    try {
      const result = db.cleanupExpired(config.scan?.retentionDays);
      if (result.scanLogs || result.priceHistory || result.rawJson) {
        logger.info(`[cleanup] 已清理：扫描日志 ${result.scanLogs} 条、价格历史 ${result.priceHistory} 条、原始JSON ${result.rawJson} 条`);
      }
    } catch (error) {
      logger.warn(`[cleanup] 清理失败（不影响运行）：${error.message}`);
    }
  }

  function start() {
    if (running) return;
    running = true;
    cleanupOld();
    setInterval(cleanupOld, 24 * 60 * 60 * 1000);
    const items = db.listWatchItems({ enabledOnly: true });
    items.forEach((item, index) => {
      // 初始错峰启动，避免多任务同一瞬间开扫
      const delay = index * STAGGER_MS + Math.round(Math.random() * 5000);
      timers.set(item.id, setTimeout(() => loop(item), delay));
    });
    logger.info(`[scheduler] 已启动 ${items.length} 个监控任务`);
  }

  async function closeBrowser() {
    // 关闭所有账号的扫描上下文（登录失效/停止调度时调用）
    for (const instance of opened.values()) {
      if (instance?.context) await instance.context.close().catch(() => {});
      if (instance?.browser) await instance.browser.close().catch(() => {});
    }
    opened.clear();
  }

  async function stop() {
    running = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await closeBrowser();
    logger.info('[scheduler] 已停止');
  }

  // 立即全量扫一轮（供 CLI --once 与 Web「手动扫描」按钮）
  async function runOnce() {
    const items = db.listWatchItems({ enabledOnly: true });
    for (const item of items) {
      await enqueue(() => scanOnce(item));
    }
  }

  return {
    start,
    stop,
    runOnce,
    showScanWindow,
    get running() {
      return running;
    },
    get busy() {
      return activeScans > 0;
    },
    get scanWindowVisible() {
      return scanWindowVisible;
    },
  };
}
