// 入口：CLI 参数解析与启动编排
// 用法：
//   node src/index.js login                    有头登录并保存登录态
//   node src/index.js add <关键词> [选项]       新增监控任务
//   node src/index.js list                     列出任务
//   node src/index.js rm <id>                  删除任务
//   node src/index.js enable|disable <id>      启用/停用任务
//   node src/index.js run [--once]             启动调度器+Web（--once 只扫一轮）
//   node src/index.js test-notify              发送测试通知
import { initDb, createWatchItem, listWatchItems, getWatchItem, updateWatchItem, deleteWatchItem } from './store/db.js';
import { loadConfig } from './config.js';
import { createNotifier } from './notify/index.js';
import { createScheduler } from './scheduler.js';
import { startWebServer } from './web/server.js';
import { runLogin } from './capture/browser.js';
import { spawn } from 'node:child_process';

// 用系统默认浏览器打开控制台（打开失败不影响运行）
function openInBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 忽略自动打开失败
  }
}

// 解析 --key value / --flag 形式的参数
function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function optionalNumber(options, key) {
  if (options[key] === undefined) return null;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} 需要是数字`);
  }
  return value;
}

function printHelp() {
  console.log(`xianyu-sniper — 闲鱼蹲价监控

用法：
  npm run login                 有头登录并保存登录态（首次使用必须）
  node src/index.js add <关键词> [--target 999] [--min 100] [--max 2000]
                                [--include "国行|官换"] [--exclude "回收,换购"]
                                [--area-include 上海] [--area-exclude 异地]
                                [--account 账号名] [--ai] [--interval 120]
  node src/index.js list        列出监控任务
  node src/index.js rm <id>     删除任务
  node src/index.js enable <id> / disable <id>
  node src/index.js run         启动调度器与 Web 控制台（默认 http://127.0.0.1:8787）
  node src/index.js run --once  只扫描一轮后退出
  node src/index.js test-notify 测试通知渠道`);
}

async function cmdAdd(options) {
  const keyword = options._keyword;
  if (!keyword) throw new Error('用法：node src/index.js add <关键词> [选项]');
  const item = createWatchItem({
    keyword,
    target_price: optionalNumber(options, 'target'),
    min_price: optionalNumber(options, 'min'),
    max_price: optionalNumber(options, 'max'),
    include_words: options.include || null,
    exclude_words: options.exclude || null,
    area_include: options['area-include'] || null,
    area_exclude: options['area-exclude'] || null,
    account: options.account || null,
    ai_enabled: Boolean(options.ai),
    interval_sec: optionalNumber(options, 'interval') ?? 120,
  });
  console.log(`已创建任务 #${item.id}：${item.keyword}`);
}

async function cmdList() {
  const items = listWatchItems();
  if (!items.length) {
    console.log('暂无任务。用 node src/index.js add <关键词> 创建。');
    return;
  }
  for (const item of items) {
    const rule = [
      item.target_price != null ? `目标价≤${item.target_price}` : '',
      item.min_price != null || item.max_price != null ? `区间 ${item.min_price ?? '-'}~${item.max_price ?? '-'}` : '',
      item.include_words ? `含:${item.include_words}` : '',
      item.exclude_words ? `排:${item.exclude_words}` : '',
      item.area_include ? `地区:${item.area_include}` : '',
      item.area_exclude ? `排地区:${item.area_exclude}` : '',
    ].filter(Boolean).join('，');
    console.log(
      `#${item.id} [${item.enabled ? '启用' : '停用'}] ${item.keyword}` +
      `${item.ai_enabled ? ' [AI]' : ''} ${item.interval_sec}s ${rule ? '｜' + rule : ''}`
    );
  }
}

async function cmdRun(options, config, notifier) {
  const scheduler = createScheduler({ config, notifier });
  initDb();

  if (options.once) {
    console.log('单轮扫描模式...');
    await scheduler.runOnce();
    await scheduler.stop();
    return;
  }

  scheduler.start();
  const { port } = await startWebServer({ scheduler, notifier }); // 实际端口（含顺延）
  const { host } = config.server;
  const consoleUrl = `http://${host}:${port}`;
  console.log(`调度器已启动，Web 控制台：${consoleUrl}`);
  console.log('按 Ctrl+C 退出');
  openInBrowser(consoleUrl);

  const shutdown = async () => {
    console.log('\n正在退出...');
    await scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdTestNotify(config, notifier) {
  console.log(`启用渠道：${notifier.channelNames.join('、') || '无（请在 config.json 配置 notify）'}`);
  const result = await notifier.send({
    title: '🔔 xianyu-sniper 测试推送',
    body: `这是一条测试通知。\n时间：${new Date().toLocaleString()}`,
    url: 'https://www.goofish.com/',
  });
  if (result.delivered.length) console.log(`推送成功：${result.delivered.join('、')}`);
  if (result.errors.length) {
    console.error(`推送失败：\n  ${result.errors.join('\n  ')}`);
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0] || (options.login ? 'login' : 'help');

  switch (command) {
    case 'login':
      await runLogin(options.account || undefined);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'test-notify':
      await cmdTestNotify(loadConfig(), createNotifier(loadConfig()));
      return;
    case 'add':
      options._keyword = positional[1];
      initDb();
      await cmdAdd(options);
      return;
    case 'list':
      initDb();
      await cmdList();
      return;
    case 'rm': {
      const id = Number(positional[1]);
      if (!getWatchItem(id)) throw new Error(`任务 #${id} 不存在`);
      deleteWatchItem(id);
      console.log(`已删除任务 #${id}`);
      return;
    }
    case 'enable':
    case 'disable': {
      const id = Number(positional[1]);
      if (!getWatchItem(id)) throw new Error(`任务 #${id} 不存在`);
      updateWatchItem(id, { enabled: command === 'enable' });
      console.log(`已${command === 'enable' ? '启用' : '停用'}任务 #${id}`);
      return;
    }
    case 'run':
      await cmdRun(options, loadConfig(), createNotifier(loadConfig()));
      return;
    default:
      console.error(`未知命令：${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[xianyu-sniper] 执行失败:', error.message);
  process.exitCode = 1;
});
