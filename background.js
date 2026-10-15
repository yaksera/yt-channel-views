importScripts('common.js');

// ---------- opening extension pages ----------

function openPage(page, params, tab) {
  const url = new URL(chrome.runtime.getURL(page));
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  chrome.tabs.create({ url: url.href, index: tab ? tab.index + 1 : undefined });
}

function openDashboard(sourceUrl, tab) {
  const base = chrome.runtime.getURL('');
  openPage('dashboard.html', sourceUrl && !sourceUrl.startsWith(base) ? { src: sourceUrl } : {}, tab);
}

chrome.action.onClicked.addListener((tab) => openDashboard(tab.url, tab));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'analyze-link',
    title: 'Analyze channel views',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
  });
  chrome.contextMenus.create({
    id: 'explore-keyword',
    title: 'Explore keyword "%s"',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'explore-keyword') openPage('keywords.html', { q: info.selectionText.trim() }, tab);
  else openDashboard(info.linkUrl || info.pageUrl, tab);
});

// ---------- API proxy for the content script (keeps the key out of the page, caches results) ----------

const cache = new Map();
const TTL = 10 * 60 * 1000;

async function cachedApi(endpoint, params) {
  const k = endpoint + JSON.stringify(params);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  const data = await YT.api(endpoint, params);
  cache.set(k, { t: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'api') {
    cachedApi(msg.endpoint, msg.params).then(
      (data) => sendResponse({ data }),
      (e) => sendResponse({ error: e.message, reason: e.reason, status: e.status }),
    );
    return true;
  }
  if (msg?.type === 'open' && ['dashboard.html', 'keywords.html'].includes(msg.page)) {
    openPage(msg.page, msg.params, sender.tab);
    sendResponse({ data: true });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey) cache.clear();
});
