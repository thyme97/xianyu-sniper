// 通知中心：注册各渠道并按配置分发
// 每个渠道模块统一实现 notify(payload) 接口；配置了对应 Key 即启用该渠道
import * as bark from './bark.js';
import * as desktop from './desktop.js';
import * as serverchan from './serverchan.js';
import * as telegram from './telegram.js';
import * as dingtalk from './dingtalk.js';
import * as feishu from './feishu.js';
import * as webhook from './webhook.js';

// 创建通知器：根据 config.notify 启用渠道；desktop 默认开启（Windows），可设 false 关闭
export function createNotifier(config) {
  const notifyConfig = config.notify || {};
  const channels = [];

  if (notifyConfig.bark) channels.push(['bark', (p) => bark.notify(p, notifyConfig.bark)]);
  if (notifyConfig.serverchan) channels.push(['serverchan', (p) => serverchan.notify(p, notifyConfig.serverchan)]);
  if (notifyConfig.telegram) channels.push(['telegram', (p) => telegram.notify(p, notifyConfig.telegram)]);
  if (notifyConfig.dingtalk) channels.push(['dingtalk', (p) => dingtalk.notify(p, notifyConfig.dingtalk)]);
  if (notifyConfig.webhook) channels.push(['webhook', (p) => webhook.notify(p, notifyConfig.webhook)]);
  if (notifyConfig.feishu) channels.push(['feishu', (p) => feishu.notify(p, notifyConfig.feishu)]);
  if (notifyConfig.desktop !== false) channels.push(['desktop', (p) => desktop.notify(p)]);

  return {
    // 已启用的渠道名列表（供 UI/CLI 展示）
    get channelNames() {
      return channels.map(([name]) => name);
    },
    // 向所有启用渠道推送；返回 { delivered, errors }，单渠道失败不影响其他渠道
    async send(payload) {
      const delivered = [];
      const errors = [];
      for (const [name, fn] of channels) {
        try {
          await fn(payload);
          delivered.push(name);
        } catch (error) {
          errors.push(`${name}: ${error.message}`);
        }
      }
      return { delivered, errors };
    },
  };
}
