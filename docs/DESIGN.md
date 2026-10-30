# malum: design notes

Working document for the project: vision, decisions and their reasons, and the rules
for working on the code. The name "malum" is a placeholder.

## Vision

A Windows overlay: hold a shortcut, say "Explain exercise 1b" or "Plot the function in
1a", let go. The app looks at the window you have open (for example a PDF exercise
sheet), explains it out loud and also shows the key formulas as LaTeX. Functions are
plotted locally. Quality over scope. It should look polished and feel smooth.

## Core flow

1. Hold the shortcut: the overlay appears, recording starts.
2. Release: the screenshot (window in front) and the audio go to the model.
3. The answer comes back as JSON (see below): text, formulas (KaTeX), optional plot.
   The spoken text is read aloud via TTS.
4. Follow-up questions in the same conversation, by voice or text. Esc closes.

## Decisions

- Platform: Windows, Tauri 2, React + TypeScript (strict), plain CSS.
- Math: KaTeX for rendering, mathjs for parsing expressions, plots drawn as SVG.
- Languages: English and German; the model detects the language itself.
- Voice input: push-to-talk. Hold = record, send on release. A short tap (under
  ~300 ms) only opens the overlay for typing. Default shortcut Ctrl+Shift+Space
  (not Alt+Space, that is the Windows system menu).
- AI provider: Gemini API on the free tier, kept replaceable behind one module.
  On the free tier Google may use inputs to improve its products, so the app is
  meant for exercise material only, never private windows.
- Voice output: the provider's TTS while it is free and good enough; a Windows
  voice is the fallback option.
- No running costs, no hosting, no local model.
- Developed with Claude Code, in git from day one.

## Answer format (model to app)

The model returns structured JSON (enforced with a JSON schema):

```json
{
  "spoken": "Here you use the product rule: first u times v prime ...",
  "steps": ["Apply the product rule", "Determine $u$ and $v$"],
  "formulas": ["f'(x) = 2x\\sin x + x^2\\cos x"],
  "plot": null,
  "needsClarification": null
}
```

Plot example: `"plot": {"expr": "x^2*sin(x)", "xMin": -5, "xMax": 5, "label": "f(x) from 1a"}`

Rules:
- `spoken` describes formulas in words, never LaTeX, or the voice reads out symbols.
- `steps` may contain short formulas in `$...$`; the app renders them with KaTeX.
- `plot.expr` must be parseable by mathjs. The app draws, the model never does.
- When unsure (which exercise? function unreadable?), the model sets
  `needsClarification` to a short follow-up question.

## Privacy and security

- Only the window in front is captured, never the whole screen.
- A small preview of the screenshot is shown before sending and can be removed.
- A visible indicator while the microphone is recording.
- Screenshots and audio are never written to disk.
- The API key lives in the Windows Credential Manager (Rust side), never in the
  frontend or the repo. `.env` (used by the API spike only) is in `.gitignore`.
- Screenshots are scaled down to at most 1600 px width before sending, which saves
  time and quota.

## Scope v1

Overlay with shortcut, push-to-talk, screenshot, explanation, formulas, plot, voice,
conversation history per session, settings (key, model, voice, shortcut).

## Later (optional)

Double-check results with a computer algebra system and flag uncertainty, help with
tables (simplex method), saved history.

## Not planned

Accounts, cloud sync, mobile, wake word (always listening), local model, plugins.

## Rules for working on the code

- First a plan (files, steps, risks), then wait for an OK, then code.
- Tauri 2, plugin and API details only from current documentation, no guessing.
- No new dependency without asking first and a short reason.
- One feature per task, small commits, commit before bigger changes.
- Keys never in code, logs or the repo.
- Every animation can be interrupted. Esc cancels everything (recording, playback, request).
- Error states are always visible: offline, key missing, quota reached, microphone blocked.
- After every change: name a three-step test that can be run by hand.

## Status

2026-10-24: core flow v1 works. Tap the shortcut to type, hold it to speak. On press, the
window in front is captured (in memory only) and shown as a removable preview. Answers come
with steps, formulas (KaTeX), plots and read-aloud; follow-ups keep the conversation context.
2026-10-27: release v0.1.0 on GitHub.
2026-10-28: settings window (tray menu > Settings…): replace or remove the key, voice with a
sample, read aloud automatically, share the window in front, start with Windows.
The shortcut can be changed there too.
2026-10-30: release v0.2.0 with the settings window and the changeable shortcut.
Open: real-world test of voice input, faster answers.

## Decision log

(date, decision, reason)

- 2026-10-14, Gemini API (free tier) as the provider, replaceable behind one module.
  Reason: the only option without running costs that accepts image and audio in one
  request. An API spike checks whether both really work on the free tier and how well
  formulas are read.
