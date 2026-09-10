import { SUPPORTED_LANGUAGES, DEFAULTS, MAX_LLM_INSTRUCTION } from './shared/constants.js';

const $ = (id) => document.getElementById(id);
const state = { overrides: [] };

// ------------------------------------------------------------------ language grid
function buildLangGrid(selected) {
  const grid = $('langGrid');
  grid.textContent = '';
  for (const [code, name] of SUPPORTED_LANGUAGES) {
    const label = document.createElement('label');
    label.className = 'lang';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = code;
    box.checked = selected.includes(code);

    const nameEl = document.createElement('span');
    nameEl.textContent = name;

    const codeEl = document.createElement('em');
    codeEl.textContent = code;

    label.append(box, nameEl, codeEl);
    grid.appendChild(label);
  }
}

// ------------------------------------------------------------------ overrides
function renderOverrides() {
  const box = $('overrides');
  box.textContent = '';
  state.overrides.forEach((row, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'override';

    const domain = document.createElement('input');
    domain.className = 'dom';
    domain.placeholder = 'mail.google.com';
    domain.value = row.domain || '';
    domain.addEventListener('input', () => { state.overrides[i].domain = domain.value; });

    const instruction = document.createElement('input');
    instruction.className = 'ins';
    instruction.placeholder = 'rewrite instruction (blank = verbatim)';
    instruction.value = row.instruction || '';
    instruction.addEventListener('input', () => { state.overrides[i].instruction = instruction.value; });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      state.overrides.splice(i, 1);
      renderOverrides();
    });

    wrap.append(domain, instruction, del);
    box.appendChild(wrap);
  });
}

// ------------------------------------------------------------------ load / save
async function load() {
  const cfg = await chrome.storage.local.get({ ...DEFAULTS, apiKey: '' });

  $('apiKey').value = cfg.apiKey || '';
  buildLangGrid(cfg.languages && cfg.languages.length ? cfg.languages : DEFAULTS.languages);
  $('llm').value = cfg.llmInstruction || '';
  $('llmCount').textContent = String(($('llm').value || '').length);
  $('keyterms').value = (cfg.keyterms || []).join('\n');
  state.overrides = Array.isArray(cfg.siteOverrides)
    ? cfg.siteOverrides.map((r) => ({ domain: r.domain || '', instruction: r.instruction || '' }))
    : [];
  renderOverrides();
  $('autoChunk').checked = !!cfg.autoChunk;
  $('debug').checked = !!cfg.debug;
}

async function save() {
  const languages = [...document.querySelectorAll('#langGrid input:checked')].map((i) => i.value);
  const keyterms = $('keyterms')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const siteOverrides = state.overrides
    .map((r) => ({ domain: (r.domain || '').trim(), instruction: (r.instruction || '').trim() }))
    .filter((r) => r.domain);

  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    languages: languages.length ? languages : DEFAULTS.languages,
    llmInstruction: $('llm').value.slice(0, MAX_LLM_INSTRUCTION),
    keyterms,
    siteOverrides,
    autoChunk: $('autoChunk').checked,
    debug: $('debug').checked,
  });

  const saved = $('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 1500);
}

// ------------------------------------------------------------------ wiring
$('toggleKey').addEventListener('click', () => {
  const field = $('apiKey');
  const reveal = field.type === 'password';
  field.type = reveal ? 'text' : 'password';
  $('toggleKey').textContent = reveal ? 'Hide' : 'Show';
});

$('llm').addEventListener('input', () => {
  $('llmCount').textContent = String($('llm').value.length);
});

$('addOverride').addEventListener('click', () => {
  state.overrides.push({ domain: '', instruction: '' });
  renderOverrides();
});

$('save').addEventListener('click', save);

load();
