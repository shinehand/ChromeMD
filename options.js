'use strict';

const checkbox = document.getElementById('autoPopup');
const status   = document.getElementById('status');

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
