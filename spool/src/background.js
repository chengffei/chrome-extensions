// Spool service worker: enables the toolbar icon on bilibili video pages
// and toggles the panel there. It makes no network requests.
'use strict';

const FILES = ['vendor/mediabunny.min.js', 'src/core.js', 'src/mux.js', 'src/panel-css.js', 'src/content.js'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostEquals: 'www.bilibili.com', pathPrefix: '/video/', schemes: ['https'] },
      })],
      actions: [new chrome.declarativeContent.ShowAction()],
    }]);
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'spool:toggle' });
  } catch (_) {
    // The tab was open before Spool was installed, or reached the video
    // through in-page navigation: inject now (allowed by activeTab).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'spool:toggle' });
  }
});
