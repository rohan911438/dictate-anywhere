import { SUPPORTED_LANGUAGES, DEFAULTS } from './shared/constants.js';

const RESTRICTED_SCHEME = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const WEBSTORE = /^https?:\/\/chromewebstore\.google\.com/i;

const $ = (id) => document.getElementById(id);

function languageLabel(code) {
  const hit = SUPPORTED_LANGUAGES.find(([c]) => c === code);
  return hit ? hit[1] : code;
}

async function refresh() {
  const cfg = await chrome.storage.local.get(['apiKey', 'languages', 'autoChunk']);

  const hasKey = !!(cfg.apiKey && cfg.apiKey.trim());
  $('key').textContent = hasKey ? 'set' : 'not set';
  $('key').classList.toggle('bad', !hasKey);

  const langs = cfg.languages && cfg.languages.length ? cfg.languages : DEFAULTS.languages;
  $('langs').textContent = langs.map(languageLabel).join(', ');
  $('chunk').textContent = cfg.autoChunk ? 'on' : 'off';

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab && tab.url ? tab.url : '';
  const restricted = !url || RESTRICTED_SCHEME.test(url) || WEBSTORE.test(url);

  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => null);
  const recording = !!(status && status.recording);

  $('toggle').disabled = !hasKey || (restricted && !recording);
  $('toggle').textContent = recording ? 'Stop dictation' : 'Start dictation';
  $('toggle').dataset.recording = recording ? '1' : '';
  $('status').textContent = recording ? 'Listening…' : 'Idle';
  $('status').classList.toggle('live', recording);

  if (!hasKey) {
    $('hint').textContent = 'Add your AssemblyAI API key in Options to begin.';
  } else if (restricted) {
    $('hint').textContent = 'This browser page can’t receive dictation — try a normal website.';
  } else {
    $('hint').textContent = 'Hotkey: Ctrl+Shift+Space — tap to toggle, or hold and release.';
  }
}

$('toggle').addEventListener('click', async () => {
  const recording = $('toggle').dataset.recording === '1';
  await chrome.runtime
    .sendMessage({ type: recording ? 'cs-stop' : 'popup-start' })
    .catch(() => {});
  setTimeout(refresh, 250);
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') refresh();
});

refresh();
