const $ = (id) => document.getElementById(id);

$('mic').addEventListener('click', async () => {
  const label = $('micState');
  label.textContent = '…';
  label.className = 'state';
  try {
    // Granting here (extension origin) persists for the offscreen document,
    // which shares this origin.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    label.textContent = '✓ granted';
    label.className = 'state ok';
    $('mic').disabled = true;
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    label.textContent = denied
      ? '✕ denied — click the mic icon in the address bar to allow, then retry'
      : `✕ ${(e && e.name) || 'unavailable'}`;
    label.className = 'state bad';
  }
});

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('sc').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

async function reflectKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const has = !!(apiKey && apiKey.trim());
  $('keyState').textContent = has ? '✓ key saved' : '';
  $('keyState').className = `state ${has ? 'ok' : ''}`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.apiKey) reflectKey();
});

reflectKey();
