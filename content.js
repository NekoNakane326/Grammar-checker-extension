// Grammar Checker Extension - Content Script v1.1

const API_URL = 'https://api.languagetool.org/v2/check';
const DEBOUNCE_MS = 1200;
const MIN_TEXT_LENGTH = 10;

// Google Docs uses a canvas-based editor — detect it in the main frame only
const IS_GOOGLE_DOCS =
  window.location.hostname === 'docs.google.com' &&
  window.location.pathname.startsWith('/document/');

let isEnabled = true;
let activeTooltip = null;

// ── Google Docs state ─────────────────────────────────────────────────────────
let gdTimer = null;
let gdErrors = [];
let gdIgnored = new Set();
let gdBadge = null;

// ── Standard element state ────────────────────────────────────────────────────
let checkTimers = new WeakMap();
let errorMap = new WeakMap();
let ignoredErrors = new WeakMap();

// ─── Bootstrap ────────────────────────────────────────────────────────────────

chrome.storage.sync.get(['gcEnabled'], (result) => {
  isEnabled = result.gcEnabled !== false;
  if (isEnabled) init();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'GC_TOGGLE') return;
  isEnabled = msg.enabled;
  if (!isEnabled) {
    clearAllBadges();
    closeTooltip();
  } else {
    init();
  }
});

function init() {
  if (IS_GOOGLE_DOCS) {
    attachGoogleDocsListener();
  } else {
    attachAllListeners();
  }
}

// ─── Google Docs handling ─────────────────────────────────────────────────────
// Google Docs renders text in .kix-lineview elements via its own engine.
// Standard `input` events never fire. We watch for DOM mutations on the
// editor container instead, which reliably fires after every keystroke.

function attachGoogleDocsListener() {
  if (window._gcGDocsAttached) return;

  // Poll until the Docs editor mounts
  const poll = setInterval(() => {
    const editor = document.querySelector('.kix-appview');
    if (!editor) return;
    clearInterval(poll);
    window._gcGDocsAttached = true;

    // MutationObserver catches every text change Docs makes to the DOM
    const obs = new MutationObserver(() => scheduleGoogleDocsCheck());
    obs.observe(editor, { childList: true, subtree: true, characterData: true });

    // keyup as a secondary trigger (handles cases where mutation fires late)
    document.addEventListener('keyup', (e) => {
      if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') {
        scheduleGoogleDocsCheck();
      }
    });
  }, 400);
}

function scheduleGoogleDocsCheck() {
  if (!isEnabled) return;
  clearTimeout(gdTimer);
  gdTimer = setTimeout(runGoogleDocsCheck, DEBOUNCE_MS);
}

function getGoogleDocsText() {
  // .kix-lineview holds each rendered paragraph
  const lines = document.querySelectorAll('.kix-lineview');
  if (!lines.length) return '';
  return Array.from(lines)
    .map(l => (l.innerText || l.textContent || '').replace(/\n$/, ''))
    .join('\n')
    .trim();
}

async function runGoogleDocsCheck() {
  if (!isEnabled) return;
  const text = getGoogleDocsText();
  if (!text || text.trim().length < MIN_TEXT_LENGTH) {
    removeGoogleDocsBadge();
    return;
  }

  try {
    const errors = await fetchGrammarErrors(text);
    gdErrors = errors.filter(e => !gdIgnored.has(`${e.offset}:${e.length}`));
    showGoogleDocsBadge(gdErrors.length);
  } catch {
    // Silently fail — never interrupt typing
  }
}

