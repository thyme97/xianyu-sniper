// Web 服务：Fastify REST API（/api 前缀）+ 静态管理页
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as db from '../store/db.js';
import { loadConfig, saveConfig } from '../config.js';
import { passesRule } from '../filter/rule.js';
import { STORAGE_STATE_PATH, hasLoginState, startInteractiveLogin, getLoginSessionStatus, cancelInteractiveLogin } from '../capture/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 敏感字段脱敏（返回给前端时隐藏 Key，保存时前端原样回传或留空跳过）
const SECRET_KEYS = new Set(['apiKey', 'bark', 'serverchan', 'telegram', 'dingtalk', 'webhook', 'feishu']);
function maskConfig(config) {
  const clone = JSON.parse(JSON.stringify(config));
  for (const key of SECRET_KEYS) {
    if (clone.ai?.[key]) clone.ai[key] = '******';
    if (clone.notify?.[key]) clone.notify[key] = '******';
  }
  return clone;
}

// 合并用户提交的配置：脱敏占位值不覆盖真实值
function mergeSubmittedConfig(current, patch) {
  const clean = JSON.parse(JSON.stringify(patch || {}));
  for (const key of SECRET_KEYS) {
    if (clean.ai?.[key] === '******') delete clean.ai[key];
    if (clean.notify?.[key] === '******') delete clean.notify[key];
  }
  return clean;
}

