// 规则层筛选：目标价/价格区间/包含词/排除词/地区过滤
// 去重在调度层基于 item 表完成，本模块只做纯规则判断
// 词匹配统一忽略大小写，且标题与描述都参与匹配

// 拆分词表：支持逗号/中文逗号/竖线/换行分隔
export function splitWords(value) {
  return String(value || '')
    .split(/[,，|\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 大小写不敏感的包含判断
function containsIgnoreCase(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// 判断商品是否通过某个监控任务的规则；返回 { pass, reason }
export function passesRule(listing, watchItem) {
  const price = listing.priceValue ?? null;
  // 标题 + 描述拼接后一起参与词匹配（很多卖家把配置写在描述里，且接口标题常被截断）
  const text = `${listing.title || ''} ${listing.descr || ''}`;
  const area = String(listing.area || '');

  // 目标价：蹲好价核心，价格未知或高于目标价都不过
  if (watchItem.target_price != null) {
    if (price == null) return { pass: false, reason: '价格无法解析，无法比对目标价' };
    if (price > watchItem.target_price) return { pass: false, reason: `价格 ${price} 高于目标价 ${watchItem.target_price}` };
  }

  if (watchItem.min_price != null) {
    if (price == null || price < watchItem.min_price) return { pass: false, reason: `价格 ${price ?? '?'} 低于下限 ${watchItem.min_price}（疑似引流）` };
  }

  if (watchItem.max_price != null) {
    if (price == null || price > watchItem.max_price) return { pass: false, reason: `价格 ${price ?? '?'} 超出上限 ${watchItem.max_price}` };
  }

  const includeWords = splitWords(watchItem.include_words);
  if (includeWords.length && !includeWords.some((word) => containsIgnoreCase(text, word))) {
    return { pass: false, reason: `标题/描述未命中包含词（${includeWords.join('、')}）` };
  }

  const excludeWords = splitWords(watchItem.exclude_words);
  const hitExclude = excludeWords.find((word) => containsIgnoreCase(text, word));
  if (hitExclude) {
    return { pass: false, reason: `命中排除词「${hitExclude}」` };
  }

  const areaInclude = splitWords(watchItem.area_include);
  if (areaInclude.length && !areaInclude.some((word) => containsIgnoreCase(area, word))) {
    return { pass: false, reason: `地区「${area || '未知'}」未命中包含地区（${areaInclude.join('、')}）` };
  }

  const areaExclude = splitWords(watchItem.area_exclude);
  const hitAreaExclude = areaExclude.find((word) => containsIgnoreCase(area, word));
  if (hitAreaExclude) {
    return { pass: false, reason: `地区命中排除「${hitAreaExclude}」` };
  }

  return { pass: true, reason: '满足全部规则' };
}