function showGoogleDocsBadge(count) {
  removeGoogleDocsBadge();

  const badge = document.createElement('div');
  badge.className = 'gc-badge' + (count === 0 ? ' gc-no-errors' : '');
  // Fixed to bottom-right so it doesn't overlap the document
  badge.style.cssText = 'position:fixed;bottom:28px;right:28px;font-size:13px;padding:7px 14px;border-radius:20px;';
  badge.textContent = count === 0 ? '✓ No errors' : `✏️ ${count} issue${count !== 1 ? 's' : ''}`;
  badge.title = count === 0 ? 'Grammar looks good!' : `${count} grammar issue${count !== 1 ? 's' : ''} — click to review`;
  document.body.appendChild(badge);
  gdBadge = badge;

  if (count > 0) {
    badge.addEventListener('click', (e) => { e.stopPropagation(); showGoogleDocsPanel(); });
  } else {
    setTimeout(removeGoogleDocsBadge, 3000);
  }
}

function removeGoogleDocsBadge() {
  if (gdBadge) { gdBadge.remove(); gdBadge = null; }
}

function showGoogleDocsPanel() {
  closeTooltip();
  if (!gdErrors.length) return;

  const panel = document.createElement('div');
  panel.id = 'gc-tooltip';
  // Anchor panel just above the badge
  panel.style.cssText = 'position:fixed;bottom:76px;right:28px;max-height:60vh;overflow-y:auto;';

  const header = document.createElement('div');
  header.className = 'gc-tooltip-header';
  header.innerHTML = `<span class="gc-icon">✏️</span> ${gdErrors.length} grammar issue${gdErrors.length !== 1 ? 's' : ''}`;
  panel.appendChild(header);

  const text = getGoogleDocsText();

  gdErrors.forEach((err, idx) => {
    const item = document.createElement('div');
    item.style.cssText = idx < gdErrors.length - 1
      ? 'border-bottom:1px solid #2d3748;padding-bottom:8px;margin-bottom:4px;'
      : '';

    const msg = document.createElement('div');
    msg.className = 'gc-tooltip-message';
    msg.textContent = err.message;
    item.appendChild(msg);

    const wrongText = text.substring(err.offset, err.offset + err.length);
    if (wrongText) {
      const orig = document.createElement('div');
      orig.className = 'gc-tooltip-original';
      orig.innerHTML = `"<strong>${escapeHtml(wrongText)}</strong>"`;
      item.appendChild(orig);
    }

    if (err.replacements.length > 0) {
      const sugLabel = document.createElement('div');
      sugLabel.style.cssText = 'padding:0 12px 4px;color:#a0aec0;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;';
      sugLabel.textContent = 'Click to apply:';
      item.appendChild(sugLabel);

      const sugs = document.createElement('div');
      sugs.className = 'gc-tooltip-suggestions';
      err.replacements.forEach(rep => {
        const btn = document.createElement('button');
        btn.className = 'gc-suggestion-btn';
        btn.textContent = rep;
        btn.title = `Apply fix: "${rep}"`;
        btn.addEventListener('click', async () => {
          const applied = await applyGoogleDocsReplacement(text, err.offset, err.length, rep);
          if (applied) {
            gdIgnored.add(`${err.offset}:${err.length}`);
            gdErrors = gdErrors.filter(e => `${e.offset}:${e.length}` !== `${err.offset}:${err.length}`);
            closeTooltip();
            showGoogleDocsBadge(gdErrors.length);
          }
        });
        sugs.appendChild(btn);
      });
      item.appendChild(sugs);
    }

    const footer = document.createElement('div');
    footer.className = 'gc-tooltip-footer';
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'gc-dismiss-btn';
    dismissBtn.textContent = 'Dismiss this issue';
    dismissBtn.addEventListener('click', () => {
      gdIgnored.add(`${err.offset}:${err.length}`);
      gdErrors = gdErrors.filter(e => `${e.offset}:${e.length}` !== `${err.offset}:${err.length}`);
      closeTooltip();
      showGoogleDocsBadge(gdErrors.length);
    });
    footer.appendChild(dismissBtn);
    item.appendChild(footer);
    panel.appendChild(item);
  });

  const closeRow = document.createElement('div');
  closeRow.style.cssText = 'padding:8px 12px;text-align:right;border-top:1px solid #2d3748;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close';
  closeBtn.style.cssText = 'background:#2d3748;border:none;color:#a0aec0;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;';
  closeBtn.addEventListener('click', closeTooltip);
  closeRow.appendChild(closeBtn);
  panel.appendChild(closeRow);

  document.body.appendChild(panel);
  activeTooltip = panel;

  setTimeout(() => {
    document.addEventListener('mousedown', handleOutsideClick, { once: true });
  }, 50);
}

