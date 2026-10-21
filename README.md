# malum

A Windows overlay that explains your exercise sheets. Hold a shortcut, ask "Explain exercise 1b"
or "Plot the function in 1a", let go. malum looks at the window you have open (for example a
PDF), explains it out loud, shows the key formulas, and plots functions. Ask in English or
German, it answers in the language you use.

> Work in progress. The name is a placeholder.

## Usage

- **Tap** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to open the bar and type a question.
- **Hold** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to ask by voice, release to send.
- <kbd>Esc</kbd> cancels everything.

On first use malum asks for a [Gemini API key](https://aistudio.google.com) and stores it in the
Windows Credential Manager.

**Privacy:** only the window in front is captured, never the whole screen. Screenshots and
recordings stay in memory and are never written to disk. On Gemini's free tier, Google may use
your inputs to improve its products, so only use malum with exercise material.

## Development

Requires Node.js, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri dev     # run
npm run tauri build   # build the installer
```

Built with Tauri 2, React, TypeScript, KaTeX and mathjs.
