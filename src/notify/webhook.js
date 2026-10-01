// 通知渠道：通用 Webhook（POST JSON）

export async function notify(payload, option) {
  const url = String(option || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('通用 Webhook 需要填写完整 http/https URL');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Webhook 推送失败：HTTP ${response.status}`);
  }
}
