// 运行时数据根：可写路径（data/、config.json、state/）的统一基准目录
// - Electron 打包态：main.js 在加载业务模块前注入 process.env.XSNIPER_DATA_ROOT（app.getPath('userData')），
//   可写文件落到 %APPDATA%/<应用名>/，避开只读的 app.asar（asar 内 mkdir/写入报 ENOTDIR/EACCES）
// - 源码态（node CLI / npm run electron）：无 env，回退项目根，保持 data/、config.json、state/ 原位
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runtimeRoot() {
  return process.env.XSNIPER_DATA_ROOT || path.resolve(__dirname, '..');
}
