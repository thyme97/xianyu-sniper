'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  shell,
  dialog,
} = require('electron');
const { extractListings, keywordsFrom, searchUrl } = require('./xianyu-parser');

const defaultConfig = {
  keywordsText: '',
  intervalSec: 60,
  notifyOnFirstRun: false,
  browserNotify: true,
  webhookMode: 'json',
  webhookUrl: '',
  keepMonitorVisible: false,
  minPrice: '',
  maxPrice: '',
  includeText: '',
  excludeText: '',
  includeArea: '',
  excludeArea: '',
};

let mainWindow;
let monitorWindow;
let config = { ...defaultConfig };
let runtime = {
  running: false,
  currentIndex: 0,
  currentKeyword: '',
  lastScanAt: '',
  lastCount: 0,
  lastFresh: 0,
  timer: null,
};

function userDataPath(file) {
  return path.join(app.getPath('userData'), file);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function loadConfig() {
  config = { ...defaultConfig, ...readJson(userDataPath('config.json'), {}) };
  return config;
}

function saveConfig(nextConfig) {
  config = {
    ...config,
    ...nextConfig,
    intervalSec: Math.max(15, Number(nextConfig.intervalSec || config.intervalSec || 60)),
  };
  writeJson(userDataPath('config.json'), config);
  return config;
}

function seenPath() {
  return userDataPath('seen.json');
}

function readSeen() {
  return readJson(seenPath(), {});
}

function saveSeen(seen) {
  writeJson(seenPath(), seen);
}

function emit(type, data = {}) {
  const payload = {
    type,
    at: new Date().toLocaleString(),
    runtime: publicStatus(),
    ...data,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:event', payload);
  }
}

function publicStatus() {
  return {
    running: runtime.running,
    currentIndex: runtime.currentIndex,
    currentKeyword: runtime.currentKeyword,
    lastScanAt: runtime.lastScanAt,
    lastCount: runtime.lastCount,
    lastFresh: runtime.lastFresh,
    monitorVisible: monitorWindow ? monitorWindow.isVisible() : false,
  };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    title: '闲鱼货源监控',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  createApplicationMenu();
}

function createApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开闲鱼登录窗口',
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            const win = createMonitorWindow();
            win.show();
            win.loadURL('https://www.goofish.com/');
            emit('log', { message: '已通过菜单打开闲鱼登录窗口。' });
          },
        },
        {
          label: '显示监控窗口',
          accelerator: 'CmdOrCtrl+M',
          click: () => {
            const win = createMonitorWindow();
            win.show();
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '监控',
      submenu: [
        {
          label: '停止监控',
          accelerator: 'CmdOrCtrl+.',
          click: () => stopMonitor('已通过菜单停止监控。'),
        },
        {
          label: '清空去重记录',
          click: () => {
            saveSeen({});
            emit('log', { message: '已通过菜单清空去重记录。' });
          },
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开使用说明',
          click: () => shell.openPath(path.join(app.getAppPath(), 'README.md')),
        },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于闲鱼货源监控',
              message: '闲鱼货源监控',
              detail: `版本：${app.getVersion()}\n用于监控闲鱼搜索页新上架货源，并通过桌面通知或 Webhook 推送。`,
              buttons: ['知道了'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMonitorWindow() {
  if (monitorWindow && !monitorWindow.isDestroyed()) return monitorWindow;

  monitorWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    show: Boolean(config.keepMonitorVisible),
    title: '闲鱼登录/监控窗口',
    webPreferences: {
      preload: path.join(__dirname, 'monitor-preload.js'),
      partition: 'persist:xianyu-monitor',
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  monitorWindow.on('closed', () => {
    monitorWindow = null;
    if (runtime.running) stopMonitor('监控窗口已关闭，已停止监控。');
  });

  monitorWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  monitorWindow.webContents.on('did-finish-load', () => {
    if (!runtime.running) return;
    monitorWindow.webContents.executeJavaScript(`
      (() => {
        const labels = ['最新', '最新发布', '新上架', '发布时间'];
        const nodes = [...document.querySelectorAll('button,a,span,div')];
        const target = nodes.find((node) => labels.includes(node.textContent?.trim()));
        if (target) target.click();
      })();
    `).catch(() => {});
  });

  return monitorWindow;
}

function clearTimer() {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
}

function startMonitor(nextConfig) {
  saveConfig(nextConfig);
  const keywords = keywordsFrom(config.keywordsText);
  if (!keywords.length) {
    throw new Error('请至少设置一个关键词。');
  }

  runtime.running = true;
  runtime.currentIndex = 0;
  runtime.currentKeyword = keywords[0];
  runtime.lastScanAt = '';
  runtime.lastCount = 0;
  runtime.lastFresh = 0;

  const win = createMonitorWindow();
  if (config.keepMonitorVisible) win.show();
  loadCurrentKeyword();
  emit('log', { message: `开始监控：${keywords.join('、')}` });
  return publicStatus();
}

function stopMonitor(reason = '已停止监控。') {
  runtime.running = false;
  clearTimer();
  emit('log', { message: reason });
  return publicStatus();
}

function loadCurrentKeyword() {
  if (!runtime.running) return;
  const keywords = keywordsFrom(config.keywordsText);
  if (!keywords.length) return stopMonitor('关键词为空，已停止。');

  runtime.currentIndex = runtime.currentIndex % keywords.length;
  runtime.currentKeyword = keywords[runtime.currentIndex];
  const win = createMonitorWindow();
  win.loadURL(searchUrl(runtime.currentKeyword));
  emit('log', { message: `加载关键词：${runtime.currentKeyword}` });
}

function scheduleNextLoad() {
  clearTimer();
  if (!runtime.running) return;

  runtime.timer = setTimeout(() => {
    const keywords = keywordsFrom(config.keywordsText);
    if (!keywords.length) return stopMonitor('关键词为空，已停止。');
    runtime.currentIndex = (runtime.currentIndex + 1) % keywords.length;
    loadCurrentKeyword();
  }, Math.max(15, Number(config.intervalSec || 60)) * 1000);
}

async function handleSearchPayload(message) {
  if (!runtime.running || !message?.payload) return;

  const keyword = runtime.currentKeyword || keywordsFrom(config.keywordsText)[runtime.currentIndex] || '';
  if (!keyword) return;

  const listings = extractListings(message.payload, keyword);
  if (!listings.length) {
    emit('scan', { message: `扫描 ${keyword}：未解析到商品。`, listings: [] });
    scheduleNextLoad();
    return;
  }

  const allSeen = readSeen();
  const keywordSeen = allSeen[keyword] || {};
  const isFirstRun = Object.keys(keywordSeen).length === 0;
  const now = Date.now();
  const fresh = [];

  for (const item of listings) {
    if (!keywordSeen[item.id]) fresh.push(item);
    keywordSeen[item.id] = now;
  }

  allSeen[keyword] = trimSeen(keywordSeen);
  saveSeen(allSeen);

  const shouldNotify = !(isFirstRun && !config.notifyOnFirstRun);
  const freshAfterFilter = fresh.filter((item) => matchesFilters(item, config));
  const freshToNotify = shouldNotify ? freshAfterFilter : [];
  runtime.lastScanAt = new Date().toLocaleString();
  runtime.lastCount = listings.length;
  runtime.lastFresh = freshToNotify.length;

  emit('scan', {
    message: isFirstRun && !config.notifyOnFirstRun
      ? `扫描 ${keyword}：建立基线 ${listings.length} 条，暂不推送旧商品。`
      : `扫描 ${keyword}：${listings.length} 条，新出现 ${fresh.length} 条，符合筛选 ${freshToNotify.length} 条。`,
    listings: freshToNotify.slice(0, 20),
  });

  for (const item of freshToNotify.slice(0, 20)) {
    await notifyListing(item);
  }

  scheduleNextLoad();
}

function matchesFilters(item, conf) {
  const text = `${item.title || ''} ${item.price || ''} ${item.area || ''}`.toLowerCase();
  const area = String(item.area || '').toLowerCase();
  const price = parsePrice(item.price);

  const minPrice = Number(conf.minPrice);
  if (Number.isFinite(minPrice) && conf.minPrice !== '') {
    if (price == null || price < minPrice) return false;
  }

  const maxPrice = Number(conf.maxPrice);
  if (Number.isFinite(maxPrice) && conf.maxPrice !== '') {
    if (price == null || price > maxPrice) return false;
  }

  const includeTextRules = ruleList(conf.includeText);
  if (includeTextRules.length && !includeTextRules.some((rule) => text.includes(rule))) return false;

  const excludeTextRules = ruleList(conf.excludeText);
  if (excludeTextRules.length && excludeTextRules.some((rule) => text.includes(rule))) return false;

  const includeAreaRules = ruleList(conf.includeArea);
  if (includeAreaRules.length && !includeAreaRules.some((rule) => area.includes(rule))) return false;

  const excludeAreaRules = ruleList(conf.excludeArea);
  if (excludeAreaRules.length && excludeAreaRules.some((rule) => area.includes(rule))) return false;

  return true;
}

function ruleList(value) {
  return String(value || '')
    .split(/[\n,，|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parsePrice(value) {
  const text = String(value || '').replace(/,/g, '');
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function trimSeen(seen) {
  return Object.fromEntries(
    Object.entries(seen)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 1000)
  );
}

async function notifyListing(item) {
  const title = `闲鱼新货源：${item.keyword}`;
  const body = [
    item.title,
    item.price ? `价格：${item.price}` : '',
    item.area ? `地区：${item.area}` : '',
    item.url,
  ].filter(Boolean).join('\n');

  if (config.browserNotify && Notification.isSupported()) {
    const notification = new Notification({
      title,
      body,
    });
    notification.on('click', () => shell.openExternal(item.url));
    notification.show();
  }

  if (config.webhookUrl) {
    await sendWebhook(config.webhookMode, config.webhookUrl, { title, body, item });
  }
}

async function sendWebhook(mode, url, message) {
  try {
    if (mode === 'bark') {
      const base = normalizeBarkUrl(url).replace(/\/$/, '');
      const barkUrl = `${base}/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}?url=${encodeURIComponent(message.item.url)}`;
      await fetch(barkUrl);
      return;
    }

    if (mode === 'serverchan') {
      await fetch(normalizeServerChanUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `title=${encodeURIComponent(message.title)}&desp=${encodeURIComponent(message.body)}`,
      });
      return;
    }

    if (mode === 'xxtui') {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          title: message.title,
          content: message.body,
          url: message.item.url,
        }),
      });
      return;
    }

    if (mode === 'telegram') {
      const target = parseTelegramTarget(url);
      await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: `${message.title}\n\n${message.body}`,
          disable_web_page_preview: false,
        }),
      });
      return;
    }

    if (mode === 'dingtalk') {
      await fetch(dingTalkWebhookUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title: message.title,
            text: `### ${message.title}\n\n${message.body.replace(/\n/g, '\n\n')}\n\n[打开商品](${message.item.url})`,
          },
        }),
      });
      return;
    }

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(message),
    });
  } catch (error) {
    emit('log', { message: `Webhook 推送失败：${friendlyWebhookError(mode, error)}` });
  }
}

function normalizeBarkUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Bark 推送地址为空。');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://api.day.app/${encodeURIComponent(value)}`;
}

function normalizeServerChanUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Server 酱 SendKey 为空。');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://sctapi.ftqq.com/${encodeURIComponent(value)}.send`;
}

function parseTelegramTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Telegram 推送配置为空。');

  if (value.startsWith('https://api.telegram.org/bot')) {
    const url = new URL(value);
    const chatId = url.searchParams.get('chat_id');
    if (!chatId) {
      throw new Error('Telegram 完整 URL 需要包含 chat_id 参数。');
    }
    return {
      url: `${url.origin}${url.pathname}`,
      chatId,
    };
  }

  const [token, chatId] = value.split(/[|#，,\s]+/).map((item) => item.trim()).filter(Boolean);
  if (!token || !chatId) {
    throw new Error('Telegram 配置格式应为 botToken#chatId，或完整 sendMessage URL。');
  }

  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    chatId,
  };
}

function dingTalkWebhookUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('钉钉 Webhook 为空。');

  const [webhook, meta = ''] = value.split('#');
  const normalizedWebhook = /^https?:\/\//i.test(webhook)
    ? webhook
    : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(webhook)}`;
  const secretMatch = meta.match(/(?:secret=)?(SEC[a-zA-Z0-9]+)/);
  if (!secretMatch) return normalizedWebhook;

  const timestamp = Date.now();
  const secret = secretMatch[1];
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const url = new URL(normalizedWebhook);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

function friendlyWebhookError(mode, error) {
  const raw = error?.message || String(error);
  const tips = {
    json: '通用 JSON 需要填写完整 http/https URL。',
    bark: 'Bark 可填写完整 https://api.day.app/KEY，或只填 KEY。',
    serverchan: 'Server 酱可填写完整推送 URL，或只填 SendKey。',
    telegram: 'Telegram 请填写 botToken#chatId，或完整 sendMessage URL 且包含 chat_id。',
    dingtalk: '钉钉可填写完整机器人 Webhook，或只填 access_token；加签写 #secret=SECxxx。',
    xxtui: '息知/XXTui 需要填写完整 http/https 推送 URL。',
  };
  return `${raw}。${tips[mode] || ''}`.trim();
}

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_event, nextConfig) => saveConfig(nextConfig));
ipcMain.handle('monitor:start', (_event, nextConfig) => startMonitor(nextConfig));
ipcMain.handle('monitor:stop', () => stopMonitor());
ipcMain.handle('monitor:status', () => publicStatus());
ipcMain.handle('seen:clear', () => {
  saveSeen({});
  emit('log', { message: '已清空去重记录。' });
  return true;
});
ipcMain.handle('monitor:open-login', () => {
  const win = createMonitorWindow();
  win.show();
  win.loadURL('https://www.goofish.com/');
  emit('log', { message: '已打开闲鱼登录窗口。登录完成后可回到主窗口开始监控。' });
  return true;
});
ipcMain.handle('monitor:show-window', () => {
  const win = createMonitorWindow();
  win.show();
  return true;
});
ipcMain.handle('notify:test', async (_event, nextConfig) => {
  saveConfig(nextConfig);
  await notifyListing({
    id: 'test',
    keyword: '测试关键词',
    title: '这是一条测试推送',
    price: '¥123',
    area: '测试地区',
    url: 'https://www.goofish.com/',
  });
  emit('log', { message: '已发送测试通知。' });
  return true;
});
ipcMain.handle('open:external', (_event, url) => shell.openExternal(url));

ipcMain.on('monitor:payload', (_event, message) => {
  handleSearchPayload(message).catch((error) => {
    emit('log', { message: `处理搜索结果失败：${error.message || error}` });
    scheduleNextLoad();
  });
});

app.whenReady().then(() => {
  loadConfig();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
