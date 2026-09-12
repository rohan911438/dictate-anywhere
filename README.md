# Dictate Anywhere

A Chrome (Manifest V3) extension. Press **Ctrl+Shift+Space** on any web page,
speak, and the cleaned‑up transcript is copied to your clipboard — press
**Ctrl+V** to paste it anywhere: a plain input, a React‑controlled field,
Gmail compose, GitHub comments, Google Docs, a desktop app outside the
browser entirely. Anything that accepts a paste.

The extension deliberately does **not** try to write directly into the page's
DOM. Every site's editor has its own quirks (see `ROADMAP.md` for the full
reasoning) and chasing each one is an unbounded maintenance problem. The
clipboard + native paste is the one interface every app already gets right.

There is no history, no search, no dashboard — voice replaces typing, one
clipboard write at a time.

Powered by the **AssemblyAI Dictation API** (`POST https://dictation.assemblyai.com/transcribe`)
— a single‑shot multipart REST call that returns a verbatim transcript plus an
optional LLM‑rewritten version.

---

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. The onboarding tab opens automatically. Follow it:
   - **Allow microphone** — grants mic access to the extension origin so the
     first real dictation doesn't stall on a permission prompt. The invisible
     *offscreen document* that captures audio shares this origin, so one grant
     covers it.
   - **Add your API key** — opens Options. Paste your key from
     [assemblyai.com/dashboard/api-keys](https://www.assemblyai.com/dashboard/api-keys).
     Raw key only — **no `Bearer` prefix**.
   - **Change the hotkey** (optional) — `chrome://extensions/shortcuts`.

If Chrome couldn't bind `Ctrl+Shift+Space` (another extension already owns it),
set it yourself at `chrome://extensions/shortcuts`, or use the **Start dictation**
button in the toolbar popup.

Requires Chrome **116+**.

---

## Using it

| Gesture | Behaviour |
|---|---|
| **Tap** Ctrl+Shift+Space | Toggle: starts a session; tap again to stop and transcribe. |
| **Hold** Ctrl+Shift+Space, speak, **release** | Push‑to‑talk: releasing (after ~0.4 s) stops and transcribes. |
| Toolbar popup → **Start / Stop dictation** | Same as the hotkey, for pages where the shortcut isn't delivered. |

A small status pill (bottom‑right of the page) shows **Listening → Transcribing →
Copied (press Ctrl+V)**, or an error. Nothing needs to be focused for
dictation to start — the transcript goes to the clipboard regardless, so you
can even dictate a note with no page in mind and paste it later.

### Auto silence‑chunking (opt‑in, Options → Behaviour)

Off by default. When on, a session doesn't wait for you to stop — after ~1.5 s of
silence the current clip is sent and transcribed, and it **keeps listening**.
Each new chunk's text is appended to the running transcript and the *whole
thing so far* is re‑copied to the clipboard, so pasting at any point gets you
everything dictated up to that moment — no chunk is ever lost by being
overwritten. Press the hotkey again to end the session. Each clip still
respects the API's 120‑second cap (finalised at ~115 s). Good for long‑form
dictation.

### Options

- **API key** — stored in `chrome.storage.local` (this browser only, never
  synced, sent only to AssemblyAI).
- **Languages** — sent as `language_codes`. Supported: en, es, de, fr, it, pt,
  tr, nl, sv, no, da, fi, hi, vi, ar, he, ja, ur, zh.
- **Default rewrite instruction** — plain‑English `llm_instruction` (≤ 2048
  chars). Blank = strip filler words only.
- **Key terms** — one per line, sent as `keyterms_prompt` to bias jargon/names.
- **Per‑site rewrite overrides** — `domain → instruction`. Suffix match
  (`google.com` also matches `mail.google.com`). A **blank** instruction on a row
  means *insert exactly what I said* (verbatim `text`, no rewrite) on that site.
- **Debug logging** — verbose `console` output in every context (see below).
- **Auto silence‑chunking** — described above.

---

## Debug flag

Options → Behaviour → **Debug logging**. Turns on `[DictateAnywhere:*]` console
logging in the service worker, the offscreen document, and the content script.
The offscreen logs each clip's **sample count, duration, and byte size** before
it goes to the network — so you can confirm the WAV is what you expect in the
Network tab.

- Service worker logs: `chrome://extensions` → *Dictate Anywhere* → **service worker**.
- Offscreen logs: same page → **offscreen.html** (only visible while a session runs).
- Content‑script logs: the page's own DevTools console.

---

## `test-api.js` — verify the API without the extension

```
node test-api.js path/to/clip.wav [apiKey]
```

POSTs a local WAV straight to the Dictation API with the same `config` shape the
extension builds, and prints `text`, `llm_response`, `llm_error`, and timing
metadata. Needs Node 18+ (uses the built‑in `fetch`/`FormData`/`Blob`).

**Key resolution:** CLI arg → `$ASSEMBLYAI_API_KEY` → `dev/local-key.txt`
(git‑ignored). Optional env knobs: `DICTATE_LANGS=en,es`,
`DICTATE_LLM="Fix grammar."`, `DICTATE_KEYTERMS=Foo,Bar`.

Example:
```
ASSEMBLYAI_API_KEY=xxxx node test-api.js ./samples/hello.wav
```

---

## Architecture (and why)

```
hotkey / popup ─▶ background.js (service worker, ES module)
                    │  owns the state machine (chrome.storage.session)
                    │  owns the single fetch() to AssemblyAI
                    ▼
                 offscreen.html / offscreen.js
                    │  getUserMedia + Web Audio (ScriptProcessorNode)
                    │  hand-encodes WAV (44-byte header + PCM16)
                    ▼  base64 WAV ─▶ background ─▶ Dictation API
                 content-script.js (all frames)
                    status pill  +  clipboard write
```

Deliberate decisions (do not "simplify" these away):

- **Offscreen document for the mic.** A service worker can't call
  `getUserMedia`. The offscreen doc can, and it shares the extension origin so
  the onboarding permission grant applies to it.
- **`ScriptProcessorNode` + hand‑rolled WAV**, not `MediaRecorder`.
  `MediaRecorder` emits webm/opus; the Dictation API needs WAV/PCM. The capture
  graph routes `source → processor → zero‑gain → destination` so the node keeps
  firing without any mic audio reaching the speakers.
- **Clipboard, not DOM injection.** The content script never touches the
  page's text — it writes the transcript via `navigator.clipboard.writeText`
  and shows a "Copied — press Ctrl+V" pill. This is why the top frame (not
  whichever frame happens to have focus) always owns the pill: there's no
  target element to track anymore, just one place to show one confirmation.
  See `ROADMAP.md` for why this replaced the earlier per‑site DOM‑insertion
  approach.
- **Transient state in `chrome.storage.session`**, not a variable — the worker
  can be suspended mid‑flow. If the worker is killed while recording, the next
  hotkey press reconciles: offscreen still alive ⇒ session recovers on stop;
  offscreen gone ⇒ state is cleared cleanly.
- **`chrome.commands` owns *start*** (works globally, even off‑page); the content
  script only detects hotkey *release* for push‑to‑talk. This keeps the two
  entry points from racing.

---

## Resilience

- One retry (short backoff) on network error / client timeout, and one retry on
  `502 / 503 / 504`.
- `404` from this API means *invalid key* — surfaced as an auth error, not "not
  found".
- `429` surfaces a "rate limited, try again" message through the on‑page pill.
- A failed LLM rewrite still returns `200` with `llm_response: null` — the
  extension always falls back to the verbatim `text`.
- 90 s client timeout (`AbortController`).

---

## Known site issues

Because insertion is now clipboard + paste rather than direct DOM writes, the
whole earlier category of "does this specific editor's `contenteditable`
accept our text" bugs no longer applies — Google Forms, Gmail, GitHub, Google
Docs, Notion, anything: if the site accepts a normal Ctrl+V paste, it works.
What's left to watch for is much narrower:

- Sites that bind `Ctrl+Shift+Space` themselves may conflict with the hotkey
  (change it at `chrome://extensions/shortcuts`).
- `navigator.clipboard.writeText` can be blocked by site or browser policy on
  rare pages — the pill shows "⚠ Could not copy to clipboard" if so.
- After updating the extension, already‑open tabs keep running the old content
  script until reloaded.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, `toggle-dictation` command, module worker |
| `background.js` | state machine, offscreen lifecycle, AssemblyAI fetch |
| `offscreen.html` / `offscreen.js` | mic capture + WAV encoding |
| `content-script.js` / `content-style.css` | status pill + clipboard write |
| `popup.html` / `.js` / `.css` | toolbar status + start/stop + links |
| `options.html` / `.js` / `.css` | key, languages, instructions, overrides, toggles |
| `onboarding.html` / `.js` / `.css` | first‑run: mic grant + key + hotkey |
| `shared/constants.js` | endpoint, timeouts, language list, storage defaults |
| `test-api.js` | standalone API check (Node) |
| `tools/make-icons.js` | regenerates `icons/*.png` placeholders |

See `SECURITY_NOTES.md` for the prompt‑injection and key‑handling review.
