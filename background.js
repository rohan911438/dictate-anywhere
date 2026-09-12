// Dictate Anywhere — service worker (ES module).
//
// Owns the dictation state machine, the offscreen document lifecycle, and the
// single network call to the AssemblyAI Dictation API. All transient state
// lives in chrome.storage.session because the worker can be suspended mid-flow.

import {
  API_ENDPOINT,
  CLIENT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  MAX_LLM_INSTRUCTION,
  LANG_CODES,
  DEFAULTS,
} from './shared/constants.js';

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null; // guards concurrent createDocument calls

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isDebug() {
  const { debug } = await chrome.storage.local.get('debug');
  return !!debug;
}
async function log(...args) {
  if (await isDebug()) console.log('[DictateAnywhere:bg]', ...args);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Broadcasts to every frame's content script in a tab. Swallows the common
// "no receiver" error for restricted pages (chrome://, Web Store, PDF viewer).
function sendToTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// --------------------------------------------------------------------------
// session state
// --------------------------------------------------------------------------
async function getState() {
  const s = await chrome.storage.session.get(['recording', 'tabId']);
  return { recording: !!s.recording, tabId: s.tabId ?? null };
}
async function setRecording(tabId) {
  await chrome.storage.session.set({ recording: true, tabId });
}
async function clearRecording() {
  await chrome.storage.session.set({ recording: false, tabId: null });
}

// --------------------------------------------------------------------------
// offscreen document lifecycle
// --------------------------------------------------------------------------
async function hasOffscreen() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture microphone audio for push-to-talk dictation.',
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {
      /* already gone */
    }
  }
}

async function tellOffscreen(message) {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    return true;
  } catch (_) {
    return false; // no receiver yet
  }
}

// The offscreen document registers its listener during load, which normally
// finishes before createDocument() resolves — but retry a few times to close
// any timing gap.
async function tellOffscreenReliably(message, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    if (await tellOffscreen(message)) return true;
    await sleep(120);
  }
  await log('offscreen never acknowledged', message.type);
  return false;
}

// --------------------------------------------------------------------------
// start / stop
// --------------------------------------------------------------------------
async function startDictation(tabId) {
  const st = await getState();

  if (st.recording) {
    if (await hasOffscreen()) {
      // A genuine session is already running — ignore a duplicate start.
      await log('start ignored: session already active');
      return;
    }
    // Recovery: the worker was killed mid-recording. The flag is stale and no
    // offscreen document exists. Reset cleanly instead of hanging.
    await log('stale recording flag with no offscreen document — resetting');
    await clearRecording();
  }

  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id ?? null;
  }
  if (tabId == null) {
    await log('start aborted: no target tab');
    return;
  }

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    sendToTab(tabId, {
      type: 'dictation-error',
      message: 'Add your AssemblyAI API key in the extension options first.',
    });
    return;
  }

  await setRecording(tabId);
  try {
    await ensureOffscreen();
  } catch (e) {
    await log('offscreen creation failed', e);
    await clearRecording();
    sendToTab(tabId, { type: 'dictation-error', message: 'Could not start the audio capture context.' });
    return;
  }

  const { autoChunk, debug } = await chrome.storage.local.get(['autoChunk', 'debug']);
  const started = await tellOffscreenReliably({
    type: 'start',
    autoChunk: !!autoChunk,
    debug: !!debug,
  });
  if (!started) {
    await clearRecording();
    await closeOffscreen();
    sendToTab(tabId, { type: 'dictation-error', message: 'Audio capture did not start — try again.' });
    return;
  }
  sendToTab(tabId, { type: 'dictation-listening' });
  await log('dictation started for tab', tabId, 'autoChunk=', !!autoChunk);
}

async function stopDictation() {
  const st = await getState();
  if (!st.recording) return;

  if (!(await hasOffscreen())) {
    // Nothing to finalise — offscreen is gone. Clean up.
    await clearRecording();
    if (st.tabId != null) sendToTab(st.tabId, { type: 'dictation-idle' });
    return;
  }

  if (st.tabId != null) sendToTab(st.tabId, { type: 'dictation-processing' });
  const acked = await tellOffscreenReliably({ type: 'stop' }); // offscreen replies with 'final' or 'stopped'
  if (!acked) {
    // Offscreen never acknowledged the stop — treat the session as dead instead
    // of leaving the page stuck on "Transcribing" forever.
    await log('stop not acknowledged — forcing reset');
    await clearRecording();
    await closeOffscreen();
    if (st.tabId != null) {
      sendToTab(st.tabId, {
        type: 'dictation-error',
        message: 'Dictation got stuck and was reset — try again.',
      });
    }
  }
}

