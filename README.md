<div align="center">

# malum

**A Windows overlay that explains your exercise sheets.**

Hold a shortcut, ask "Explain exercise 1b" or "Plot the function in 2a", let go.<br>
malum looks at the window you have open, explains it out loud, shows the key formulas and plots functions.

[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#development)
[![Built with Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-DEA584?logo=rust&logoColor=white)](src-tauri/src)
[![React + TypeScript](https://img.shields.io/badge/React-TypeScript-3178C6?logo=typescript&logoColor=white)](src)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

<br>

<img src="docs/media/plot.png" alt="malum next to an exercise sheet, showing the solution steps, key formulas and a plot of the function" width="820">

</div>

> Work in progress. The name is a placeholder.

## Features

- **Push-to-talk or type.** Tap <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to type, hold it to ask by voice.
- **Sees what you see.** The window in front is captured on key press, with a preview you can remove before sending.
- **Explains out loud.** A spoken explanation plus short steps, read aloud with natural text-to-speech.
- **Real math.** Formulas are typeset with KaTeX, functions are plotted right in the answer.
- **Follow-up questions.** Ask "why?" and malum keeps the context of the conversation.
- **English or German.** It answers in the language you ask in.
- **Private by design.** Nothing is written to disk, and the API key stays in the Windows Credential Manager.

| Before asking: the window that will be shared | The spoken explanation, with steps below |
|:---:|:---:|
| <img src="docs/media/preview.png" alt="The overlay with a preview of the captured window and a button to remove it" width="400"> | <img src="docs/media/explain.png" alt="The overlay explaining how to find the coefficients of the polynomial" width="400"> |

<sub>Exercise in the screenshots: "Graph Features" from
[MIT OpenCourseWare 18.01SC Single Variable Calculus](https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/),
Fall 2010, licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).</sub>

## How it works

```mermaid
sequenceDiagram
    actor You
    participant UI as Overlay UI<br/>(React + TypeScript)
    participant Rust as Tauri backend<br/>(Rust)
    participant Win as Windows
    participant Gemini as Gemini API

    You->>Rust: hold Ctrl+Shift+Space
    Rust->>Win: capture window in front (PrintWindow)
    Rust->>UI: show overlay, start recording
    UI->>UI: record voice (MediaRecorder, WebM/Opus)
    You->>Rust: release shortcut
    UI->>Rust: ask(question or audio)
    Rust->>Win: read API key (Credential Manager)
    Rust->>Gemini: question + screenshot + conversation so far
    Gemini-->>Rust: JSON answer (spoken text, steps, LaTeX, plot)
    Rust-->>UI: answer
    UI->>UI: render KaTeX, sample with mathjs, draw SVG plot
    UI->>Rust: speak(text)
    Rust->>Gemini: text-to-speech
    Gemini-->>UI: WAV audio, played back
```

A few details worth knowing:

- **The API key never reaches the UI.** All requests run on the Rust side.
- **Stateless conversations.** The full history is sent with each question and Google stores
  nothing (`store: false`); the screenshot goes with the first question only.
- **Robust against overload.** When a model is busy (HTTP 503), malum falls back to the next one.
- **Every step can be interrupted.** <kbd>Esc</kbd> cancels recording, the request and playback.

Design decisions and their reasons are logged in [docs/DESIGN.md](docs/DESIGN.md).

## Getting started

On first use, malum asks for a free [Gemini API key](https://aistudio.google.com) and stores it in
the Windows Credential Manager.

**Privacy note:** only the window in front is captured, never the whole screen. On Gemini's free
tier, Google may use inputs to improve its products, so only use malum with exercise material.

## Development

Requires Node.js, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev     # run
npm run tauri build   # build the installer
```

To try it without your own material, open [`docs/demo/sheet.html`](docs/demo/sheet.html) in a
browser and ask about it.

```
src/              overlay UI (React): answer view, KaTeX, plots, voice recording
src-tauri/src/    backend (Rust): shortcut, tray, window capture, key storage, Gemini client
spikes/api/       standalone script used to validate the Gemini API before building the app
docs/             design notes, screenshots and the demo exercise sheet
```

Built with the help of [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)
