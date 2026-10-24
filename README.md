# malum

A Windows overlay that explains your exercise sheets. Hold a shortcut, ask "Explain exercise 1b"
or "Plot the function in 1a", let go. malum looks at the window you have open (for example a
PDF), explains it out loud, shows the key formulas, and plots functions. Ask in English or
German, it answers in the language you use.

> Work in progress. The name is a placeholder.

## Usage

- **Tap** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to open the bar and type a question.
- **Hold** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to ask by voice, release to send.
- Ask follow-up questions in the same conversation, typed or spoken.
- <kbd>Esc</kbd> cancels everything: recording, request and playback.

On first use malum asks for a [Gemini API key](https://aistudio.google.com) and stores it in the
Windows Credential Manager.

## How it works

1. On key press, the window in front is captured with Win32 `PrintWindow`, scaled down and kept
   in memory. A small preview shows what will be sent, and it can be removed.
2. The question (typed, or recorded in the WebView as WebM/Opus) goes to Gemini together with the
   screenshot and the conversation so far. The request runs on the Rust side, so the API key
   never reaches the UI.
3. Gemini answers in a fixed JSON schema: a spoken explanation, short steps, LaTeX formulas and
   an optional function to plot.
4. The UI renders formulas with KaTeX, samples the function with mathjs and draws it as SVG,
   and reads the explanation aloud with Gemini TTS.

Design decisions and their reasons are logged in [docs/DESIGN.md](docs/DESIGN.md).

**Privacy:** only the window in front is captured, never the whole screen. Screenshots and
recordings are never written to disk, and no conversation is stored by Google
(`store: false`). On Gemini's free tier, Google may use inputs to improve its products, so only
use malum with exercise material.

## Tech stack

- [Tauri 2](https://tauri.app) with a Rust backend: global shortcut, tray, window capture,
  Credential Manager, HTTP requests
- React + TypeScript (strict) for the overlay UI
- [KaTeX](https://katex.org) for formulas, [mathjs](https://mathjs.org) for plotting
- Gemini API (Interactions API) for answers and text-to-speech

## Development

Requires Node.js, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev     # run
npm run tauri build   # build the installer
```

Built with the help of [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)
