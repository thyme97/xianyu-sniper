'use strict';

const SEARCH_URL = 'https://www.goofish.com/search';

function keywordsFrom(text) {
  return String(text || '')
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function searchUrl(keyword) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', keyword);
  return url.toString();
}

function walk(value, visit, path = []) {
  if (!value || typeof value !== 'object') return;
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, visit, path.concat(index)));
    return;
  }
  Object.keys(value).forEach((key) => walk(value[key], visit, path.concat(key)));
}

function findFirstString(obj, keyMatcher) {
  let found = '';
  walk(obj, (node) => {
    if (found || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && keyMatcher(key) && value.trim()) {
        found = value.trim();
        return;
      }
    }
  });
  return found;
}

function findFirstNumberLike(obj, keyMatcher) {
  let found = '';
  walk(obj, (node) => {
    if (found || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (!keyMatcher(key)) continue;
      if (typeof value === 'string' && value.trim()) {
        found = value.trim();
        return;
      }
      if (typeof value === 'number') {
        found = String(value);
        return;
      }
    }
  });
  return found;
}

function flattenText(obj) {
  const parts = [];
  walk(obj, (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        const clean = value.replace(/\s+/g, ' ').trim();
        if (clean && clean.length <= 140) parts.push(clean);
      }
    }
  });
  return [...new Set(parts)];
}

function normalizeListing(raw, keyword) {
  const id =
    findFirstNumberLike(raw, (key) => /^(itemId|item_id|itemID|id|item_id_str|itemid)$/i.test(key)) ||
    findFirstNumberLike(raw?.clickParam?.args || raw?.clickParam || {}, (key) => /^(id|itemId)$/i.test(key));

  if (!id || String(id).length < 5) return null;

  const allTexts = flattenText(raw);
  const title =
    findFirstString(raw, (key) => /^(title|name|itemTitle|subject|desc|description)$/i.test(key)) ||
    allTexts.find((text) => keyword && text.includes(keyword)) ||
    allTexts.find((text) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(text)) ||
    '闲鱼新货源';

  const price = findFirstNumberLike(raw, (key) => /price|soldPrice|currentPrice|amount/i.test(key));
  const area = findFirstString(raw, (key) => /area|location|city|district|place/i.test(key));
  const image = findFirstString(raw, (key) => /pic|image|img|cover/i.test(key));
  const url = `https://www.goofish.com/item?id=${encodeURIComponent(id)}`;

  return {
    id: String(id),
    keyword,
    title: title.replace(/\s+/g, ' ').slice(0, 120),
    price: price ? String(price).replace(/\s+/g, ' ').slice(0, 40) : '',
    area: area ? area.replace(/\s+/g, ' ').slice(0, 40) : '',
    image,
    url,
  };
}

function extractListings(payload, keyword) {
  const arrays = [];
  walk(payload, (node, path) => {
    if (!Array.isArray(node) || node.length === 0) return;
    const last = String(path[path.length - 1] || '');
    if (/result|item|list|data|card/i.test(last) || node.some((entry) => entry && typeof entry === 'object')) {
      arrays.push(node);
    }
  });

  const seen = new Set();
  const listings = [];
  for (const arr of arrays) {
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const candidates = [entry, entry.data, entry.item, entry.cardData].filter(Boolean);
      for (const candidate of candidates) {
        const listing = normalizeListing(candidate, keyword);
        if (!listing || seen.has(listing.id)) continue;
        seen.add(listing.id);
        listings.push(listing);
      }
    }
  }
  return listings;
}

module.exports = {
  extractListings,
  keywordsFrom,
  searchUrl,
};
