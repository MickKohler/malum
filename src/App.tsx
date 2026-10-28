import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Formula, MathText } from "./Math";
import { Plot } from "./Plot";
import { MicError, Recorder, type Recording } from "./recorder";
import { errorMessage, type AskError } from "./errors";
import "./App.css";

/** Must match the duration of the exit transition in App.css. */
const EXIT_MS = 120;

type Phase = "in" | "out";

/** Must match `gemini::Answer` in Rust. */
type Answer = {
  spoken: string;
  steps: string[];
  formulas: string[];
  plot: { expr: string; xMin: number; xMax: number; label: string } | null;
  needsClarification: string | null;
};

type Voice = "off" | "loading" | "playing";

/** A typed question or a voice recording. */
type Question = { text: string } | { audio: Recording };

/** Status below the conversation. "input" = idle, ready for the next question. */
type View =
  | { kind: "input" }
  | { kind: "key"; invalid: boolean }
  | { kind: "loading" }
  | { kind: "error"; message: string };

/** A question and its answer. `question` is `null` for a voice question. */
type Turn = { question: string | null; answer: Answer };

function App() {
  const [phase, setPhase] = useState<Phase>("out");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [view, setView] = useState<View>({ kind: "input" });
  const [turns, setTurns] = useState<Turn[]>([]);
  /** Preview of the window that is sent with the first question. */
  const [preview, setPreview] = useState<string | null>(null);
  /** Counts how often the overlay was shown, so a late preview doesn't land in the next one. */
  const shown = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const lastTurnRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  /** Question to ask once the key has been saved. */
  const pendingQuestion = useRef<Question | null>(null);
  const recorder = useRef(new Recorder());
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const [voice, setVoice] = useState<Voice>("off");
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Incremented per question, so late speech audio is not played anymore. */
  const session = useRef(0);
  /** Setting: read every answer aloud right away. */
  const readAloud = useRef(true);
  const [shortcutLabel, setShortcutLabel] = useState("Ctrl+Shift+Space");

  useEffect(() => {
    const focusInput = () => {
      // Wait one frame until the window is actually visible.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };

    const enter = () => {
      // Cancel a running exit animation.
      window.clearTimeout(hideTimer.current);
      stopVoice();
      setView({ kind: "input" });
      setTurns([]);
      loadSettings();
      loadPreview();
      setPhase("in");
      focusInput();
    };

    const exit = () => {
      stopVoice();
      stopListening();
      setPhase("out");
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        void invoke("hide_overlay");
      }, EXIT_MS);
    };

    const unlistenShow = listen("overlay-show", enter);
    const unlistenDismiss = listen("overlay-dismiss", exit);
    const unlistenPttStart = listen("ptt-start", startListening);
    const unlistenPttEnd = listen<boolean>("ptt-end", (e) => void endListening(e.payload));

    invoke<string | null>("startup_error").then((message) => {
      if (message) {
        setError(message);
        enter();
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void invoke("request_dismiss");
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(hideTimer.current);
      void unlistenShow.then((off) => off());
      void unlistenDismiss.then((off) => off());
      void unlistenPttStart.then((off) => off());
      void unlistenPttEnd.then((off) => off());
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Fit the window height to the content (Rust caps it).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const report = () => void invoke("set_overlay_height", { height: stage.offsetHeight });
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // While an answer or message is visible, clicking elsewhere doesn't close the overlay.
  const sticky = turns.length > 0 || view.kind === "error";
  useEffect(() => {
    void invoke("set_sticky", { sticky });
  }, [sticky]);

  // Show a new answer from its start, keep status lines at the bottom in view.
  useEffect(() => {
    if (view.kind === "input" && !listening) {
      lastTurnRef.current?.scrollIntoView({ block: "start" });
    } else {
      panelRef.current?.scrollTo({ top: panelRef.current.scrollHeight });
    }
  }, [turns.length, view.kind, listening]);

  // Focus the field whenever we return to input.
  useEffect(() => {
    if (view.kind === "input" || view.kind === "key") inputRef.current?.focus();
  }, [view.kind]);

  function loadSettings() {
    invoke<{ settings: { readAloud: boolean }; shortcutLabel: string }>("get_settings")
      .then((view) => {
        readAloud.current = view.settings.readAloud;
        setShortcutLabel(view.shortcutLabel);
      })
      .catch((e) => console.error("Could not load the settings", e));
  }

  function loadPreview() {
    const id = ++shown.current;
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    invoke<ArrayBuffer>("screenshot_preview").then((png) => {
      if (id !== shown.current || png.byteLength === 0) return;
      setPreview(URL.createObjectURL(new Blob([png], { type: "image/png" })));
    });
  }

  function removePreview() {
    void invoke("discard_screenshot");
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  }

  function setListeningBoth(value: boolean) {
    listeningRef.current = value;
    setListening(value);
  }

  function startListening() {
    stopVoice();
    setListeningBoth(true);
    recorder.current.start().catch((e) => {
      // Only report it if we are still listening (not after a short tap).
      if (!listeningRef.current) return;
      setListeningBoth(false);
      setView({ kind: "error", message: e instanceof MicError ? e.message : String(e) });
    });
  }

  function stopListening() {
    recorder.current.cancel();
    setListeningBoth(false);
  }

  /** `send`: the shortcut was held, so send the recording. Otherwise discard it. */
  async function endListening(send: boolean) {
    if (!listeningRef.current) return;
    if (!send) {
      stopListening();
      inputRef.current?.focus();
      return;
    }
    setListeningBoth(false);
    const recording = await recorder.current.stop();
    if (recording) void ask({ audio: recording });
    else setView({ kind: "error", message: "Nothing was recorded." });
  }

  function stopVoice() {
    session.current++;
    if (audio.current) {
      audio.current.pause();
      URL.revokeObjectURL(audio.current.src);
      audio.current = null;
    }
    setVoice("off");
  }

  async function speak(text: string) {
    stopVoice();
    const id = session.current;
    setVoice("loading");
    try {
      const wav = await invoke<ArrayBuffer>("speak", { text });
      if (id !== session.current) return;
      const player = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
      player.onended = () => {
        if (audio.current === player) stopVoice();
      };
      audio.current = player;
      setVoice("playing");
      await player.play();
    } catch (e) {
      if (id !== session.current) return;
      // Reading aloud is optional: log quietly, the answer stays visible.
      console.error("Read-aloud failed", e);
      setVoice("off");
    }
  }

  async function ask(question: Question) {
    stopVoice();
    const id = session.current;
    setView({ kind: "loading" });
    try {
      const answer = await invoke<Answer>(
        "ask",
        "text" in question
          ? { question: question.text, audio: null, audioMime: null }
          : { question: null, audio: Array.from(question.audio.bytes), audioMime: question.audio.mime },
      );
      if (id !== session.current) return;
      setTurns((prev) => [...prev, { question: "text" in question ? question.text : null, answer }]);
      setView({ kind: "input" });
      if ("text" in question) setText("");
      if (readAloud.current) void speak(answer.needsClarification ?? answer.spoken);
    } catch (e) {
      if (id !== session.current) return;
      const err = e as AskError;
      if (err.kind === "cancelled") return;
      if (err.kind === "keyMissing" || err.kind === "keyInvalid") {
        pendingQuestion.current = question;
        setKeyText("");
        setView({ kind: "key", invalid: err.kind === "keyInvalid" });
        return;
      }
      setView({ kind: "error", message: errorMessage(err) });
    }
  }

  async function saveKey() {
    try {
      await invoke("save_api_key", { key: keyText });
    } catch (e) {
      setView({ kind: "error", message: String(e) });
      return;
    }
    setKeyText("");
    const question = pendingQuestion.current;
    pendingQuestion.current = null;
    if (question) void ask(question);
    else setView({ kind: "input" });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (view.kind === "loading") return;
    if (view.kind === "key") {
      if (keyText.trim()) void saveKey();
      return;
    }
    const question = text.trim();
    if (question) void ask({ text: question });
  }

  function toggleVoice() {
    const answer = turns[turns.length - 1]?.answer;
    if (!answer) return;
    if (voice === "off") void speak(answer.needsClarification ?? answer.spoken);
    else stopVoice();
  }

  const askingForKey = view.kind === "key";

  return (
    <main className="stage" ref={stageRef}>
      <form
        className="bar"
        data-phase={phase}
        data-error={error ? "" : undefined}
        data-busy={view.kind === "loading" ? "" : undefined}
        data-listening={listening ? "" : undefined}
        onSubmit={onSubmit}
      >
        <span className="orb" aria-hidden="true" />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : askingForKey ? (
          <input
            ref={inputRef}
            key="key"
            className="prompt"
            type="password"
            value={keyText}
            onChange={(e) => setKeyText(e.currentTarget.value)}
            placeholder="Paste your Gemini API key, then press Enter"
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <input
            ref={inputRef}
            key="question"
            className="prompt"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Ask anything …"
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <button
          type="button"
          className="mic"
          title={`Speak: hold ${shortcutLabel} (or click here)`}
          aria-label={listening ? "Send recording" : "Start recording"}
          aria-pressed={listening}
          tabIndex={-1}
          // Keep focus in the input field.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (listening ? void endListening(true) : startListening())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
        </button>
        <button
          type="button"
          className="hint"
          title="Close (Esc)"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void invoke("request_dismiss")}
        >
          Esc
        </button>
      </form>

      {!error && (preview || listening || turns.length > 0 || view.kind !== "input") && (
        <section
          ref={panelRef}
          className="panel"
          data-phase={phase}
          // Only listening, nothing else: show after the tap threshold.
          data-listening-only={
            listening && !preview && turns.length === 0 && view.kind === "input" ? "" : undefined
          }
          aria-live="polite"
        >
          {preview && (
            <div className="shot">
              <img src={preview} alt="Screenshot of the window" />
              <span>{turns.length === 0 ? "This window will be sent with your question" : "Shared window"}</span>
              {turns.length === 0 && (
                <button
                  type="button"
                  className="shot-remove"
                  title="Don't send this window"
                  aria-label="Don't send this window"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={removePreview}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7l10 10M17 7L7 17" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {turns.map((turn, i) => {
            const latest = i === turns.length - 1;
            return (
              <article key={i} className="turn" ref={latest ? lastTurnRef : undefined}>
                {latest && <VoiceButton voice={voice} onToggle={toggleVoice} />}
                <p className="question" data-voice={turn.question === null ? "" : undefined}>
                  {turn.question ?? "Voice question"}
                </p>
                <AnswerView answer={turn.answer} />
              </article>
            );
          })}
          {listening ? (
            <p className="status listening">
              <span className="rec-dot" aria-hidden="true" />
              Listening … release to send
            </p>
          ) : (
            <StatusView view={view} />
          )}
        </section>
      )}
    </main>
  );
}

function StatusView({ view }: { view: View }) {
  switch (view.kind) {
    case "loading":
      return (
        <p className="status">
          <span className="shimmer">Taking a look …</span>
        </p>
      );
    case "key":
      return (
        <p className="status">
          {view.invalid
            ? "The saved key was rejected. Paste a valid key."
            : "One-time setup: paste your Gemini API key. It is stored securely in Windows."}{" "}
          <button
            type="button"
            className="link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void invoke("open_settings")}
          >
            Open settings
          </button>
        </p>
      );
    case "error":
      return (
        <p className="status status-error" role="alert">
          {view.message}
        </p>
      );
    default:
      return null;
  }
}

function VoiceButton({ voice, onToggle }: { voice: Voice; onToggle: () => void }) {
  const label = voice === "off" ? "Read aloud" : "Stop reading";
  return (
    <button
      type="button"
      className="voice"
      data-voice={voice}
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" />
        {voice === "off" ? (
          <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
        ) : (
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        )}
      </svg>
    </button>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  if (answer.needsClarification) {
    return <p className="clarify">{answer.needsClarification}</p>;
  }
  return (
    <div className="answer">
      <p className="spoken">{answer.spoken}</p>
      {answer.steps.length > 0 && (
        <ol className="steps">
          {answer.steps.map((step, i) => (
            <li key={i}>
              <MathText text={step} />
            </li>
          ))}
        </ol>
      )}
      {answer.formulas.length > 0 && (
        <div className="formulas">
          {answer.formulas.map((formula, i) => (
            <Formula key={i} tex={formula} />
          ))}
        </div>
      )}
      {answer.plot && <Plot {...answer.plot} />}
    </div>
  );
}

export default App;