// ─── Google Docs replacement ──────────────────────────────────────────────────
// Uses window.find() to locate + select the error text, then tries execCommand.
// Falls back to clipboard + toast so the user can Ctrl+V it in one keystroke.

async function applyGoogleDocsReplacement(fullText, offset, length, replacement) {
  const errorText = fullText.substring(offset, offset + length);
  if (!errorText) return false;

  // 1. Scroll to and select the error text using the browser's built-in find
  //    window.find(text, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames)
  const found = window.find(errorText, true, false, true, false, false, false);

  if (found) {
    // 2. Try execCommand('insertText') — works when the selection lands inside
    //    an editable context (Google Docs sometimes allows this)
    const applied = document.execCommand('insertText', false, replacement);
    if (applied) return true;
  }

  // 3. Fallback: copy to clipboard so user can paste with one keystroke
  await gcCopyToClipboard(replacement);
  const msg = found
    ? `"${replacement}" copied — press Ctrl+V (text is already selected)`
    : `"${replacement}" copied to clipboard — select the error text and press Ctrl+V`;
  showGDocsToast(msg, 5000);
  return false; // keep panel open so user can see which error this was
}

async function gcCopyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for when clipboard API is blocked
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
  }
}

function showGDocsToast(message, duration = 3000) {
  const existing = document.getElementById('gc-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'gc-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:76px', 'right:28px',
    'background:#2d3748', 'color:#e2e8f0',
    'padding:10px 16px', 'border-radius:8px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'font-size:13px', 'z-index:2147483647',
    'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
    'max-width:300px', 'line-height:1.5',
    'animation:gc-slide-in 0.15s ease-out',
    'border-left:3px solid #4299e1',
  ].join(';');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── Standard input handling ──────────────────────────────────────────────────

function getInputs() {
  return [
    ...document.querySelectorAll('textarea, input[type="text"], input[type="search"], input:not([type])'),
    ...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]'),
  ];
}

function attachAllListeners() {
  getInputs().forEach(attachListener);
  observeNewInputs();
}

function attachListener(el) {
  if (el._gcAttached) return;
  el._gcAttached = true;
  el.addEventListener('input', () => scheduleCheck(el));
  el.addEventListener('keyup', () => scheduleCheck(el)); // catches sites that swallow 'input'
  el.addEventListener('focus', () => { if (isEnabled) scheduleCheck(el); });
  el.addEventListener('blur', () => clearTimer(el));
}

function scheduleCheck(el) {
  if (!isEnabled) return;
  clearTimer(el);
  const timer = setTimeout(() => checkElement(el), DEBOUNCE_MS);
  checkTimers.set(el, timer);
}

function clearTimer(el) {
  const t = checkTimers.get(el);
  if (t) clearTimeout(t);
}

// ─── Grammar check ────────────────────────────────────────────────────────────

async function checkElement(el) {
  if (!isEnabled) return;
  const text = getElementText(el);
  if (!text || text.trim().length < MIN_TEXT_LENGTH) {
    removeBadge(el);
    return;
  }

  try {
    const errors = await fetchGrammarErrors(text);
    const ignored = ignoredErrors.get(el) || new Set();
    const active = errors.filter(e => !ignored.has(`${e.offset}:${e.length}`));
    errorMap.set(el, active);
    showBadge(el, active.length);
  } catch {
    // Silently fail
  }
}

