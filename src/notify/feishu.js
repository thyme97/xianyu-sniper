// 通知渠道：飞书群机器人 Webhook
// 配置格式：完整机器人 Webhook 地址（https://open.feishu.cn/open-apis/bot/v2/hook/xxx）
export async function notify(payload, option) {
  const url = String(option || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('飞书 Webhook 需要填写完整的机器人 Webhook 地址');
  }
  const text = `${payload.title}\n${payload.body || ''}${payload.url ? `\n${payload.url}` : ''}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  });
  if (!response.ok) {
    throw new Error(`飞书推送失败：HTTP ${response.status}`);
  }
  // 飞书业务失败时 HTTP 仍是 200，需检查响应体（新版 code / 旧版 StatusCode）
  const data = await response.json().catch(() => ({}));
  const failed = data && (data.code != null ? data.code !== 0 : data.StatusCode != null ? data.StatusCode !== 0 : false);
  if (failed) {
    throw new Error(`飞书推送失败：${data.msg || data.StatusMessage || data.code || data.StatusCode}`);
  }
}
