// Dictate Anywhere — content script.
//
// Runs in every frame of every http(s) page. Responsibilities:
//   1. Show a floating status pill (listening / processing / done / error).
//   2. Inject the finished transcript into whatever field had focus.
//   3. Detect hotkey *release* so "hold to talk" works (chrome.commands only
//      fires on key-down, so the service worker owns start; this owns release).
//
// Start is triggered globally by the service worker (chrome.commands). This
// script never starts a session itself, which keeps the two paths from racing.

(() => {
  if (window.__dictateAnywhereLoaded) return; // guard double injection
  window.__dictateAnywhereLoaded = true;

  const PILL_ID = 'dictate-anywhere-pill';
  const PTT_HOLD_MS = 400; // shorter hold => treat as tap-to-toggle, ignore release
  const isTopFrame = window === window.top;

  let DEBUG = false;
  try {
    chrome.storage.local.get('debug').then((s) => { DEBUG = !!s.debug; }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.debug) DEBUG = !!changes.debug.newValue;
    });
  } catch (_) { /* storage may be unavailable very early */ }
  const log = (...a) => { if (DEBUG) console.log('[DictateAnywhere:cs]', ...a); };

  // session-local state
  let armed = false; // this frame owns the active dictation session
  let sessionStartedAt = 0;
  let stopSent = false;
  let targetEl = null;
  const pendingBySeq = new Map();
  let nextSeq = 0;

  // ---------------------------------------------------------------- focus utils
  function deepActiveElement(root = document) {
    let el = root.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const editableTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''];
      return editableTypes.includes(type) && !el.disabled && !el.readOnly;
    }
    return el.isContentEditable === true;
  }

  function frameOwnsFocus() {
    return document.hasFocus() && isEditable(deepActiveElement());
  }

  // ---------------------------------------------------------------- status pill
  let pillEl = null;
  let pillHideTimer = 0;

  function showPill(state, text) {
    if (!pillEl) {
      pillEl = document.createElement('div');
      pillEl.id = PILL_ID;
      pillEl.setAttribute('role', 'status');
      pillEl.setAttribute('aria-live', 'polite');
      (document.body || document.documentElement).appendChild(pillEl);
    }
    clearTimeout(pillHideTimer);
    pillEl.dataset.state = state;
    pillEl.textContent = text;
    pillEl.style.display = 'flex';
    if (state === 'done' || state === 'error' || state === 'idle') {
      const ms = state === 'error' ? 4500 : 1500;
      pillHideTimer = setTimeout(hidePill, ms);
    }
  }
  function hidePill() {
    if (pillEl) pillEl.style.display = 'none';
  }

  // ---------------------------------------------------------------- insertion
  function resolveTarget() {
    if (targetEl && targetEl.isConnected && isEditable(targetEl)) return targetEl;
    const active = deepActiveElement();
    return isEditable(active) ? active : null;
  }

  // Add a leading space when joining onto existing text mid-sentence.
  function needsLeadingSpace(before, text) {
    if (!before) return false;
    if (/\s$/.test(before)) return false;
    if (/^[\s.,!?;:)\]}'"’”]/.test(text)) return false;
    return true;
  }

  function insertIntoInput(el, text) {
    el.focus();
    const hasSelection = typeof el.selectionStart === 'number';
    const start = hasSelection ? el.selectionStart : el.value.length;
    const end = hasSelection ? el.selectionEnd : el.value.length;
    const before = el.value.slice(0, start);
    const payload = (needsLeadingSpace(before, text) ? ' ' : '') + text;

    // Native prototype setter so React / Vue change detection actually fires.
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, before + payload + el.value.slice(end));

    if (hasSelection) {
      const caret = start + payload.length;
      try { el.setSelectionRange(caret, caret); } catch (_) { /* number inputs */ }
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: payload,
    }));
  }

  // Google Docs renders the visible page on canvas; its focused element is a
  // hidden node that only exists to capture raw keystrokes for IME. Writing
  // into it via execCommand/Range (below) succeeds silently but never
  // reaches the real document. It does, however, run its own real paste
  // handler on that node — the same one Ctrl+V uses — so a synthetic
  // ClipboardEvent is the one thing that actually lands.
  function isGoogleDocsEditor() {
    return /(^|\.)docs\.google\.com$/.test(location.hostname) && /\/document\//.test(location.pathname);
  }

  function dispatchPasteEvent(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function insertIntoContentEditable(el, text) {
    el.focus();

    if (isGoogleDocsEditor() && dispatchPasteEvent(el, text)) return;

    const selection = window.getSelection();

    let before = '';
    if (selection && selection.rangeCount) {
      const probe = selection.getRangeAt(0).cloneRange();
      probe.collapse(true);
      try {
        probe.setStart(el, 0);
        before = probe.toString();
      } catch (_) { /* cross-boundary selection — skip the space heuristic */ }
    }
    const payload = (needsLeadingSpace(before, text) ? ' ' : '') + text;

    let handled = false;
    try {
      handled = document.execCommand('insertText', false, payload);
    } catch (_) {
      handled = false;
    }
    if (handled) return;

    // Range fallback for editors that reject execCommand.
    if (selection && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(payload);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      el.appendChild(document.createTextNode(payload));
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: payload,
    }));
  }

  function insertText(text) {
    const el = resolveTarget();
    if (!el) {
      showPill('error', '⚠ No text field focused');
      return;
    }
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') insertIntoInput(el, text);
      else insertIntoContentEditable(el, text);
      showPill('done', '✓ Inserted');
      if (armed) {
        // auto-chunk mode: fall back to the listening pill after the flash
        setTimeout(() => { if (armed) showPill('listening', '● Listening…'); }, 900);
      }
    } catch (e) {
      log('insert failed', e);
      showPill('error', '⚠ Could not insert text');
    }
  }

  function flushPending() {
    while (pendingBySeq.has(nextSeq)) {
      const text = pendingBySeq.get(nextSeq);
      pendingBySeq.delete(nextSeq);
      nextSeq += 1;
      if (text && text.trim()) insertText(text);
    }
  }

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'dictation-listening': {
        const owns = frameOwnsFocus();
        if (owns) {
          armed = true;
          stopSent = false;
          sessionStartedAt = Date.now();
          pendingBySeq.clear();
          nextSeq = 0;
          targetEl = deepActiveElement();
          showPill('listening', '● Listening…');
          log('armed — target', targetEl && targetEl.tagName);
        } else if (isTopFrame && !(document.activeElement instanceof HTMLIFrameElement)) {
          // No editable focus anywhere and the focus is not inside a subframe.
          showPill('error', '⚠ Focus a text field first');
        }
        break;
      }

      case 'dictation-processing':
        stopSent = true; // the session is already finalising; no more cs-stop
        if (armed) showPill('processing', '… Transcribing');
        break;

      case 'dictation-insert':
        if (!armed) break;
        if (typeof msg.seq === 'number') {
          pendingBySeq.set(msg.seq, msg.text || '');
          flushPending();
        } else {
          insertText(msg.text || '');
        }
        break;

      case 'dictation-done':
        if (armed) showPill('done', '✓ Done');
        armed = false;
        break;

      case 'dictation-idle':
        if (armed) hidePill();
        armed = false;
        break;

      case 'dictation-error':
        if (armed || isTopFrame) showPill('error', `⚠ ${msg.message || 'Dictation failed'}`);
        armed = false;
        break;

      default:
    }
  });

  // -------------------------------------------------- hotkey release (hold-to-talk)
  function onKeyUp(e) {
    if (!armed || stopSent) return;
    const releaseKey =
      e.code === 'Space' ||
      e.key === ' ' ||
      e.key === 'Control' ||
      e.key === 'Shift' ||
      /^(Control|Shift)(Left|Right)$/.test(e.code || '');
    if (!releaseKey) return;
    if (Date.now() - sessionStartedAt < PTT_HOLD_MS) return; // treat as tap-to-toggle
    stopSent = true;
    log('hotkey released — sending stop');
    chrome.runtime.sendMessage({ type: 'cs-stop' }).catch(() => {});
  }
  window.addEventListener('keyup', onKeyUp, true);

  // Keep the injection target fresh while idle.
  document.addEventListener('focusin', () => {
    if (armed) return;
    const active = deepActiveElement();
    if (isEditable(active)) targetEl = active;
  }, true);
})();