async function fetchGrammarErrors(text) {
  const body = new URLSearchParams({ text, language: 'en-US', enabledOnly: 'false' });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('API error');
  const data = await res.json();
  return (data.matches || []).map(m => ({
    offset: m.offset,
    length: m.length,
    message: m.message,
    replacements: (m.replacements || []).slice(0, 4).map(r => r.value),
    ruleId: m.rule?.id || '',
    category: m.rule?.category?.name || 'Grammar',
  }));
}

function getElementText(el) {
  if (el.isContentEditable) return el.innerText || el.textContent || '';
  return el.value || '';
}

// ─── Badge (standard inputs) ──────────────────────────────────────────────────

const badgeMap = new WeakMap();

function showBadge(el, count) {
  removeBadge(el);

  const badge = document.createElement('div');
  badge.className = 'gc-badge' + (count === 0 ? ' gc-no-errors' : '');
  badge.textContent = count === 0 ? '✓' : `${count} error${count !== 1 ? 's' : ''}`;
  badge.title = count === 0 ? 'No grammar errors' : `${count} grammar issue${count !== 1 ? 's' : ''} — click to review`;

  positionBadge(badge, el);
  document.body.appendChild(badge);
  badgeMap.set(el, badge);

  const updatePos = () => positionBadge(badge, el);
  window.addEventListener('scroll', updatePos, { passive: true });
  window.addEventListener('resize', updatePos, { passive: true });
  badge._removeListeners = () => {
    window.removeEventListener('scroll', updatePos);
    window.removeEventListener('resize', updatePos);
  };

  if (count > 0) {
    badge.addEventListener('click', (e) => { e.stopPropagation(); showErrorPanel(el); });
  } else {
    setTimeout(() => removeBadge(el), 3000);
  }
}

function positionBadge(badge, el) {
  const rect = el.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  badge.style.top = `${rect.top + scrollY - 14}px`;
  badge.style.left = `${rect.right + scrollX - (badge.offsetWidth || 70) - 6}px`;
  if (rect.top < 20) badge.style.top = `${rect.bottom + scrollY + 2}px`;
}

function removeBadge(el) {
  const badge = badgeMap.get(el);
  if (badge) { badge._removeListeners?.(); badge.remove(); badgeMap.delete(el); }
}

function clearAllBadges() {
  document.querySelectorAll('.gc-badge').forEach(b => b.remove());
  removeGoogleDocsBadge();
  closeTooltip();
}

// ─── Error panel (standard inputs) ───────────────────────────────────────────