// watch_item 允许通过 API 修改的字段
const WATCH_API_FIELDS = ['keyword', 'target_price', 'min_price', 'max_price', 'include_words', 'exclude_words', 'area_include', 'area_exclude', 'account', 'ai_enabled', 'interval_sec', 'enabled'];
function pickWatchFields(body) {
  const fields = {};
  for (const key of WATCH_API_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  if (!fields.keyword || !String(fields.keyword).trim()) {
    throw new Error('keyword 不能为空');
  }
  return fields;
}

export function createWebServer({ scheduler, notifier }) {
  const app = fastify({ logger: false });

  // 一次性回填：旧版本扫到的商品没有规则判定结果，启动时按当前任务规则补算，
  // 让「商品浏览」里的历史数据也能看到被过滤/达标的原因
  function backfillItemFilters() {
    try {
      const pending = db.listItems({ status: 'all', limit: 500 }).filter((it) => !it.filter_status);
      const watchCache = new Map();
      for (const it of pending) {
        if (!watchCache.has(it.watch_item_id)) watchCache.set(it.watch_item_id, db.getWatchItem(it.watch_item_id));
        const watchItem = watchCache.get(it.watch_item_id);
        if (!watchItem) continue;
        const result = passesRule({ title: it.title || '', descr: it.descr || '', priceValue: it.price, area: it.area || '' }, watchItem);
        db.setItemFilter(it.id, result.pass ? 'hit' : 'filtered', result.reason);
      }
      if (pending.length) console.log(`[web] 已回填 ${pending.length} 条历史商品的规则判定`);
    } catch (error) {
      console.warn(`[web] 回填规则判定失败（不影响运行）：${error.message}`);
    }
  }
  backfillItemFilters();

  app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    // HTML 不缓存：控制台更新后刷新页面即生效，避免旧版页面导致按钮失效
    setHeaders(res, filePath) {
      if (String(filePath).endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  // ---------- 监控任务 ----------
  app.get('/api/watch-items', async () => db.listWatchItems());

  app.post('/api/watch-items', async (request, reply) => {
    const fields = pickWatchFields(request.body || {});
    const item = db.createWatchItem(fields);
    reply.code(201);
    return item;
  });

  app.put('/api/watch-items/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const existing = db.getWatchItem(id);
    if (!existing) {
      reply.code(404);
      return { error: '任务不存在' };
    }
    const body = request.body || {};
    // 支持部分字段更新：未提供的字段沿用原值
    const fields = { ...existing, ...body };
    return db.updateWatchItem(id, pickWatchFields(fields));
  });

  app.delete('/api/watch-items/:id', async (request) => {
    db.deleteWatchItem(Number(request.params.id));
    return { ok: true };
  });

  // 规则试算：输入标题/价格即时验证规则效果（不涉及真实数据）
  app.post('/api/watch-items/:id/test-rule', async (request, reply) => {
    const watchItem = db.getWatchItem(Number(request.params.id));
    if (!watchItem) {
      reply.code(404);
      return { error: '任务不存在' };
    }
    const { title = '', price = null } = request.body || {};
    return passesRule({ title, descr: '', priceValue: price == null || price === '' ? null : Number(price), area: request.body?.area || '' }, watchItem);
  });

  // ---------- 命中与商品 ----------
  // 手动清空（页面三视图「清空」按钮）：清命中=删已推送商品档案；清商品=删全部档案；price_history 级联删除
  app.delete('/api/hits', async () => ({ ok: true, cleared: db.clearHits() }));
  app.delete('/api/items', async () => ({ ok: true, cleared: db.clearItems() }));
  // 批量删除（页面勾选多选删除）：命中视图行 id 即 item.id，与商品视图共用
  app.post('/api/items/batch-delete', async (request) => ({ ok: true, cleared: db.deleteItemsByIds(request.body?.ids) }));

  app.get('/api/hits', async (request) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const pageSize = Math.min(Math.max(Number(request.query.pageSize) || 20, 1), 200);
    return {
      list: db.listHits({ limit: pageSize, offset: (page - 1) * pageSize }),
      total: db.countHits(),
      page,
      pageSize,
    };
  });

  // 商品浏览：支持按任务/状态/关键词筛选（status = all|hit|pass|filtered），分页返回
  app.get('/api/items', async (request) => {
    const q = request.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 200);
    const filter = {
      watchItemId: q.watchItemId ? Number(q.watchItemId) : null,
      status: q.status || 'all',
      keyword: q.keyword || '',
    };
    return {
      list: db.listItems({ ...filter, limit: pageSize, offset: (page - 1) * pageSize }),
      total: db.countItems(filter),
      page,
      pageSize,
    };
  });

  app.get('/api/watch-items/:id/items', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    return db.listItemsByWatch(Number(request.params.id), { limit });
  });

  app.get('/api/items/:id/price-history', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 200, 1000);
    return db.listPriceHistory(Number(request.params.id), { limit });
  });

  // ---------- 统计 ----------
  app.get('/api/stats', async () => db.getStats());

  // 扫描窗口显示/隐藏（把屏外有头窗口移回屏幕内围观）
  app.get('/api/scan/window', async () => ({ visible: scheduler.scanWindowVisible }));
  app.post('/api/scan/window', async (request) => {
    const visible = !!(request.body?.visible);
    const windows = await scheduler.showScanWindow(visible);
    return { ok: true, visible, windows };
  });

  // ---------- 扫描日志 ----------
  app.delete('/api/scan-logs', async () => ({ ok: true, cleared: db.clearScanLogs() }));
  app.post('/api/scan-logs/batch-delete', async (request) => ({ ok: true, cleared: db.deleteScanLogsByIds(request.body?.ids) }));
  app.get('/api/scan-logs', async (request) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const pageSize = Math.min(Math.max(Number(request.query.pageSize) || 20, 1), 200);
    return {
      list: db.listScanLogs({ limit: pageSize, offset: (page - 1) * pageSize }),
      total: db.countScanLogs(),
      page,
      pageSize,
    };
  });

  // ---------- 配置 ----------
  app.get('/api/config', async () => ({
    config: maskConfig(loadConfig()),
    hasLoginState: hasLoginState(),
  }));

  app.put('/api/config', async (request) => {
    const patch = mergeSubmittedConfig(loadConfig(), request.body);
    return { config: maskConfig(saveConfig(patch)) };
  });

  // ---------- 操作 ----------
  app.post('/api/notify/test', async () => {
    const result = await notifier.send({
      title: '🔔 xianyu-sniper 测试推送',
      body: `这是一条测试通知。\n时间：${new Date().toLocaleString()}`,
      url: 'https://www.goofish.com/',
    });
    return result;
  });

  app.post('/api/scan/once', async () => {
    if (!hasLoginState()) {
      return { ok: false, error: '缺少登录态，请先运行 npm run login' };
    }
    // 异步触发一轮扫描，立即返回
    scheduler.runOnce().catch(() => {});
    return { ok: true };
  });

  // ---------- 登录态导入导出（服务器迁移用）----------
  app.get('/api/login-state/status', async () => ({
    hasLoginState: hasLoginState(),
    session: getLoginSessionStatus(),
    // 曾经登录过但扫描时发现会话失效（用于页面区分「未登录」和「已失效」）
    expired: !!db.getConfigValue('loginStateExpired'),
  }));

  // 页面发起扫码登录：弹出有头浏览器，扫码后自动检测并保存
  app.post('/api/login/start', async (request, reply) => {
    const account = request.body?.account || undefined;
    try {
      await startInteractiveLogin(account);
      return { ok: true };
    } catch (error) {
      reply.code(409);
      return { error: error.message };
    }
  });

  app.post('/api/login/cancel', async () => {
    await cancelInteractiveLogin();
    return { ok: true };
  });

  app.get('/api/login-state/export', async (request, reply) => {
    if (!hasLoginState()) {
      reply.code(404);
      return { error: '本机尚无登录态文件' };
    }
    reply.header('Content-Disposition', 'attachment; filename="storage_state.json"');
    return fs.createReadStream(STORAGE_STATE_PATH);
  });

  app.post('/api/login-state/import', async (request, reply) => {
    const state = request.body;
    if (!state || !Array.isArray(state.cookies)) {
      reply.code(400);
      return { error: '无效的登录态 JSON（缺少 cookies 数组）' };
    }
    fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
    fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return { ok: true };
  });

  return app;
}

export async function startWebServer({ scheduler, notifier }) {
  const config = loadConfig();
  const app = createWebServer({ scheduler, notifier });
  // 端口顺延：首选端口被占用（残留实例/其他程序）时依次 +1 重试，最多尝试 10 个
  const base = config.server.port;
  for (let port = base; port < base + 10; port++) {
    try {
      await app.listen({ host: config.server.host, port });
      if (port !== base) console.warn(`[web] 端口 ${base} 被占用，已顺延使用 ${port}`);
      return { app, port };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || port === base + 9) throw error;
    }
  }
}
