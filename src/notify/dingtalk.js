// 通知渠道：钉钉群机器人 Webhook（支持加签）
// 配置格式：access_token 或完整 Webhook URL；加签写 #secret=SECxxx
import crypto from 'node:crypto';

function dingTalkWebhookUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('钉钉 Webhook 为空');

  const [webhook, meta = ''] = value.split('#');
  const normalizedWebhook = /^https?:\/\//i.test(webhook)
    ? webhook
    : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(webhook)}`;

  const secretMatch = meta.match(/(?:secret=)?(SEC[a-zA-Z0-9]+)/);
  if (!secretMatch) return normalizedWebhook;

  // 加签：timestamp + HMAC-SHA256
  const timestamp = Date.now();
  const secret = secretMatch[1];
  const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  const url = new URL(normalizedWebhook);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

export async function notify(payload, option) {
  const response = await fetch(dingTalkWebhookUrl(option), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        title: payload.title,
        text: `### ${payload.title}\n\n${payload.body.replace(/\n/g, '\n\n')}${payload.url ? `\n\n[打开商品](${payload.url})` : ''}`,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`钉钉推送失败：HTTP ${response.status}`);
  }
  const data = await response.json().catch(() => ({}));
  if (data && data.errcode) {
    throw new Error(`钉钉推送失败：${data.errmsg || data.errcode}`);
  }
}
