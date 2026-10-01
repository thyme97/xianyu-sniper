// 存储层：better-sqlite3 初始化、建表与查询封装（表结构见 docs/02 数据模型）
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeRoot } from '../paths.js';

const DATA_DIR = path.join(runtimeRoot(), 'data');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watch_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword       TEXT NOT NULL,
  target_price  REAL,
  min_price     REAL,
  max_price     REAL,
  include_words TEXT,
  exclude_words TEXT,
  area_include  TEXT,
  area_exclude  TEXT,
  account       TEXT,              -- 多账号预留：对应 state/storage_state_<account>.json
  ai_enabled    INTEGER NOT NULL DEFAULT 0,
  interval_sec  INTEGER NOT NULL DEFAULT 120,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS item (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_item_id  INTEGER NOT NULL REFERENCES watch_item(id) ON DELETE CASCADE,
  xianyu_id      TEXT NOT NULL,
  title          TEXT,
  descr          TEXT,
  price          REAL,
  area           TEXT,
  seller         TEXT,
  url            TEXT,
  image_url      TEXT,
  raw_json       TEXT,
  filter_status  TEXT,             -- 规则判定：hit=达标 / filtered=被过滤
  filter_reason  TEXT,             -- 判定原因（透明化：页面可查每条为什么没命中）
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ai_verdict     INTEGER,
  ai_reason      TEXT,
  notified_at    TEXT,
  UNIQUE(watch_item_id, xianyu_id)
);

CREATE TABLE IF NOT EXISTS scan_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_item_id  INTEGER,
  started_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status         TEXT NOT NULL,
  new_count      INTEGER NOT NULL DEFAULT 0,
  detail         TEXT,             -- 本轮明细 JSON：{seen,dup,filtered:[],hits:[],priceDrops}
  error          TEXT
);

CREATE TABLE IF NOT EXISTS price_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  watch_item_id  INTEGER NOT NULL,
  price          REAL,
  captured_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_watch ON item(watch_item_id, xianyu_id);
CREATE INDEX IF NOT EXISTS idx_price_history_item ON price_history(item_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_scan_log_watch ON scan_log(watch_item_id, started_at);
`;

export function initDb(dbPath = path.join(DATA_DIR, 'app.db')) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 轻量迁移：为旧库补齐后加的列（新库由 SCHEMA 直接建出）
function migrate(instance) {
  const itemCols = new Set(instance.prepare("PRAGMA table_info(item)").all().map((c) => c.name));
  if (!itemCols.has('filter_status')) instance.prepare("ALTER TABLE item ADD COLUMN filter_status TEXT").run();
  if (!itemCols.has('filter_reason')) instance.prepare("ALTER TABLE item ADD COLUMN filter_reason TEXT").run();
  const logCols = new Set(instance.prepare("PRAGMA table_info(scan_log)").all().map((c) => c.name));
  if (!logCols.has('detail')) instance.prepare("ALTER TABLE scan_log ADD COLUMN detail TEXT").run();
}

export function getDb() {
  if (!db) initDb();
  return db;
}

// ---------- watch_item ----------

export function createWatchItem(fields) {
  const stmt = getDb().prepare(`
    INSERT INTO watch_item (keyword, target_price, min_price, max_price, include_words, exclude_words, area_include, area_exclude, account, ai_enabled, interval_sec, enabled)
    VALUES (@keyword, @target_price, @min_price, @max_price, @include_words, @exclude_words, @area_include, @area_exclude, @account, @ai_enabled, @interval_sec, @enabled)
  `);
  const row = {
    keyword: fields.keyword,
    target_price: fields.target_price ?? null,
    min_price: fields.min_price ?? null,
    max_price: fields.max_price ?? null,
    include_words: fields.include_words ?? null,
    exclude_words: fields.exclude_words ?? null,
    area_include: fields.area_include ?? null,
    area_exclude: fields.area_exclude ?? null,
    account: fields.account ?? null,
    ai_enabled: fields.ai_enabled ? 1 : 0,
    interval_sec: fields.interval_sec ?? 120,
    enabled: fields.enabled === undefined ? 1 : (fields.enabled ? 1 : 0),
  };
  const info = stmt.run(row);
  return getWatchItem(info.lastInsertRowid);
}

export function getWatchItem(id) {
  return getDb().prepare('SELECT * FROM watch_item WHERE id = ?').get(id);
}

export function listWatchItems({ enabledOnly = false } = {}) {
  const sql = 'SELECT * FROM watch_item' + (enabledOnly ? ' WHERE enabled = 1' : '') + ' ORDER BY id';
  return getDb().prepare(sql).all();
}

const WATCH_FIELDS = ['keyword', 'target_price', 'min_price', 'max_price', 'include_words', 'exclude_words', 'area_include', 'area_exclude', 'account', 'ai_enabled', 'interval_sec', 'enabled'];

export function updateWatchItem(id, fields) {
  const sets = [];
  const params = { id };
  for (const key of WATCH_FIELDS) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = @${key}`);
    params[key] = typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key];
  }
  if (!sets.length) return getWatchItem(id);
  getDb().prepare(`UPDATE watch_item SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getWatchItem(id);
}

export function deleteWatchItem(id) {
  getDb().prepare('DELETE FROM watch_item WHERE id = ?').run(id);
}

// ---------- item ----------

export function getItemByXianyuId(watchItemId, xianyuId) {
  return getDb().prepare('SELECT * FROM item WHERE watch_item_id = ? AND xianyu_id = ?').get(watchItemId, xianyuId);
}

export function insertItem(watchItemId, listing, { rawJson = null } = {}) {
  const info = getDb().prepare(`
    INSERT INTO item (watch_item_id, xianyu_id, title, descr, price, area, seller, url, image_url, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    watchItemId, listing.id, listing.title ?? null, listing.descr ?? null,
    listing.priceValue ?? null, listing.area ?? null, listing.seller ?? null,
    listing.url ?? null, listing.image ?? null, rawJson
  );
  return info.lastInsertRowid;
}

