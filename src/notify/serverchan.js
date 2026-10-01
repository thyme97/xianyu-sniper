// 通知渠道：Server 酱
// 配置支持完整推送 URL 或仅 SendKey

function normalizeServerChanUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Server 酱 SendKey 为空');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://sctapi.ftqq.com/${encodeURIComponent(value)}.send`;
}

export async function notify(payload, option) {
  const response = await fetch(normalizeServerChanUrl(option), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: `title=${encodeURIComponent(payload.title)}&desp=${encodeURIComponent(payload.body)}`,
  });
  if (!response.ok) {
    throw new Error(`Server 酱推送失败：HTTP ${response.status}`);
  }
}
