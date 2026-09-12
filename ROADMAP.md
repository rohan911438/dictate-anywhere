# Roadmap — Dictate Anywhere, v2 pivot

## Why pivot

Everything upstream of "put the words on the page" already works and is
proven: mic capture, WAV encoding, the AssemblyAI Dictation API call, the
hotkey toggle. Every hour we've burned since has gone into one layer —
**directly writing transcribed text into the DOM of an arbitrary,
uncooperative third-party website**:

- Plain `<input>`/`<textarea>` — easy, works.
- React-controlled fields — needs the native-setter trick. Works, but fragile
  to library internals changing.
- `contenteditable` (Gmail, GitHub, Notion) — `execCommand('insertText')` and
  Range fallbacks, mostly works, some inconsistency.
- Google Docs — doesn't use real DOM text at all (canvas-rendered), needs a
  synthetic `paste` event on a phantom node that may live inside an
  `about:blank` iframe content scripts don't even reach by default. Every fix
  needs a live human to speak, click into a real Doc, and read two separate
  browser consoles (one of which is usually flooded with noise from *other*
  extensions) to verify.

This is an open-ended, per-site maintenance burden with no finish line — new
sites, new editor frameworks, new edge cases forever. It's also the one part
of the system that is nearly impossible to test without a human in the loop
speaking out loud into a live page.

**The pivot: stop trying to be smarter than every website's editor. Use the
one universal interface every app on the OS already honors correctly —
the system clipboard + a real paste.**

## The new model

1. Hotkey → speak → hotkey again (unchanged — this already works).
2. Transcript comes back from AssemblyAI (unchanged — this already works).
3. Instead of reaching into the page's DOM, the extension writes the result
   to the **system clipboard** (`navigator.clipboard.writeText`) and shows a
   small on-page confirmation pill: **"✓ Copied — press Ctrl+V"**.
4. You paste it yourself, the same way you'd paste anything else.

One extra keystroke, in exchange for deleting the entire fragile-DOM-injection
layer and every site-specific bug that comes with it. Ctrl+V is guaranteed to
work in Google Docs, Notion, a terminal, a desktop app outside the browser
entirely, a Slack message box — anything. Nothing left to special-case.

### What this removes from the codebase
- `insertIntoInput` / `insertIntoContentEditable` and all their fallbacks
- The Google-Docs-specific `ClipboardEvent('paste')` dispatch hack
- `match_about_blank` iframe-reaching workaround
- Focus-tracking / `armed` / target-element resolution logic in the content
  script (no longer need to know *which* element has focus, just that the
  page is the active tab)
- The entire class of "silently succeeded per the code, did nothing on
  screen" bugs — clipboard writes either succeed or throw, no silent no-ops

### What stays exactly as-is (already working, don't touch)
- `background.js` dictation state machine, offscreen lifecycle, AssemblyAI
  call, retry logic
- `offscreen.js` mic capture + WAV encoding
- The hotkey toggle / auto-silence-chunking behavior
- Options page, per-site rewrite overrides, API key handling

## Phased plan

### Phase 1 — Clipboard MVP (ship first)
- Content script shrinks to: listen for `dictation-insert`, call
  `navigator.clipboard.writeText(text)`, show a pill: "✓ Copied — press
  Ctrl+V" (falls back to "⚠ Could not copy" only if the Clipboard API itself
  throws, e.g. no `clipboardWrite` permission).
- Add `"clipboardWrite"` to `manifest.json` permissions.
- Delete the DOM-insertion code paths listed above.
- Re-test the 3 sites from before (Google Forms, Gmail, GitHub) plus Google
  Docs — this time "pass" just means "clipboard has the right text and the
  pill shows," which you can confirm without hunting through console noise.

### Phase 2 — Reduce the extra keystroke where it's safe to
For the *few* field types that are simple and well-behaved (plain
`<input>`/`<textarea>`, not `contenteditable`), keep a lightweight direct-
insert as a fast path, with clipboard-copy as the universal fallback for
everything else. This gets "fully hands-free" back for the common case
(search boxes, simple forms) while keeping the hard cases (Docs, Notion,
canvas editors) on the bulletproof clipboard path instead of chasing them
individually.

### Phase 3 — Optional: history + review popup
Add a small popup/side-panel showing the last few transcripts (already
copied to clipboard) so you can re-copy an older one, lightly edit before
pasting, or see what was actually transcribed if a paste got lost. This adds
a UI you *did* ask for (review before pasting) without adding any DOM-
injection risk — it only ever writes to your own extension's popup, never
someone else's page.

### Phase 4 — Optional, bigger lift: native system-wide typing
If "one extra keystroke" ever becomes the actual blocker, the real
hands-free answer is leaving the browser-extension model entirely: a small
Windows tray app that captures the hotkey globally and uses OS-level
`SendInput` to type the transcript as real keystrokes into *any* focused
app, not just browser tabs. This is how tools like Wispr Flow / Windows
Voice Access work. It's a bigger rebuild (different tech stack, no more
`chrome.*` APIs), so only worth it once Phases 1-3 prove the product is
worth using daily.

## Status

**Phase 1 is shipped** (commit `40b14d7`). `content-script.js` no longer
touches page DOM at all — it copies to the clipboard and shows a "Copied —
press Ctrl+V" pill. Confirmed working end-to-end.

Phases 2-4 are optional future work, not required for the product to be
useful today — see above for what each would add.
