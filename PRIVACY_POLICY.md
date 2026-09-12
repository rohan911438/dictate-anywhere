# Privacy Policy — Dictate Anywhere

**Last updated:** 2026-09-12

Dictate Anywhere is a Chrome extension that turns your speech into text using
the AssemblyAI Dictation API, and copies the result to your clipboard. This
page explains exactly what data the extension touches, where it goes, and
what it does not do.

## What the extension collects

- **Microphone audio**, only while you are actively holding/toggling the
  dictation hotkey. It is captured in memory, encoded to a WAV clip, and sent
  once to AssemblyAI for transcription. **The extension itself never stores,
  logs, or transmits your audio anywhere else, and does not retain it after
  the request completes.**
- **The transcribed text** returned by AssemblyAI. It is written to your
  system clipboard and shown briefly in an on‑page status pill. It is not
  saved, logged, or sent anywhere beyond that.
- **Your AssemblyAI API key**, which you enter yourself in the Options page.
  It is stored only in `chrome.storage.local` — local to your browser
  profile, never synced to Google's servers, never sent anywhere except as
  the `Authorization` header on requests to AssemblyAI's own API endpoint
  (`dictation.assemblyai.com`).
- **Your settings** (chosen languages, rewrite instructions, key terms,
  per‑site overrides, and the debug/auto‑chunk toggles) — also
  `chrome.storage.local` only.

## What the extension does **not** do

- No analytics, telemetry, or usage tracking of any kind.
- No account system, sign‑in, or user identifiers.
- No advertising, and no data is sold or shared with anyone other than
  AssemblyAI, solely to perform the transcription you requested.
- No browsing history is read or recorded. The extension's content script
  only runs to show a status pill and write to the clipboard — it does not
  read page content.
- Debug logging (off by default) only ever prints to your own browser's
  DevTools console. Nothing it logs leaves your machine.

## Third‑party processor

Audio you dictate is sent to **AssemblyAI** (`assemblyai.com`) solely to
produce a transcript, using the API key you provided. See AssemblyAI's own
privacy policy at [assemblyai.com/legal/privacy-policy](https://www.assemblyai.com/legal/privacy-policy)
for how they handle that request. Dictate Anywhere has no relationship with
AssemblyAI beyond calling their public API with your own key and your own
account's usage terms.

## Permissions, and why

| Permission | Why it's needed |
|---|---|
| `storage` | Save your API key and settings locally. |
| `activeTab` / `scripting` / `host_permissions: <all_urls>` | Let the status‑pill content script run on whatever page you're dictating into. It does not read or modify page content otherwise. |
| `offscreen` | A Manifest V3 service worker cannot access the microphone directly; an offscreen document is the mechanism Chrome provides for that. |
| `clipboardWrite` | How the transcript reaches you — copied to your clipboard for you to paste. |

## Data retention and deletion

Nothing described above is retained by the extension beyond the current
browser session's storage. To remove everything the extension has stored:
remove the extension from `chrome://extensions`, or clear its data via
`chrome://settings/content/all` → search the extension's ID → **Clear data**.
Any audio already sent to AssemblyAI for a completed transcription is subject
to AssemblyAI's own retention policy, not this extension's.

## Contact

Questions about this policy or the extension: **123131rkorohan@gmail.com**.
