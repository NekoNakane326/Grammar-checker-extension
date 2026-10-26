const toggle = document.getElementById('mainToggle');
const statusRow = document.getElementById('statusRow');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const toggleDesc = document.getElementById('toggle-desc');

// Load saved state
chrome.storage.sync.get(['gcEnabled'], (result) => {
  const enabled = result.gcEnabled !== false;
  toggle.checked = enabled;
  updateUI(enabled);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.sync.set({ gcEnabled: enabled });

  // Notify all tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GC_TOGGLE', enabled }).catch(() => {});
    });
  });

  updateUI(enabled);
});

function updateUI(enabled) {
  if (enabled) {
    statusRow.classList.remove('disabled');
    statusText.textContent = 'Active — checking as you type';
    statusDot.style.animation = 'pulse-green 2s infinite';
    toggleDesc.textContent = 'Checking all text inputs';
  } else {
    statusRow.classList.add('disabled');
    statusText.textContent = 'Paused — click to re-enable';
    statusDot.style.animation = 'none';
    toggleDesc.textContent = 'Click the toggle to resume';
  }
}
