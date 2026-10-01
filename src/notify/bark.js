// 通知渠道：Bark（iOS 推送）
// 配置支持完整地址或仅 AppKey

function normalizeBarkUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Bark 推送地址为空');
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return `https://api.day.app/${encodeURIComponent(value)}`;
}

export async function notify(payload, option) {
  const base = normalizeBarkUrl(option);
  const params = new URLSearchParams();
  if (payload.url) params.set('url', payload.url);
  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(
    `${base}/${encodeURIComponent(payload.title)}/${encodeURIComponent(payload.body)}${query}`
  );
  if (!response.ok) {
    throw new Error(`Bark 推送失败：HTTP ${response.status}`);
  }
}
