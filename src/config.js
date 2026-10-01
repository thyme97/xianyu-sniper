// 配置模块：config.json（gitignore）读写，缺失时回退默认值
import fs from 'node:fs';
import path from 'node:path';
import { runtimeRoot } from './paths.js';

export const CONFIG_PATH = path.join(runtimeRoot(), 'config.json');

export const DEFAULT_CONFIG = {
  server: { host: '127.0.0.1', port: 8787 },
  notify: {
    bark: '',
    serverchan: '',
    telegram: '',
    dingtalk: '',
    webhook: '',
    feishu: '',
    desktop: true,
  },
  ai: {
    enabled: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4-flash',
    strict: false,
  },
  scan: { firstScanNotify: false, retentionDays: 30 },
};

function deepMerge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return deepMerge(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(patch) {
  const merged = deepMerge(loadConfig(), patch || {});
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
