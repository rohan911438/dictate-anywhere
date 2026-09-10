# Agent notes — Dictate Anywhere

Chrome MV3 extension. Hold **Ctrl+Shift+Space** on any web page, speak, release —
the cleaned‑up transcript is typed into the focused field. Voice replaces typing;
nothing is stored. See `README.md` for the full picture and `SECURITY_NOTES.md`
for the key‑handling / prompt‑injection review.

## Working on this repo

- **AssemblyAI API:** before writing or changing any code that calls AssemblyAI,
  fetch `https://www.assemblyai.com/docs/llms.txt` (narrow with
  `?lang=typescript`). The API changes — do not rely on memorized parameter
  names. This project uses the **Dictation API**
  (`POST https://dictation.assemblyai.com/transcribe`, single‑shot
  multipart/form‑data, raw key in `Authorization` with **no `Bearer` prefix**),
  which is a different product from the generic `/v2/transcript` and `/v3/ws`
  streaming APIs.
- All tunables (endpoint, timeouts, language list, storage defaults) live in
  `shared/constants.js` — change them there, not inline.
- Syntax‑check module files with `cat file.js | node --check --input-type=module`
  (the repo `package.json` is `type: commonjs` for the Node tooling; the browser
  loads `background.js` / `offscreen.js` / `popup.js` / `options.js` /
  `onboarding.js` as ES modules).
- `node test-api.js path/to/clip.wav` verifies the API end‑to‑end without loading
  the extension.

## Deliberate design (don't "simplify" these)

- Offscreen document for `getUserMedia` (a service worker can't).
- `ScriptProcessorNode` + hand‑rolled WAV, **not** `MediaRecorder` (the API needs
  WAV/PCM, not webm/opus).
- Native prototype `value` setter for input/textarea injection so React change
  detection fires; `execCommand('insertText')` + Range fallback for
  `contenteditable`.
- Transient state in `chrome.storage.session` — the worker can be suspended
  mid‑flow.
- `chrome.commands` owns *start*; the content script only detects hotkey
  *release* for push‑to‑talk.

## Secrets

- The API key is entered at runtime via the Options page → `chrome.storage.local`.
  Never hardcode a key in source (MV3 ships source in plaintext).
- `dev/local-key.txt` is git‑ignored and used only by `test-api.js`.