// --------------------------------------------------------------------------
// AssemblyAI Dictation API call
// --------------------------------------------------------------------------

// Builds the `config` blob. Returns { config, verbatimOnly }.
// A matching site override with a blank instruction means "insert exactly what
// was said" — we then use `text` (verbatim) instead of `llm_response`.
async function buildConfig(hostname) {
  const s = await chrome.storage.local.get([
    'languages',
    'llmInstruction',
    'keyterms',
    'siteOverrides',
  ]);

  const config = {};

  const langs = Array.isArray(s.languages)
    ? s.languages.filter((c) => LANG_CODES.includes(c))
    : [];
  config.language_codes = langs.length ? langs : DEFAULTS.languages;

  const keyterms = Array.isArray(s.keyterms)
    ? s.keyterms.map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (keyterms.length) config.keyterms_prompt = keyterms.slice(0, 1000);

  const override = matchSiteOverride(hostname, s.siteOverrides);
  let verbatimOnly = false;
  let instruction;
  if (override != null) {
    instruction = override.trim();
    if (!instruction) verbatimOnly = true;
  } else {
    instruction = (s.llmInstruction || '').trim();
  }
  if (instruction) config.llm_instruction = instruction.slice(0, MAX_LLM_INSTRUCTION);

  return { config, verbatimOnly };
}

function matchSiteOverride(hostname, overrides) {
  if (!hostname || !Array.isArray(overrides)) return null;
  const host = hostname.toLowerCase();
  let best = null;
  for (const row of overrides) {
    if (!row || !row.domain) continue;
    const d = String(row.domain)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*?\.?/, '');
    if (!d) continue;
    if (host === d || host.endsWith(`.${d}`)) {
      if (!best || d.length > best.len) {
        best = { len: d.length, instruction: String(row.instruction ?? '') };
      }
    }
  }
  return best ? best.instruction : null;
}

// Returns { ok:true, text, llmError } or { ok:false, message }.
// Never returns / logs the API key.
async function transcribe(audioBuffer, hostname) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return { ok: false, message: 'No API key set — open the options page.' };

  const { config, verbatimOnly } = await buildConfig(hostname);

  const attempt = async () => {
    const form = new FormData();
    form.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }), 'clip.wav');
    form.append('config', JSON.stringify(config));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      return await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: apiKey }, // raw key — no "Bearer" prefix
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res;
  try {
    res = await attempt();
  } catch (e) {
    // network error or client timeout → one retry after a short backoff
    await log('request failed, retrying once:', e && e.name);
    await sleep(RETRY_BACKOFF_MS);
    try {
      res = await attempt();
    } catch (e2) {
      return {
        ok: false,
        message:
          e2 && e2.name === 'AbortError'
            ? 'AssemblyAI timed out — try a shorter clip.'
            : 'Network error reaching AssemblyAI.',
      };
    }
  }

  // Transient upstream failures: retry once per the docs' guidance.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    await log(`upstream ${res.status} — retrying once`);
    await sleep(RETRY_BACKOFF_MS);
    try {
      res = await attempt();
    } catch (_) {
      /* fall through to status handling below */
    }
  }

  // 404 from this API means "invalid API key" — treat it as auth, not "not found".
  if (res.status === 401 || res.status === 404) {
    return { ok: false, message: 'AssemblyAI rejected the API key — check it in options.' };
  }
  if (res.status === 429) {
    return { ok: false, message: 'Rate limited by AssemblyAI — wait a moment and try again.' };
  }
  if (res.status === 400) {
    return { ok: false, message: 'AssemblyAI could not process that audio (400).' };
  }
  if (res.status === 503) {
    return { ok: false, message: 'AssemblyAI is at capacity right now — try again shortly.' };
  }
  if (!res.ok) {
    return { ok: false, message: `AssemblyAI error ${res.status}.` };
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    return { ok: false, message: 'Could not read the AssemblyAI response.' };
  }

  const rewrite = typeof data.llm_response === 'string' ? data.llm_response.trim() : '';
  const verbatim = typeof data.text === 'string' ? data.text : '';
  const text = verbatimOnly ? verbatim : rewrite || verbatim; // always fall back to `text`

  await log(
    'transcribe ok:',
    `chars=${text.length}`,
    `llm_error=${data.llm_error ?? 'null'}`,
    `confidence=${data.confidence ?? 'n/a'}`,
    `request_time_ms=${data.request_time_ms ?? 'n/a'}`,
  );

  return { ok: true, text, llmError: data.llm_error || null };
}

