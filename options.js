'use strict';

const checkbox = document.getElementById('autoPopup');
const status   = document.getElementById('status');
const extensionId = document.getElementById('extensionId');
const nativeStatus = document.getElementById('nativeStatus');
const btnCheckNative = document.getElementById('btnCheckNative');

extensionId.textContent = chrome.runtime.id;

// Load saved setting
chrome.storage.sync.get({ autoPopup: false }, ({ autoPopup }) => {
  checkbox.checked = autoPopup;
});

// Save on change
checkbox.addEventListener('change', () => {
  chrome.storage.sync.set({ autoPopup: checkbox.checked }, () => {
    status.textContent = '설정이 저장되었습니다.';
    status.className = 'saved';
    setTimeout(() => { status.textContent = ''; status.className = ''; }, 2000);
  });
});

async function refreshNativeStatus() {
  nativeStatus.textContent = '확인 중…';

  chrome.runtime.sendMessage({
    type: 'nativeHostRequest',
    payload: { type: 'status' }
  }, (response) => {
    if (chrome.runtime.lastError) {
      nativeStatus.textContent = '미설치 또는 연결 실패';
      return;
    }
    if (!response || response.error) {
      nativeStatus.textContent = '미설치 또는 연결 실패';
      return;
    }

    const result = response.result || {};
    nativeStatus.textContent = result.ok
      ? `연결됨 (${result.host || 'native host'})`
      : '미설치 또는 연결 실패';
  });
}

btnCheckNative.addEventListener('click', refreshNativeStatus);
refreshNativeStatus();
