'use strict';

/**
 * ChromeMD - Background Service Worker
 *
 * Handles directory listing requests from content scripts.
 *
 * Chrome does not return directory listing HTML via fetch/XHR from content
 * scripts because:
 *   1. Since Chrome 83, each file:// URL has a unique (opaque) null origin,
 *      so cross-file:// XHR requests are blocked.
 *   2. Chrome only generates directory listing HTML for real browser
 *      navigations, never for fetch/XHR.
 *
 * Solution: open the directory URL as a real (inactive) browser navigation,
 * extract the <a href> links via chrome.scripting.executeScript, close the
 * temporary tab, and return the href list to the content script.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getDirectoryListing') {
    getDirectoryListing(msg.url)
      .then(hrefs => sendResponse({ hrefs }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === 'openInNewWindow') {
    chrome.windows.create({ url: msg.url, type: 'popup' });
  }
});

const DIRECTORY_LOAD_TIMEOUT_MS = 10000;

async function getDirectoryListing(dirUrl) {
  // Open the directory as an inactive background tab so Chrome generates
  // the directory listing HTML through its normal navigation path.
  const tab = await chrome.tabs.create({ url: dirUrl, active: false });

  // If the tab is already complete (can happen for fast file:// loads),
  // extract immediately; otherwise wait for the 'complete' status event.
  if (tab.status === 'complete') {
    return extractAndCleanup(tab.id);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      try { await chrome.tabs.remove(tab.id); } catch (_) { /* ignore */ }
      reject(new Error('timeout waiting for directory tab'));
    }, DIRECTORY_LOAD_TIMEOUT_MS);

    async function onUpdated(tabId, changeInfo) {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      try {
        resolve(await extractAndCleanup(tab.id));
      } catch (err) {
        reject(err);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function extractAndCleanup(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Array.from(
        document.querySelectorAll('a[href]'),
        a => a.getAttribute('href')
      )
    });
    return results[0]?.result ?? [];
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (_) { /* ignore */ }
  }
}