// --------------------------------------------------------------------------
// messages from the offscreen document
// --------------------------------------------------------------------------

// Offscreen messages (chunk / final / stopped / capture-error) must be applied
// strictly in order: a later 'final' clearing state must not overtake an
// earlier 'chunk' still being transcribed. Serialise them through one chain.
let offscreenChain = Promise.resolve();
function handleOffscreenMessage(msg) {
  offscreenChain = offscreenChain
    .then(() => processOffscreenMessage(msg))
    .catch(async (e) => {
      // An unexpected throw here must not leave the session stuck: the page
      // is already showing "Transcribing" and has no other way to recover.
      await log('offscreen message handler failed', e);
      const st = await getState();
      await clearRecording();
      await closeOffscreen();
      if (st.tabId != null) {
        sendToTab(st.tabId, {
          type: 'dictation-error',
          message: 'Dictation failed unexpectedly — try again.',
        });
      }
    });
  return offscreenChain;
}

async function processOffscreenMessage(msg) {
  const st = await getState();
  const { tabId } = st;

  switch (msg.type) {
    case 'capture-error': {
      if (tabId != null) {
        sendToTab(tabId, {
          type: 'dictation-error',
          message: msg.message || 'Microphone unavailable.',
        });
      }
      await clearRecording();
      await closeOffscreen();
      return;
    }

    case 'chunk':
    case 'final': {
      await log(
        `offscreen ${msg.type}: seq=${msg.seq} bytes=${msg.bytes} durationMs=${msg.durationMs}`,
      );

      let hostname = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        hostname = new URL(tab.url).hostname;
      } catch (_) {
        /* tab gone — proceed without a site override */
      }

      const result = await transcribe(base64ToArrayBuffer(msg.audioBase64), hostname);

      if (result.ok) {
        if (result.text && result.text.trim()) {
          sendToTab(tabId, { type: 'dictation-insert', text: result.text, seq: msg.seq ?? 0 });
        } else {
          sendToTab(tabId, { type: 'dictation-error', message: 'No speech detected in that clip.' });
        }
        if (result.llmError) {
          await log('llm rewrite failed:', result.llmError, '— inserted verbatim transcript');
        }
      } else {
        sendToTab(tabId, { type: 'dictation-error', message: result.message });
      }

      if (msg.type === 'final') {
        await clearRecording();
        await closeOffscreen();
        sendToTab(tabId, { type: 'dictation-done' });
      }
      return;
    }

    case 'stopped': {
      // Offscreen stopped with nothing worth sending.
      await clearRecording();
      await closeOffscreen();
      if (tabId != null) sendToTab(tabId, { type: 'dictation-idle' });
      return;
    }

    default:
  }
}

// --------------------------------------------------------------------------
// message router
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.from === 'offscreen') {
    handleOffscreenMessage(msg);
    return undefined;
  }

  switch (msg.type) {
    case 'cs-stop':
      stopDictation();
      return undefined;

    case 'popup-start':
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        startDictation(tab?.id ?? null);
      })();
      return undefined;

    case 'get-status':
      getState().then((s) => sendResponse({ recording: s.recording }));
      return true; // async response

    case 'open-options':
      chrome.runtime.openOptionsPage();
      return undefined;

    case 'open-shortcuts':
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return undefined;

    default:
      return undefined;
  }
});

// --------------------------------------------------------------------------
// hotkey — global toggle (works even when page content is not focused)
// --------------------------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-dictation') return;
  (async () => {
    const st = await getState();
    if (st.recording && (await hasOffscreen())) {
      await stopDictation();
    } else {
      await startDictation(null); // startDictation self-heals a stale flag
    }
  })();
});

// --------------------------------------------------------------------------
// install / update
// --------------------------------------------------------------------------
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content-script.js'],
      });
    } catch (_) {
      /* restricted tab — expected */
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  // Seed any missing defaults without clobbering existing values.
  chrome.storage.local.get(DEFAULTS).then((current) => {
    const seed = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (current[k] === undefined) seed[k] = v;
    }
    if (Object.keys(seed).length) chrome.storage.local.set(seed);
  });

  reconcileState();
  injectIntoOpenTabs();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// A fresh worker (browser restart, or eviction while idle) may hold a stale
// "recording" flag. Only clear it when there is genuinely no capture in
// progress — an offscreen document that survived the worker means the session
// is still live and its buffered audio is recoverable on the next stop.
async function reconcileState() {
  const st = await getState();
  if (st.recording && !(await hasOffscreen())) {
    await log('reconcile: clearing stale recording flag');
    await clearRecording();
  }
}
reconcileState();
