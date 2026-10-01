// Electron 宿主入口：窗口 + 托盘常驻 + 单实例锁 + 退出清理
// 复用全部现有 src/（Fastify/scheduler/采集/通知），控制台窗口 loadURL 本地服务
// 开发运行：npm run electron
import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, 'assets');

// 开发诊断：主进程漏网异常打到 stderr（Electron 默认只弹 GUI 错误框不写日志）
process.on('uncaughtException', (error) => {
  console.error('[electron] uncaughtException：', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron] unhandledRejection：', reason);
});

// ---------- 单实例锁：防双开两个调度器轰炸闲鱼接口 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已在运行：把控制台窗口拉到前台
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let tray = null;
let scheduler = null;
let config = null;
let dbModule = null;   // store/db.js 模块（动态加载，见 boot）
let appQuitting = false; // 区分「关窗收托盘」与「真正退出」
let trayState = '';     // 当前托盘状态：ok | scan | error | idle
let scanWindowVisible = false; // 托盘菜单显示/隐藏扫描窗口的本地记忆

// 打包态可写根注入：打包后 __dirname 在只读 app.asar 内，data/config/state 必须落到
// userData（asar 外），否则 mkdir/写入报 ENOTDIR。必须在下方 boot() 动态 import 业务模块
// 之前设置（paths.js 模块求值时读取该 env）；源码态不注入，数据保持在项目根与 CLI 共用。
if (app.isPackaged) process.env.XSNIPER_DATA_ROOT = app.getPath('userData');

// 单实例锁成功后启动（放在模块级变量声明后，避免 TDZ）
boot();

// 托盘三态图标（scripts/gen-tray-icons.js 生成）
function trayIcon(name) {
  return nativeImage.createFromPath(path.join(ASSETS, `tray-${name}.png`));
}

// 托盘状态判定：登录失效 > 扫描中 > 运行中 > 已停止
function currentTrayState() {
  if (dbModule?.getConfigValue('loginStateExpired')) return 'error';
  if (!scheduler.running) return 'idle';
  return scheduler.busy ? 'scan' : 'ok';
}

const STATE_TEXT = {
  ok: '运行中 · 已登录',
  scan: '正在扫描…',
  error: '登录已失效，请重新扫码',
  idle: '已停止',
};

function createWindow(consoleUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: '闲鱼蹲价助手',
    icon: trayIcon('ok'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  mainWindow.loadURL(consoleUrl);
  // 关窗 = 收进托盘继续挂机（挂机核心：任务栏干净但服务不死）；真正退出走托盘菜单
  mainWindow.on('close', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function buildTrayMenu() {
  const scanning = trayState === 'scan';
  return Menu.buildFromTemplate([
    // 状态行（不可点）：打开菜单即可看到当前状态，与图标/tooltip 一致
    { label: `● ${STATE_TEXT[trayState] || STATE_TEXT.idle}`, enabled: false },
    { type: 'separator' },
    { label: '打开控制台', click: () => { mainWindow.show(); mainWindow.focus(); } },
    {
      label: scanning ? '扫描中，请稍候…' : '立即扫描一轮',
      enabled: !scanning,
      click: () => {
        scheduler.runOnce().catch(() => {});
        trayState = ''; // 置空让状态轮询立即刷新菜单为「扫描中」
      },
    },
    {
      label: '显示扫描窗口',
      type: 'checkbox',
      checked: scanWindowVisible,
      click: async (item) => {
        try {
          await scheduler.showScanWindow(item.checked);
          scanWindowVisible = item.checked;
        } catch {
          item.checked = false;
          scanWindowVisible = false;
        }
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: '退出并停止监控', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon('ok'));
  tray.setToolTip('闲鱼蹲价助手');
  tray.setContextMenu(buildTrayMenu());
  // 左键点托盘 = 打开控制台
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });

  // 托盘三态轮询：图标 + tooltip + 菜单状态刷新（5s 与前端登录状态轮询同节奏）
  setInterval(() => {
    const state = currentTrayState();
    if (state !== trayState) {
      trayState = state;
      tray.setImage(trayIcon(state));
      tray.setToolTip(`闲鱼蹲价助手 · ${STATE_TEXT[state]}`);
      tray.setContextMenu(buildTrayMenu()); // 重建菜单同步「显示扫描窗口」勾选
    } else if (state === 'scan' || state === 'ok') {
      // 扫描中→正常 会频繁互切，仅 tooltip 实时更新，图标切换交给上面的状态差判断
      tray.setToolTip(`闲鱼蹲价助手 · ${STATE_TEXT[currentTrayState()]}`);
    }
  }, 5000);
}

async function boot() {
  try {
    // 业务模块动态加载：须在上方 env 注入之后才求值，paths.js 才能解析到可写根
    // （ESM 静态 import 会提升到模块体之前执行，env 来不及设置）
    dbModule = await import('../store/db.js');
    const [{ loadConfig }, { createNotifier }, { createScheduler }, { startWebServer }] = await Promise.all([
      import('../config.js'),
      import('../notify/index.js'),
      import('../scheduler.js'),
      import('../web/server.js'),
    ]);

    config = loadConfig();
    dbModule.initDb();
    const notifier = createNotifier(config);
    scheduler = createScheduler({ config, notifier });
    scheduler.start();
    const { host } = config.server;
    const { port } = await startWebServer({ scheduler, notifier }); // 实际端口（含顺延）
    const consoleUrl = `http://${host}:${port}`;
    console.log(`[electron] 调度器与 Web 控制台已启动：${consoleUrl}`);

    await app.whenReady();
    createWindow(consoleUrl);
    createTray();

    // 带 --hidden 启动（开机自启）时不弹窗口，只留在托盘
    if (process.argv.includes('--hidden')) mainWindow.hide();
  } catch (error) {
    // 端口被占等启动失败：stderr 留档 + 弹系统错误框（此时可能没有窗口）
    console.error('[electron] 启动失败：', error);
    const { dialog } = await import('electron');
    dialog.showErrorBox('闲鱼蹲价助手启动失败', String(error.message || error));
    app.quit();
  }
}

app.on('before-quit', async () => {
  // 真正退出：停调度器并清理 Playwright 浏览器（防僵尸 Chrome 进程残留）
  if (appQuitting) return;
  appQuitting = true;
  try { await scheduler?.stop(); } catch { /* 退出清理失败不阻断 */ }
});

// macOS 惯例：点 Dock 图标重新显示窗口（Windows 托盘模式基本用不到，保留兼容）
app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

// 外部链接（商品页等）用系统默认浏览器打开，不在壳内跳转
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});
