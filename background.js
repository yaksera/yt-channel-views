// Opens the dashboard for the channel behind the current tab (or a right-clicked link).

function openDashboard(sourceUrl, tab) {
  let url = chrome.runtime.getURL('dashboard.html');
  if (sourceUrl && !sourceUrl.startsWith(url)) url += '?src=' + encodeURIComponent(sourceUrl);
  chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
}

chrome.action.onClicked.addListener((tab) => openDashboard(tab.url, tab));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'analyze-link',
    title: 'Analyze channel views',
    contexts: ['link', 'page'],
    documentUrlPatterns: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openDashboard(info.linkUrl || info.pageUrl, tab);
});
