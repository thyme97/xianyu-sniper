// 通知渠道：Telegram Bot
// 配置格式：botToken#chatId，或完整 sendMessage URL（需含 chat_id 参数）

function parseTelegramTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Telegram 推送配置为空');

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const chatId = url.searchParams.get('chat_id');
    if (!chatId) throw new Error('Telegram 完整 URL 需要包含 chat_id 参数');
    return { url: `${url.origin}${url.pathname}`, chatId };
  }

  const [token, chatId] = value.split(/[|#，,\s]+/).map((item) => item.trim()).filter(Boolean);
  if (!token || !chatId) throw new Error('Telegram 配置格式应为 botToken#chatId，或完整 sendMessage URL');

  return { url: `https://api.telegram.org/bot${token}/sendMessage`, chatId };
}

export async function notify(payload, option) {
  const target = parseTelegramTarget(option);
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      chat_id: target.chatId,
      text: `${payload.title}\n\n${payload.body}`,
      disable_web_page_preview: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram 推送失败：HTTP ${response.status}`);
  }
}
