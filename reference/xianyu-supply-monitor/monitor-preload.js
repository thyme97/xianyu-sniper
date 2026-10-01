'use strict';

const { ipcRenderer } = require('electron');

const SEARCH_API_MARKERS = [
  'mtop.taobao.idlemtopsearch',
  'idlemtopsearch',
  'pc.search',
];

function isSearchResponse(url) {
  return SEARCH_API_MARKERS.some((marker) => String(url || '').includes(marker));
}

function safeJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function sendPayload(payload, sourceUrl) {
  ipcRenderer.send('monitor:payload', {
    payload,
    sourceUrl,
    pageUrl: location.href,
    at: Date.now(),
  });
}

function patchFetch() {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (isSearchResponse(requestUrl || response.url)) {
        response.clone().text().then((text) => {
          const payload = safeJson(text);
          if (payload) sendPayload(payload, requestUrl || response.url);
        });
      }
    } catch (_) {}
    return response;
  };
}

function patchXhr() {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__xyMonitorUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener('load', function onLoad() {
      try {
        if (!isSearchResponse(this.__xyMonitorUrl || this.responseURL)) return;
        const text = typeof this.responseText === 'string' ? this.responseText : '';
        const payload = safeJson(text);
        if (payload) sendPayload(payload, this.__xyMonitorUrl || this.responseURL);
      } catch (_) {}
    });
    return originalSend.apply(this, args);
  };
}

function clickLatestSort() {
  const labels = ['最新', '最新发布', '新上架', '发布时间'];
  const nodes = [...document.querySelectorAll('button,a,span,div')];
  const target = nodes.find((node) => labels.includes(node.textContent?.trim()));
  if (target) target.click();
}

patchFetch();
patchXhr();

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(clickLatestSort, 1500);
});