function showErrorPanel(el) {
  closeTooltip();
  const errors = errorMap.get(el) || [];
  if (!errors.length) return;

  const text = getElementText(el);
  const panel = document.createElement('div');
  panel.id = 'gc-tooltip';

  const header = document.createElement('div');
  header.className = 'gc-tooltip-header';
  header.innerHTML = `<span class="gc-icon">✏️</span> ${errors.length} grammar issue${errors.length !== 1 ? 's' : ''}`;
  panel.appendChild(header);

  errors.forEach((err, idx) => {
    const item = document.createElement('div');
    item.style.cssText = idx < errors.length - 1
      ? 'border-bottom:1px solid #2d3748;padding-bottom:8px;margin-bottom:4px;'
      : '';

    const msg = document.createElement('div');
    msg.className = 'gc-tooltip-message';
    msg.textContent = err.message;
    item.appendChild(msg);

    const wrongText = text.substring(err.offset, err.offset + err.length);
    if (wrongText) {
      const orig = document.createElement('div');
      orig.className = 'gc-tooltip-original';
      orig.innerHTML = `"<strong>${escapeHtml(wrongText)}</strong>"`;
      item.appendChild(orig);
    }

    if (err.replacements.length > 0) {
      const sugLabel = document.createElement('div');
      sugLabel.style.cssText = 'padding:0 12px 4px;color:#a0aec0;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;';
      sugLabel.textContent = 'Suggestions:';
      item.appendChild(sugLabel);

      const sugs = document.createElement('div');
      sugs.className = 'gc-tooltip-suggestions';
      err.replacements.forEach(rep => {
        const btn = document.createElement('button');
        btn.className = 'gc-suggestion-btn';
        btn.textContent = rep;
        btn.title = `Replace with: ${rep}`;
        btn.addEventListener('click', () => {
          applyReplacement(el, err.offset, err.length, rep);
          closeTooltip();
          removeBadge(el);
          scheduleCheck(el);
        });
        sugs.appendChild(btn);
      });
      item.appendChild(sugs);
    }

    const footer = document.createElement('div');
    footer.className = 'gc-tooltip-footer';
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'gc-dismiss-btn';
    dismissBtn.textContent = 'Dismiss this issue';
    dismissBtn.addEventListener('click', () => {
      const key = `${err.offset}:${err.length}`;
      if (!ignoredErrors.has(el)) ignoredErrors.set(el, new Set());
      ignoredErrors.get(el).add(key);
      const errs = (errorMap.get(el) || []).filter(e => `${e.offset}:${e.length}` !== key);
      errorMap.set(el, errs);
      closeTooltip();
      showBadge(el, errs.length);
    });
    footer.appendChild(dismissBtn);
    item.appendChild(footer);
    panel.appendChild(item);
  });

  const closeRow = document.createElement('div');
  closeRow.style.cssText = 'padding:8px 12px;text-align:right;border-top:1px solid #2d3748;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close';
  closeBtn.style.cssText = 'background:#2d3748;border:none;color:#a0aec0;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;';
  closeBtn.addEventListener('click', closeTooltip);
  closeRow.appendChild(closeBtn);
  panel.appendChild(closeRow);

  document.body.appendChild(panel);
  activeTooltip = panel;

  const rect = el.getBoundingClientRect();
  const panelH = panel.offsetHeight;
  const panelW = panel.offsetWidth;
  const spaceBelow = window.innerHeight - rect.bottom;
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;

  let top = rect.bottom + scrollY + 6;
  if (spaceBelow < panelH + 10) top = rect.top + scrollY - panelH - 6;
  let left = rect.left + scrollX;
  if (left + panelW > window.innerWidth + scrollX - 10) left = window.innerWidth + scrollX - panelW - 10;

  panel.style.top = `${Math.max(scrollY + 4, top)}px`;
  panel.style.left = `${Math.max(4, left)}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', handleOutsideClick, { once: true });
  }, 50);
}

// ─── Shared tooltip helpers ───────────────────────────────────────────────────

function handleOutsideClick(e) {
  if (activeTooltip && !activeTooltip.contains(e.target)) closeTooltip();
}

function closeTooltip() {
  if (activeTooltip) { activeTooltip.remove(); activeTooltip = null; }
  document.removeEventListener('mousedown', handleOutsideClick);
}

// ─── Apply replacement (standard inputs only) ─────────────────────────────────

function applyReplacement(el, offset, length, replacement) {
  if (el.isContentEditable) {
    const text = el.innerText || el.textContent || '';
    el.innerText = text.substring(0, offset) + replacement + text.substring(offset + length);
    const range = document.createRange();
    const sel = window.getSelection();
    const node = el.childNodes[0];
    if (node) {
      try {
        const pos = Math.min(offset + replacement.length, node.length);
        range.setStart(node, pos);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    }
  } else {
    const val = el.value || '';
    el.value = val.substring(0, offset) + replacement + val.substring(offset + length);
    const pos = offset + replacement.length;
    el.setSelectionRange(pos, pos);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── MutationObserver for dynamic inputs ─────────────────────────────────────

let observerAttached = false;

function observeNewInputs() {
  if (observerAttached) return;
  observerAttached = true;
  const observer = new MutationObserver((mutations) => {
    if (!isEnabled) return;
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        const sel = 'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"], [contenteditable=""]';
        const candidates = [
          ...(node.matches?.(sel) ? [node] : []),
          ...(node.querySelectorAll?.(sel) || []),
        ];
        candidates.forEach(attachListener);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

if (isEnabled) init();
