import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

/** Muss zur Dauer der Ausblend-Transition in App.css passen. */
const EXIT_MS = 120;

type Phase = "in" | "out";

/** Muss zu `gemini::Answer` in Rust passen. */
type Answer = {
  spoken: string;
  steps: string[];
  formulas: string[];
  plot: { expr: string; xMin: number; xMax: number; label: string } | null;
  needsClarification: string | null;
};

/** Muss zu `gemini::AskError` in Rust passen. */
type AskError =
  | { kind: "keyMissing" | "keyInvalid" | "rateLimited" | "overloaded" | "offline" | "cancelled" }
  | { kind: "failed"; message: string };

type View =
  | { kind: "input" }
  | { kind: "key"; invalid: boolean }
  | { kind: "loading" }
  | { kind: "answer"; answer: Answer }
  | { kind: "error"; message: string };

function errorMessage(error: AskError): string {
  switch (error.kind) {
    case "rateLimited":
      return "Gratis-Limit erreicht. Warte eine Minute und versuch es dann nochmal.";
    case "overloaded":
      return "Gemini ist gerade überlastet. Versuch es gleich nochmal.";
    case "offline":
      return "Keine Verbindung zu Gemini. Ist das Internet an?";
    case "failed":
      return `Etwas ist schiefgegangen: ${error.message}`;
    default:
      return "Etwas ist schiefgegangen.";
  }
}

function App() {
  const [phase, setPhase] = useState<Phase>("out");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [view, setView] = useState<View>({ kind: "input" });
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  /** Frage, die nach dem Speichern des Keys gestellt wird. */
  const pendingQuestion = useRef<string | null>(null);

  useEffect(() => {
    const focusInput = () => {
      // Ein Frame warten, bis das Fenster wirklich sichtbar ist.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };

    const enter = () => {
      // Eine laufende Ausblend-Animation abbrechen.
      window.clearTimeout(hideTimer.current);
      setView({ kind: "input" });
      setPhase("in");
      focusInput();
    };

    const exit = () => {
      setPhase("out");
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        void invoke("hide_overlay");
      }, EXIT_MS);
    };

    const unlistenShow = listen("overlay-show", enter);
    const unlistenDismiss = listen("overlay-dismiss", exit);

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
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Fensterhöhe dem Inhalt anpassen (Rust begrenzt nach oben).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const report = () => void invoke("set_overlay_height", { height: stage.offsetHeight });
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Nach jedem Wechsel zurück zur Eingabe den Fokus ins Feld setzen.
  useEffect(() => {
    if (view.kind === "input" || view.kind === "key") inputRef.current?.focus();
  }, [view.kind]);

  async function ask(question: string) {
    setView({ kind: "loading" });
    try {
      const answer = await invoke<Answer>("ask", { question });
      setView({ kind: "answer", answer });
    } catch (e) {
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
    if (question) void ask(question);
  }

  const askingForKey = view.kind === "key";

  return (
    <main className="stage" ref={stageRef}>
      <form
        className="bar"
        data-phase={phase}
        data-error={error ? "" : undefined}
        data-busy={view.kind === "loading" ? "" : undefined}
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
            placeholder="Gemini-API-Key einfügen, dann Enter"
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
            placeholder="Frag etwas …"
            spellCheck={false}
            autoComplete="off"
          />
        )}
        {/* Nur Optik. Push-to-talk kommt als eigenes Feature. */}
        <button
          type="button"
          className="mic"
          title="Spracheingabe folgt"
          aria-label="Spracheingabe (folgt)"
          aria-disabled="true"
          tabIndex={-1}
          // Fokus im Eingabefeld lassen.
          onMouseDown={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
        </button>
        <kbd className="hint">Esc</kbd>
      </form>

      {!error && view.kind !== "input" && (
        <section className="panel" data-phase={phase} aria-live="polite">
          {view.kind === "loading" && (
            <p className="status">
              <span className="shimmer">Schaue mir das an …</span>
            </p>
          )}
          {view.kind === "key" && (
            <p className="status">
              {view.invalid
                ? "Der gespeicherte Key wird nicht akzeptiert. Füge einen gültigen Key ein."
                : "Einmalig: Füge deinen Gemini-API-Key ein. Er wird sicher in Windows gespeichert."}
            </p>
          )}
          {view.kind === "error" && (
            <p className="status status-error" role="alert">
              {view.message}
            </p>
          )}
          {view.kind === "answer" && <AnswerView answer={view.answer} />}
        </section>
      )}
    </main>
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
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {/* Vorerst roh. Schöne Darstellung mit KaTeX kommt als eigener Schritt. */}
      {answer.formulas.length > 0 && (
        <div className="formulas">
          {answer.formulas.map((formula, i) => (
            <code key={i}>{formula}</code>
          ))}
        </div>
      )}
      {answer.plot && (
        <p className="plot-note">
          Plot (folgt): {answer.plot.label} für x von {answer.plot.xMin} bis {answer.plot.xMax}
        </p>
      )}
    </div>
  );
}

export default App;