export function updateItemPrice(itemId, price) {
  getDb().prepare('UPDATE item SET price = ? WHERE id = ?').run(price, itemId);
}

export function recordPriceSnapshot(itemId, watchItemId, price) {
  getDb().prepare('INSERT INTO price_history (item_id, watch_item_id, price) VALUES (?, ?, ?)').run(itemId, watchItemId, price);
}

export function setAiVerdict(itemId, verdict, reason) {
  getDb().prepare('UPDATE item SET ai_verdict = ?, ai_reason = ? WHERE id = ?').run(verdict, reason ?? null, itemId);
}

// 记录规则判定结果（透明化：页面上每条商品都能看到为什么命中/被过滤）
export function setItemFilter(itemId, status, reason) {
  getDb().prepare('UPDATE item SET filter_status = ?, filter_reason = ? WHERE id = ?').run(status, reason ?? null, itemId);
}

// 按条件列商品：status = all | hit(已推送) | pass(达标) | filtered(被过滤)
// 商品筛选条件构建（listItems / countItems 共用，保证分页总数与列表口径一致）
function buildItemWhere({ watchItemId = null, status = 'all', keyword = '' } = {}) {
  const where = [];
  const params = {};
  if (watchItemId) { where.push('i.watch_item_id = @watchItemId'); params.watchItemId = watchItemId; }
  if (status === 'hit') where.push('i.notified_at IS NOT NULL');
  else if (status === 'pass') where.push('i.notified_at IS NULL AND i.filter_status = \'hit\'');
  else if (status === 'filtered') where.push('i.notified_at IS NULL AND i.filter_status = \'filtered\'');
  if (keyword) { where.push('(i.title LIKE @kw OR i.descr LIKE @kw)'); params.kw = `%${keyword}%`; }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export function listItems({ watchItemId = null, status = 'all', keyword = '', limit = 100, offset = 0 } = {}) {
  const { clause, params } = buildItemWhere({ watchItemId, status, keyword });
  const sql = `
    SELECT i.*, w.keyword FROM item i JOIN watch_item w ON w.id = i.watch_item_id
    ${clause}
    ORDER BY i.id DESC LIMIT @limit OFFSET @offset`;
  params.limit = Math.min(Number(limit) || 100, 500);
  params.offset = Number(offset) || 0;
  return getDb().prepare(sql).all(params);
}

// 与 listItems 同口径的商品总数（分页用）
export function countItems({ watchItemId = null, status = 'all', keyword = '' } = {}) {
  const { clause, params } = buildItemWhere({ watchItemId, status, keyword });
  return getDb().prepare(`SELECT COUNT(*) AS n FROM item i ${clause}`).get(params).n;
}

// 仪表盘统计
export function getStats() {
  const d = getDb();
  const one = (sql, ...args) => d.prepare(sql).get(...args);
  return {
    tasks: one('SELECT COUNT(*) AS n FROM watch_item').n,
    enabledTasks: one('SELECT COUNT(*) AS n FROM watch_item WHERE enabled = 1').n,
    items: one('SELECT COUNT(*) AS n FROM item').n,
    // 命中口径与命中记录页一致：规则达标（含首扫基线未推送），时间取推送时间/首见时间
    hits: one("SELECT COUNT(*) AS n FROM item WHERE filter_status = 'hit'").n,
    todayItems: one("SELECT COUNT(*) AS n FROM item WHERE first_seen_at >= date('now','localtime')").n,
    todayHits: one("SELECT COUNT(*) AS n FROM item WHERE filter_status = 'hit' AND COALESCE(notified_at, first_seen_at) >= date('now','localtime')").n,
    lastScan: one('SELECT started_at, status FROM scan_log ORDER BY id DESC LIMIT 1') || null,
  };
}

export function markNotified(itemId) {
  getDb().prepare("UPDATE item SET notified_at = datetime('now','localtime') WHERE id = ?").run(itemId);
}

// 命中记录口径 = 规则达标（filter_status='hit'），含首扫基线未推送的（notified_at 为空）
// 排序：已推送在前（按推送时间），未推送（首扫基线）在后（按首次看到时间）
export function listHits({ limit = 100, offset = 0 } = {}) {
  return getDb().prepare(`
    SELECT i.*, w.keyword FROM item i JOIN watch_item w ON w.id = i.watch_item_id
    WHERE i.filter_status = 'hit'
    ORDER BY (i.notified_at IS NULL) ASC, i.notified_at DESC, i.first_seen_at DESC, i.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function countHits() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM item WHERE filter_status = 'hit'").get().n;
}

export function listItemsByWatch(watchItemId, { limit = 100 } = {}) {
  return getDb().prepare('SELECT * FROM item WHERE watch_item_id = ? ORDER BY id DESC LIMIT ?').all(watchItemId, limit);
}

export function countItemsByWatch(watchItemId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM item WHERE watch_item_id = ?').get(watchItemId).n;
}

export function listPriceHistory(itemId, { limit = 200 } = {}) {
  return getDb().prepare('SELECT price, captured_at FROM price_history WHERE item_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?').all(itemId, limit);
}

// ---------- scan_log ----------

export function insertScanLog({ watchItemId = null, status, newCount = 0, detail = null, error = null }) {
  getDb().prepare('INSERT INTO scan_log (watch_item_id, status, new_count, detail, error) VALUES (?, ?, ?, ?, ?)')
    .run(watchItemId, status, newCount, detail ? JSON.stringify(detail) : null, error);
}

export function listScanLogs({ limit = 100, offset = 0 } = {}) {
  return getDb().prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function countScanLogs() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM scan_log').get().n;
}

// 数据清理：扫描日志/价格历史按保留天数删除；老商品档案保留核心字段、释放原始 JSON 空间
export function cleanupExpired(retentionDays = 30) {
  const days = Math.max(1, Number(retentionDays) || 30);
  const d = getDb();
  const scanLogs = d.prepare("DELETE FROM scan_log WHERE started_at < datetime('now','localtime', ?)").run(`-${days} days`).changes;
  const priceHistory = d.prepare("DELETE FROM price_history WHERE captured_at < datetime('now','localtime', ?)").run(`-${days} days`).changes;
  const rawJson = d.prepare("UPDATE item SET raw_json = NULL WHERE first_seen_at < datetime('now','localtime', ?) AND raw_json IS NOT NULL").run(`-${days} days`).changes;
  return { scanLogs, priceHistory, rawJson };
}

// 手动清空：页面三视图的「清空」按钮；price_history 随 item 外键级联删除
export function clearHits() {
  return getDb().prepare("DELETE FROM item WHERE filter_status = 'hit'").run().changes;
}

export function clearItems() {
  return getDb().prepare('DELETE FROM item').run().changes;
}

export function clearScanLogs() {
  return getDb().prepare('DELETE FROM scan_log').run().changes;
}

// 按 id 批量删除（页面勾选多选删除）；命中视图的行 id 即 item.id，复用 deleteItemsByIds
export function deleteItemsByIds(ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  return getDb().prepare(`DELETE FROM item WHERE id IN (${list.map(() => '?').join(',')})`).run(...list).changes;
}

export function deleteScanLogsByIds(ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  return getDb().prepare(`DELETE FROM scan_log WHERE id IN (${list.map(() => '?').join(',')})`).run(...list).changes;
}

// ---------- config（KV，存 JSON 字符串）----------

export function getConfigValue(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setConfigValue(key, value) {
  getDb().prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
