// AI 层：OpenAI 兼容 Chat Completions 复筛，输出严格 JSON {match, reason}
// 可全局（config.ai.enabled）+ 按任务（watch_item.ai_enabled）双重开关；关闭时走规则直通

// 是否需要对该任务走 AI 复筛
export function aiEnabledFor(watchItem, aiConfig) {
  return Boolean(aiConfig?.enabled && watchItem.ai_enabled);
}

// 调用 AI 判定；失败时抛错，由调用方决定降级策略（放行+告警 / 严格模式丢弃）
export async function aiCheck(listing, aiConfig) {
  const baseUrl = String(aiConfig.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !aiConfig.apiKey || !aiConfig.model) {
    throw new Error('AI 配置不完整（baseUrl/apiKey/model）');
  }

  const systemPrompt =
    '你是闲鱼商品筛选助手。判断商品是否为用户关键词所指的完整正品：排除配件、空壳、引流、租借、描述不清的商品。' +
    '只输出严格 JSON：{"match": true|false, "reason": "简短中文理由"}，不要输出其他内容。';

  const userContent = [
    `标题：${listing.title || '（无）'}`,
    `描述：${listing.descr || '（无）'}`,
    `价格：${listing.price || '（未知）'}`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AI 接口返回 ${response.status}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
    const verdict = JSON.parse(jsonText);
    return { match: Boolean(verdict.match), reason: String(verdict.reason || '') };
  } finally {
    clearTimeout(timer);
  }
}
