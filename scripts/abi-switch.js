// better-sqlite3 双宿主 ABI 切换：node / electron 两个二进制备份本地互换
// 背景：better-sqlite3 v12 为 V8-API 原生模块，Node 与 Electron 的 ABI 不同，
//       build/Release 只能放一份。首次使用需联网各下载一份（存 .bak 备份），
//       之后切换纯本地复制，零网络、秒级。
// 用法：node scripts/abi-switch.js <node|electron>
//   npm run abi:node      切到 Node ABI（npm start / npm run login / 单测用）
//   npm run abi:electron  切到 Electron ABI（npm run electron 用）
// 注意：切换前先停掉正在运行的服务/Electron，避免文件被占用。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'better-sqlite3');
const releaseDir = path.join(pkgDir, 'build', 'Release');
const target = path.join(releaseDir, 'better_sqlite3.node');
const abiMark = path.join(releaseDir, 'current-abi.txt');

const mode = process.argv[2];
if (mode !== 'node' && mode !== 'electron') {
  console.error('用法：node scripts/abi-switch.js <node|electron>');
  process.exit(1);
}

function readVersion(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

// electron ABI 由 electron 进程自报，避免维护版本号映射表
function electronAbi() {
  const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) throw new Error('electron 二进制缺失：先跑 node node_modules/electron/install.js');
  return execFileSync(exe, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).toString().trim();
}

function download(url, dest, retries = 3) {
  const once = () => new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
  return (async () => {
    for (let i = 1; i <= retries; i++) {
      try { await once(); return; } catch (error) {
        if (i === retries) throw error;
        console.warn(`[abi] 下载失败（第 ${i} 次），重试：${error.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
}

// 下载 prebuild tar.gz 并只解出 better_sqlite3.node 放到 dest
async function fetchAbi(url, dest) {
  const tmp = path.join(os.tmpdir(), path.basename(url));
  await download(url, tmp);
  const tmpDir = path.join(os.tmpdir(), `bs3-abi-${mode}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('tar', ['-xzf', tmp, '-C', tmpDir]);
  fs.copyFileSync(path.join(tmpDir, 'build', 'Release', 'better_sqlite3.node'), dest);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const bs3 = readVersion(path.join(pkgDir, 'package.json'));
const platformArch = `${process.platform}-${process.arch}`;
const bakPath = path.join(releaseDir, `better_sqlite3.${mode}abi.bak`);

const current = fs.existsSync(abiMark) ? fs.readFileSync(abiMark, 'utf8').trim() : 'node';
if (current === mode) {
  console.log(`[abi] 当前已是 ${mode} ABI，无需切换`);
  process.exit(0);
}

// 目标 ABI：优先用本地备份；没有则联网下载一份并留作备份
if (fs.existsSync(bakPath)) {
  console.log(`[abi] 使用本地备份 → ${mode} ABI`);
} else {
  const abi = mode === 'electron' ? electronAbi() : process.versions.modules;
  // 统一走 npmmirror 二进制镜像（GitHub 直连在本环境不可靠）
  const url = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${bs3}/better-sqlite3-v${bs3}-${mode === 'electron' ? 'electron' : 'node'}-v${abi}-${platformArch}.tar.gz`;
  console.log(`[abi] 本地无备份，联网下载：${url}`);
  await fetchAbi(url, bakPath);
  console.log(`[abi] 已缓存备份：${bakPath}`);
}

// 换走前把当前二进制备份成另一模式的 .bak（形成双备份闭环）
if (fs.existsSync(target)) {
  fs.copyFileSync(target, path.join(releaseDir, `better_sqlite3.${current}abi.bak`));
}
fs.copyFileSync(bakPath, target);
fs.writeFileSync(abiMark, mode);

console.log(`[abi] 已切换到 ${mode} ABI。`);
if (mode === 'electron') console.log('[abi] 启动桌面版：npm run electron');
else console.log('[abi] 启动 Node 模式：npm start（或 npm run login / 单测）');
