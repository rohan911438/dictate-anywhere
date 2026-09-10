// Shared config for Dictate Anywhere.
// Loaded as an ES module by the service worker, the offscreen document,
// the popup and the options page. Keep it free of any DOM / chrome.* calls.

// --- AssemblyAI Dictation API ---------------------------------------------
// Single-shot REST endpoint (NOT a WebSocket). multipart/form-data body,
// raw API key in the Authorization header (no "Bearer" prefix).
export const API_ENDPOINT = 'https://dictation.assemblyai.com/transcribe';

// Client-side request timeout. Docs: short clips answer in < 1s; allow slack.
export const CLIENT_TIMEOUT_MS = 90_000;

// Hard per-call audio ceiling enforced by the API.
export const MAX_CLIP_MS = 120_000;
// Finalise a clip slightly before the hard cap so we never send an over-limit clip.
export const CHUNK_SOFT_CAP_MS = 115_000;

// Auto silence-chunking (opt-in): how long a pause ends a chunk, and the RMS
// level below which a frame counts as "silent".
export const SILENCE_HOLD_MS = 1_500;
export const SILENCE_RMS_THRESHOLD = 0.008;
// Ignore a chunk shorter than this (ms) — usually a stray click / breath.
export const MIN_CHUNK_MS = 350;

// One retry with this backoff on network failure / 502 / 503 / 504.
export const RETRY_BACKOFF_MS = 700;

// llm_instruction length limit per the docs.
export const MAX_LLM_INSTRUCTION = 2_048;

// Languages the Dictation API accepts as language_codes.
export const SUPPORTED_LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['tr', 'Turkish'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['no', 'Norwegian'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['hi', 'Hindi'],
  ['vi', 'Vietnamese'],
  ['ar', 'Arabic'],
  ['he', 'Hebrew'],
  ['ja', 'Japanese'],
  ['ur', 'Urdu'],
  ['zh', 'Chinese'],
];
export const LANG_CODES = SUPPORTED_LANGUAGES.map(([code]) => code);

// chrome.storage.local defaults. `apiKey` is intentionally not here so we can
// tell "never set" from "set to empty".
export const DEFAULTS = {
  languages: ['en'],
  llmInstruction: '',
  keyterms: [],
  siteOverrides: [], // [{ domain: "mail.google.com", instruction: "..." }]
  autoChunk: false,
  debug: false,
};
