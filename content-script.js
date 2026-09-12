// Dictate Anywhere — content script.
//
// Deliberately small. It does NOT touch the page's DOM to insert text —
// every site's editor (plain inputs, React-controlled fields, Gmail's
// contenteditable, Google Docs' canvas-rendered fake-DOM, ...) has its own
// quirks, and chasing each one individually is an unbounded maintenance
// problem. Instead: the transcript goes on the system clipboard, the page
// shows a "Copied — press Ctrl+V" pill, and the user pastes it themselves.
// Ctrl+V already works correctly everywhere, with no per-site code at all.
//
// Responsibilities:
//   1. Show a floating status pill (listening / processing / copied / error).
//   2. Copy the finished transcript to the clipboard.
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
  // `sessionActive` is tracked in every frame so whichever frame actually has
  // focus can detect the hotkey release. `armed` is top-frame-only: it owns
  // the one visible pill and the clipboard write, so a page with iframes
  // doesn't show a pill per frame.
  let sessionActive = false;
  let armed = false;
  let sessionStartedAt = 0;
  let stopSent = false;
  let accumulated = ''; // joined text across auto-chunk mode's multiple chunks
  const pendingBySeq = new Map(); // out-of-order chunk results, applied in order
  let nextSeq = 0;

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
    if (state === 'copied' || state === 'error' || state === 'idle') {
      const ms = state === 'error' ? 4500 : state === 'copied' ? 2600 : 1200;
      pillHideTimer = setTimeout(hidePill, ms);
    }
  }
  function hidePill() {
    if (pillEl) pillEl.style.display = 'none';
  }

  // Add a leading space when joining onto previously accumulated text.
  function needsLeadingSpace(before, text) {
    if (!before) return false;
    if (/\s$/.test(before)) return false;
    if (/^[\s.,!?;:)\]}'"’”]/.test(text)) return false;
    return true;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      log('clipboard write failed', e);
      return false;
    }
  }

  // Appends one chunk's text to the running transcript and re-copies the
  // whole thing, so auto-chunk mode never loses an earlier chunk by
  // overwriting the clipboard out from under it — whenever the user pastes,
  // they get everything dictated so far in this session.
  async function appendAndCopy(text) {
    const payload = (needsLeadingSpace(accumulated, text) ? ' ' : '') + text;
    accumulated += payload;
    const ok = await copyToClipboard(accumulated);
    if (ok) {
      showPill('copied', `✓ Copied (${accumulated.length} chars) — press Ctrl+V`);
      // auto-chunk mode: fall back to the listening pill after the flash
      setTimeout(() => { if (armed && sessionActive) showPill('listening', '● Listening…'); }, 1400);
    } else {
      showPill('error', '⚠ Could not copy to clipboard');
    }
  }

  function flushPending() {
    while (pendingBySeq.has(nextSeq)) {
      const text = pendingBySeq.get(nextSeq);
      pendingBySeq.delete(nextSeq);
      nextSeq += 1;
      if (text && text.trim()) appendAndCopy(text);
    }
  }

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'dictation-listening': {
        sessionActive = true;
        stopSent = false;
        sessionStartedAt = Date.now();
        if (isTopFrame) {
          armed = true;
          accumulated = '';
          pendingBySeq.clear();
          nextSeq = 0;
          showPill('listening', '● Listening…');
        }
        log('listening');
        break;
      }

      case 'dictation-processing':
        stopSent = true; // the session is already finalising; no more cs-stop
        if (armed) showPill('processing', '… Transcribing');
        break;

      case 'dictation-insert':
        if (!armed) break; // only the top frame owns the pill/clipboard
        if (typeof msg.seq === 'number') {
          pendingBySeq.set(msg.seq, msg.text || '');
          flushPending();
        } else if (msg.text) {
          appendAndCopy(msg.text);
        }
        break;

      case 'dictation-done':
        sessionActive = false;
        if (armed) {
          if (accumulated) showPill('copied', `✓ Copied (${accumulated.length} chars) — press Ctrl+V`);
          else hidePill();
        }
        armed = false;
        break;

      case 'dictation-idle':
        sessionActive = false;
        if (armed) hidePill();
        armed = false;
        break;

      case 'dictation-error':
        sessionActive = false;
        if (isTopFrame) showPill('error', `⚠ ${msg.message || 'Dictation failed'}`);
        armed = false;
        break;

      default:
    }
  });

  // -------------------------------------------------- hotkey release (hold-to-talk)
  function onKeyUp(e) {
    if (!sessionActive || stopSent) return;
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
})();