- 2026-10-14, Starting models from the pricing page (free tier): `gemini-3.8-flash` for
  answers, `gemini-3.6-flash` as the comparison. TTS: `gemini-3.8-flash-tts` (supports
  German, 30 prebuilt voices, WAV 24 kHz mono).
- 2026-10-14, Use the newer Interactions API (`v1beta/interactions`, header
  `x-goog-api-key`) instead of `generateContent`.
- 2026-10-14, Privacy: Google may use free-tier inputs to improve its products. So only
  exercise material, never private windows; a personal Google account for the key.
- 2026-10-19, Dock the overlay at the top right instead of the center, narrower bar
  (440 px). Reason: it doesn't cover the exercise sheet.
- 2026-10-19, Tray icon with menu. Left click always shows the overlay instead of toggling,
  because clicking the tray takes focus away from the overlay.
- 2026-10-19, New dependencies `tauri-plugin-autostart` ("Start with Windows", off by
  default) and `tauri-plugin-single-instance` (a second launch shows the overlay of the
  running app instead of failing on the already registered shortcut).
- 2026-10-20, NSIS installer only, no MSI. Reason: skips the WiX download, one installer
  is enough.
- 2026-10-21, No Claude API for now. Reason: no free tier (a Claude Pro subscription does
  not include API access), no audio input, no TTS. Stays a possible provider, e.g. if
  Gemini reads formulas badly.
- 2026-10-21, API spike result (without audio): the Interactions API with `response_format`
  (JSON schema) works with plain `fetch`, no SDK needed. With `gemini-3.6-flash`, exercise
  1b was solved correctly, 1a was read correctly and plotted as a mathjs expression, the
  language was detected, and `spoken` contained no LaTeX. 10 to 15 s per answer (much of
  it thinking time), TTS 8 s, good quality in German.
- 2026-10-21, `gemini-3.8-flash` was overloaded (HTTP 503) during the whole spike,
  `3.6-flash` at times. Consequence: retries, a fallback model, a visible "overloaded"
  message.
- 2026-10-21, Response time is the next risk for "smooth". To check later: streaming,
  less thinking time (`thinking_level`), showing text while TTS is generated.
- 2026-10-21, Screenshot via Win32 `PrintWindow` (crate `windows`, no screenshot library):
  `xcap`'s documentation didn't build and `keyring` was being restructured. The key in the
  Credential Manager also goes through `windows`. HTTP via `reqwest` (native-tls).
- 2026-10-21, No plot library: mathjs samples the function, a small SVG component draws
  it. One dependency less, full control over the look.
- 2026-10-21, Voice recording in the WebView (MediaRecorder, WebM/Opus), not in Rust.
  Gemini accepts `audio/webm`, and Tauri grants the microphone via `on_permission_request`.
  No new dependency.
- 2026-10-21, Stateless conversation history: the full history is sent with every question
  as `user_input`/`model_output` steps, `store: false` stays. Reason: with `store: true`
  Google would keep the conversations (1 day on the free tier).
- 2026-10-21, The model sometimes writes LaTeX with single backslashes into the JSON, so
  `\frac` arrives as a form feed plus "rac". The app turns these control characters back
  into LaTeX commands, and the prompt asks for escaped backslashes.
- 2026-10-21, Everything user-facing is in English (UI, README, prompt); questions can
  still be asked in German.
- 2026-10-24, Repository goes public as a portfolio project under the MIT license. Commit
  emails were rewritten to the GitHub noreply address beforehand.
- 2026-10-24, While the overlay is open, Esc is registered as a global shortcut and
  released on close. Reason: an answer or error keeps the overlay open after clicking
  elsewhere, and Esc then went to the other window instead of closing malum.
- 2026-10-27, First release v0.1.0 on GitHub: NSIS installer built locally, not code-signed
  (a certificate costs about 100 to 400 euros a year), so the README explains the SmartScreen
  warning. Own app icon (the orb from the overlay), its source is in docs/logo/.
- 2026-10-28, Settings as JSON in the app config folder, read and written by Rust, no store
  plugin (no new dependency). The key stays in the Credential Manager. Settings is its own
  window instead of part of the overlay, because the overlay closes when it loses focus.
  Not yet: changing the shortcut (needs a key recorder and a conflict check) and choosing the
  model (the fallback on overload already picks one).
- 2026-10-28, Changeable shortcut after all: recorded in the settings window from
  `KeyboardEvent.code`, which uses the same key names as the shortcut plugin. It needs Ctrl, Alt
  or Win (Shift alone would block typing) and must not be Esc. The current shortcut is paused
  while recording, and if Windows refuses the new one, the old one stays.
- 2026-10-28, A rejected shortcut is never silent: the reason shows right below the field and
  recording goes on. A combination another app has registered never sends a keydown, only the
  keyup, so a keyup without its keydown is reported as "already used". Losing focus (Win+D,
  Alt+Tab) stops recording with a message. Invalid keys no longer leave the old shortcut paused.
