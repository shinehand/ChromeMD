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

const HANDLE_DB_NAME = 'chromemd-file-handles';
const HANDLE_STORE_NAME = 'handles';
const NATIVE_HOST_NAME = 'com.chromemd.native_host';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getDirectoryListing') {
    getDirectoryListing(msg.url)
      .then(hrefs => sendResponse({ hrefs }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === 'openInNewWindow') {
    if (typeof msg.url === 'string' && msg.url.startsWith('file://')) {
      chrome.windows.create({ url: msg.url, type: 'popup' });
    }
  }
  if (msg.type === 'autoPopup') {
    if (typeof msg.url !== 'string' || !msg.url.startsWith('file://')) {
      sendResponse({ alreadyPopup: true }); // treat invalid URL as no-op
      return false;
    }
    chrome.windows.get(sender.tab.windowId, (win) => {
      if (chrome.runtime.lastError || !win) {
        sendResponse({ alreadyPopup: true }); // can't determine type; proceed normally
        return;
      }
      if (win.type === 'popup') {
        sendResponse({ alreadyPopup: true });
      } else {
        chrome.windows.create({ url: msg.url, type: 'popup' });
        chrome.tabs.remove(sender.tab.id);
        sendResponse({ alreadyPopup: false });
      }
    });
    return true; // keep the message channel open for the async response
  }
  if (msg.type === 'getStoredFileHandle') {
    getStoredFileHandle(msg.key)
      .then(handle => sendResponse({ handle }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'setStoredFileHandle') {
    setStoredFileHandle(msg.key, msg.handle)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'clearStoredFileHandle') {
    clearStoredFileHandle(msg.key)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'nativeHostRequest') {
    sendNativeHostMessage(msg.payload)
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

const DIRECTORY_LOAD_TIMEOUT_MS = 10000;

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredFileHandle(key) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const store = tx.objectStore(HANDLE_STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function setStoredFileHandle(key, handle) {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(HANDLE_STORE_NAME);
    store.put(handle, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

async function clearStoredFileHandle(key) {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(HANDLE_STORE_NAME);
    store.delete(key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

async function sendNativeHostMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('native host returned no response'));
        return;
      }
      if (response.ok === false) {
        reject(new Error(response.error || 'native host request failed'));
        return;
      }
      resolve(response);
    });
  });
}

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
